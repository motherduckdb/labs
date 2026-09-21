"""Compile-time strategy for dbt Charts variables in a Dive.

dbt Charts renders board SQL with Python Jinja on every request; a Dive has no Jinja
and no server, so every SQL text a control can lead to has to exist before the Dive is
published. This module decides, per board query, how the browser gets from the current
variable values to a SQL string, using dbt-charts' own resolvers throughout
(``resolve_controls`` for what each control *is*, ``render_parameterized`` with the
``filter()`` helpers for what the SQL *renders to*, ``_to_sql_literal`` for quoting).

Each variable a query depends on (``query.variable_dependencies``) becomes one
*dimension* of a variant table:

  select / radio      one member per option value (+ the unset member ``""`` when the
                      control can be cleared) — rendered with the real value, so Jinja
                      that branches on it (``region if region != 'All' else None``) is
                      simply rendered per branch;
  checkbox            ``true`` / ``false``;
  multiselect         one member per selection *count* 0..n — ``filter()`` emits one
                      placeholder per selected member, so the SQL shape depends on how
                      many are picked, never on which;
  free inputs         ``set`` / ``unset`` (text, number, slider, range, date,
  (typed probes)      datepicker, daterange) — rendered with a typed *probe* value that
                      leaves a slot token in the SQL; the browser inlines the live value
                      with dbt-charts' literal spelling (``'…'`` with ``''`` escaping,
                      numbers raw, ``DATE '…'``, ``TRUE``/``FALSE``, ``NULL``).

Every variant is rendered twice with two different probe values; a variant whose two
renders disagree has Jinja that branches on a free value (``{% if n > 100 %}``, ``| upper``)
and cannot be inlined — the whole query then falls back to its default SQL with a note
the Dive shows next to the controls. The cartesian product of the dimensions is capped at
``VARIANT_CAP``; past it the query also falls back with a note.

``enabled`` on a variable and ``visible`` on a layout item are Jinja conditions over the
same variables; they are pre-evaluated into the same kind of table (``compile_condition``)
so the browser only looks values up. A ``{query, column}`` probe condition is evaluated
once, with the defaults.
"""

from __future__ import annotations

import datetime as _dt
import itertools
import math as _math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal as _Decimal
from typing import Any

VARIANT_CAP = 64

FREE_INPUTS = frozenset({"text", "input", "textarea", "number", "slider", "range", "date", "datepicker", "daterange"})
_NUMBER_INPUTS = frozenset({"number", "slider", "range"})
_DATE_INPUTS = frozenset({"date", "datepicker"})

_RAW_TOKEN = re.compile(r"__DCD_RAW_([A-Za-z_][A-Za-z0-9_]*)_(\d+)__")
# Jinja tests that ask whether a variable is there, or what type it is — never what it says.
_PRESENCE_TESTS = frozenset({"defined", "undefined", "none", "boolean", "string", "number", "integer", "float", "sequence", "mapping", "iterable"})


# ─────────────────────────────────────────────────────────────────────────────
# typed probes — values that render as slot tokens but keep their Python type
# ─────────────────────────────────────────────────────────────────────────────
class _Probe:
    """Mixin: a stand-in for a live value. ``str()`` yields a raw slot token (what
    ``{{ var }}`` interpolation leaves in the SQL); handed to ``filter()`` it is
    collected as a parameter and becomes a literal slot instead."""

    var: str
    member: int
    sql_type: str

    def raw_token(self) -> str:
        return f"__DCD_RAW_{self.var}_{self.member}__"

    def slot_token(self) -> str:
        return f"__DCD_SLOT_{self.var}_{self.member}__"

    def __str__(self) -> str:
        return self.raw_token()

    def __repr__(self) -> str:
        return self.raw_token()

    def __format__(self, spec: str) -> str:
        return self.raw_token()


class _ProbeStr(_Probe, str):
    sql_type = "string"

    def __new__(cls, value: str, var: str, member: int) -> _ProbeStr:
        self = super().__new__(cls, value)
        self.var, self.member = var, member
        return self


class _ProbeFloat(_Probe, float):
    sql_type = "number"

    def __new__(cls, value: float, var: str, member: int) -> _ProbeFloat:
        self = super().__new__(cls, value)
        self.var, self.member = var, member
        return self


class _ProbeInt(_Probe, int):
    sql_type = "number"

    def __new__(cls, value: int, var: str, member: int) -> _ProbeInt:
        self = super().__new__(cls, value)
        self.var, self.member = var, member
        return self


class _ProbeDate(_Probe, _dt.date):
    sql_type = "date"

    def __new__(cls, value: _dt.date, var: str, member: int) -> _ProbeDate:
        self = super().__new__(cls, value.year, value.month, value.day)
        self.var, self.member = var, member
        return self


def _probe(sql_type: str, sample: Any, var: str, member: int, alt: bool) -> Any:
    """A typed probe of ``sql_type`` near ``sample`` (the default); ``alt`` picks the
    second, distinct value the branch check renders with."""
    if sql_type == "number":
        if isinstance(sample, int) and not isinstance(sample, bool):
            return _ProbeInt(sample + (7919 if alt else 0), var, member)
        base = float(sample) if isinstance(sample, (int, float)) and not isinstance(sample, bool) else 1.0
        return _ProbeFloat(base + (7919.5 if alt else 0.0), var, member)
    if sql_type == "date":
        base = sample if isinstance(sample, _dt.date) and not isinstance(sample, _dt.datetime) else _dt.date(2024, 1, 1)
        return _ProbeDate(base + _dt.timedelta(days=37 if alt else 0), var, member)
    return _ProbeStr(f"dcdprobe{'B' if alt else 'A'}{member}", var, member)


# ─────────────────────────────────────────────────────────────────────────────
# dimensions
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class Member:
    key: str
    value: Any  # the value rendered (probe A for a free var)
    alt: Any = None  # probe B, when the member is probe-based
    probed: bool = False


@dataclass
class Dimension:
    name: str  # board variable name
    key: str  # Dive state key (prefixed)
    kind: str  # "value" | "checkbox" | "count" | "set"
    members: list[Member] = field(default_factory=list)


def member_sql_type(var_def: Any, input_type: str) -> str:
    """The SQL literal type of one value of this variable (dbt-charts' own typing)."""
    from dbt_charts.core.compile.template.variables import choice_member_type

    if input_type in _NUMBER_INPUTS:
        return "number"
    if input_type in _DATE_INPUTS or input_type == "daterange":
        return "date"
    if input_type == "checkbox":
        return "bool"
    return choice_member_type(var_def) or "string"


def dimension_for(control: Any, key: str) -> Dimension | None:
    """The variant dimension of one resolved control (``variables_resolve.ResolvedControl``)."""
    from dbt_charts.core.compile.template.variables import _coerce_member, choice_member_type

    var, t, name = control.var_def, control.input, control.name
    if t in ("select", "radio"):
        mtype = choice_member_type(var)
        members = [Member(opt, _coerce_member(name, opt, mtype)) for opt in control.option_values]
        if control.can_unset or not members:
            members.append(Member("", None))
        return Dimension(name, key, "value", members)
    if t == "checkbox":
        return Dimension(name, key, "checkbox", [Member("true", True), Member("false", False)])
    if t == "multiselect":
        mtype = member_sql_type(var, t)
        sample = 1 if mtype == "number" else None
        n = len(control.option_values)
        members = []
        for k in range(0 if control.can_unset else 1, n + 1):
            a = [_probe(mtype, sample, name, i, False) for i in range(k)]
            b = [_probe(mtype, sample, name, i, True) for i in range(k)]
            members.append(Member(str(k), a, b, probed=True))
        return Dimension(name, key, "count", members)
    if t in FREE_INPUTS:
        mtype = member_sql_type(var, t)
        current = control.current
        if t == "daterange":
            s0 = current[0] if isinstance(current, (list, tuple)) and len(current) == 2 else None
            a = [_probe("date", s0, name, 0, False), _probe("date", s0, name, 1, False)]
            b = [_probe("date", s0, name, 0, True), _probe("date", s0, name, 1, True)]
        else:
            a, b = _probe(mtype, current, name, 0, False), _probe(mtype, current, name, 0, True)
        members = [Member("set", a, b, probed=True)]
        if not var.required and t not in ("slider", "range"):  # a slider always holds a position
            members.append(Member("unset", None))
        return Dimension(name, key, "set", members)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# rendering one variant
# ─────────────────────────────────────────────────────────────────────────────
class Unsupported(Exception):
    """A Jinja shape the browser cannot reproduce; the query keeps its default SQL."""


def render_variant(template_sql: str, values: dict[str, Any], warehouse: Any, strict: bool) -> tuple[str, dict[str, dict[str, Any]]]:
    """dbt-charts' execution render (``adapter_registry._compose_query_refs``) with probe
    values replaced by slot tokens. Returns the SQL and its slots ``{token: slot}``.

    Every value dbt-charts binds as a parameter — a ``{{ var }}`` interpolation as much as
    a ``filter()`` argument — becomes one slot, so the Dive can only put a value where dbt
    Charts puts one, spelled as the same literal.
    """
    from dbt_charts.core.compile.template.parameterized import render_parameterized
    from dbt_charts.core.execute.sql_literals import INLINE_PLACEHOLDERS, _to_sql_literal

    q = render_parameterized(template_sql, values, dialect=INLINE_PLACEHOLDERS, strict=strict, warehouse=warehouse)
    rendered, slots = q.sql, {}
    for i, p in enumerate(q.params, 1):
        if isinstance(p, _Probe):
            lit = p.slot_token()
            slots[lit] = {"token": lit, "var": p.var, "member": p.member, "type": p.sql_type}
        elif isinstance(p, (list, tuple)) and any(isinstance(x, _Probe) for x in p):
            raise Unsupported("a variable bound as a whole list")  # dct spells it; we cannot slot it
        else:
            lit = _to_sql_literal(p, warehouse)
        rendered = rendered.replace(INLINE_PLACEHOLDERS.param(i), lit)
    if "\x00" in rendered:
        raise Unsupported("a parameter placeholder survived rendering")
    # A probe that escaped its parameter wrapper: a loop over a multiselect, say. dbt-charts
    # interpolates those raw; the Dive still slots them, so the value cannot reach SQL as
    # anything but a literal.
    types = {(x.var, x.member): x.sql_type for v in values.values() for x in (v if isinstance(v, (list, tuple)) else [v]) if isinstance(x, _Probe)}
    for m in _RAW_TOKEN.finditer(rendered):
        var, member = m.group(1), int(m.group(2))
        slots.setdefault(m.group(0), {"token": m.group(0), "var": var, "member": member, "type": types.get((var, member), "string")})
    for token in slots:
        if not _in_value_position(rendered, token):
            raise Unsupported("a variable is interpolated inside a string literal, an identifier or a comment")
    return rendered, slots


def value_dependent_vars(template_sql: str, names: set[str]) -> set[str]:
    """Which of ``names`` the template's *structure* reads the value of.

    A free input is sampled, not enumerated: the variant table holds one SQL per control, so
    a template that renders differently for one particular value cannot be reproduced from
    two sample renders — ``{% if n == 5 %}`` looks the same at 2 and at 7921. The template
    says plainly which variables it tests, so ask it. Presence and type are not value tests:
    a free input is dimensioned set/unset, both are rendered, and a probe has the type the
    real value has.
    """
    from jinja2 import Environment, nodes

    flagged: set[str] = set()

    def scan(node: Any, bare: bool) -> None:
        if isinstance(node, nodes.Name):
            if not bare and node.name in names:
                flagged.add(node.name)
            return
        structural = isinstance(node, (nodes.Not, nodes.And, nodes.Or)) or (isinstance(node, nodes.Test) and node.name in _PRESENCE_TESTS)
        inner = bare and structural
        for child in node.iter_child_nodes():
            scan(child, inner)

    try:
        ast = Environment().parse(template_sql)
    except Exception:  # noqa: BLE001 — an unparseable template is dct's problem, not ours
        return flagged
    for test in (n.test for n in ast.find_all((nodes.If, nodes.CondExpr))):
        scan(test, True)
    return flagged


# What opens each thing a value cannot be inside, and what closes it again.
_OPENS = (("'", "string"), ('"', "identifier"), ("--", "line comment"), ("/*", "block comment"))
_CLOSES = {"string": "'", "identifier": '"', "line comment": "\n", "block comment": "*/"}


def _in_value_position(sql: str, token: str) -> bool:
    """Whether every occurrence of ``token`` stands where a value stands.

    A slot inside a string literal is not a value: the escaped quotes of whatever the viewer
    types re-balance the author's own, and the rest of the value is code. Inside an
    identifier or a comment it is not a value either.
    """
    state, i, ok = "code", 0, True
    while i < len(sql):
        if state == "code":
            if sql.startswith(token, i):
                i += len(token)
                continue
            state = next((opened for mark, opened in _OPENS if sql.startswith(mark, i)), "code")
        elif sql.startswith(_CLOSES[state], i):
            state = "code"
        if state != "code" and sql.startswith(token, i):
            ok = False
        i += 1
    return ok


def compile_query_variants(
    template_sql: str,
    deps: list[str],
    dims_by_var: dict[str, Dimension],
    defaults: dict[str, Any],
    warehouse: Any,
    strict: bool,
    finish: Callable[[str], str],
) -> dict[str, Any] | None:
    """The variant table of one query, or None when no control feeds it.

    ``finish`` post-processes each rendered SQL the way the default SQL is (table
    qualification, column casts); slot tokens are protected through it.
    """
    dims = [dims_by_var[d] for d in dims_by_var if d in deps]
    if not dims:
        return None
    out: dict[str, Any] = {"deps": [d.key for d in dims], "dims": [{"key": d.key, "kind": d.kind} for d in dims]}
    size = 1
    for d in dims:
        size *= len(d.members)
    if size > VARIANT_CAP:
        out["note"] = f"{size} value combinations of {', '.join(d.name for d in dims)} exceed the {VARIANT_CAP}-variant cap; the query runs with the board defaults"
        return out
    risky = value_dependent_vars(template_sql, {d.name for d in dims if d.kind == "set"})
    if risky:
        out["note"] = f"the SQL branches on the value of {', '.join(sorted(risky))}"
        return out
    variants: dict[str, Any] = {}
    for combo in itertools.product(*(d.members for d in dims)):
        vals = dict(defaults)
        alt = dict(defaults)
        probed = False
        for d, m in zip(dims, combo, strict=True):
            vals[d.name] = m.value
            alt[d.name] = m.alt if m.probed else m.value
            probed = probed or m.probed
        key = "|".join(m.key for m in combo)
        try:
            sql, slots = render_variant(template_sql, vals, warehouse, strict)
            if probed:
                sql_b, _ = render_variant(template_sql, alt, warehouse, strict)
                if sql_b != sql:
                    # name the culprits: re-render with one probe swapped at a time
                    culprits = []
                    for d, m in zip(dims, combo, strict=True):
                        if m.probed:
                            one = dict(vals)
                            one[d.name] = m.alt
                            if render_variant(template_sql, one, warehouse, strict)[0] != sql:
                                culprits.append(d.name)
                    raise Unsupported(f"the SQL branches on the value of {', '.join(culprits) or 'a free input'}")
            for s in slots.values():
                s["key"] = next(d.key for d in dims if d.name == s["var"])  # Dive state key
            variants[key] = {"sql": _finish_protected(sql, slots, finish), "slots": list(slots.values())}
        except Exception as e:  # noqa: BLE001 — one unsupported shape: the query keeps its default SQL
            out["note"] = str(e)
            return out
    out["variants"] = variants
    return out


# ─────────────────────────────────────────────────────────────────────────────
# the Dive's own resolution, in Python — template.tsx's dimKey / literal / sqlFor
# ─────────────────────────────────────────────────────────────────────────────
def is_unset(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, (list, tuple)) and (not v or any(x is None or x == "" for x in v)))


def dim_key(dim: dict[str, Any], v: Any) -> str:
    """One value's coordinate in a variant table."""
    kind = dim["kind"]
    if kind == "checkbox":
        return "true" if v else "false"
    if kind == "count":
        return str(len(v)) if isinstance(v, (list, tuple)) else ("0" if is_unset(v) else "1")
    if kind == "set":
        return "unset" if is_unset(v) else "set"
    return "" if is_unset(v) else str(v)


def _js_number(v: Any) -> str:
    """JavaScript's ``String(Number(v))``, which is what the Dive writes: fixed notation
    between 1e-7 and 1e21, the shortest round-tripping digits, and no padded exponent."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return "NaN"
    if not _math.isfinite(f):
        return "Infinity" if f > 0 else ("-Infinity" if f < 0 else "NaN")
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    d = _Decimal(repr(f))  # repr gives the shortest digits that round-trip, as JS does
    if -7 < d.adjusted() < 21:
        return format(d, "f")
    return re.sub(r"e([+-])0*(\d)", r"e\1\2", repr(f))


def sql_literal(v: Any, slot: dict[str, Any]) -> str:
    """dbt-charts' ``_to_sql_literal`` for the value a slot stands for. A slot is the only
    place a value enters the statement, and it always enters as a literal of the slot's own
    type — whatever the viewer put in the control or the URL."""
    if isinstance(v, (list, tuple)):
        v = v[slot["member"]] if slot["member"] < len(v) else None
    if v is None or v == "":
        return "NULL"
    if slot["type"] == "number":
        n = _js_number(v)
        return n if n not in ("NaN", "Infinity", "-Infinity") else "NULL"
    if slot["type"] == "bool":
        return "TRUE" if v is True or v == "true" else "FALSE"
    if slot["type"] == "date":
        d = str(v)[:10]
        return f"DATE '{d}'" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) else "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def variant_sql(qv: dict[str, Any] | None, default_sql: str, values: dict[str, Any]) -> str:
    """The SQL the Dive runs for ``values`` (keyed by Dive state key): the variant for that
    combination with its slots filled, or the query's default text."""
    if not qv or not qv.get("variants"):
        return default_sql
    v = qv["variants"].get("|".join(dim_key(d, values.get(d["key"])) for d in qv["dims"]))
    if v is None:
        return default_sql
    sql = v["sql"]
    for s in v["slots"]:
        sql = sql.replace(s["token"], sql_literal(values.get(s["key"]), s))
    return sql


def _finish_protected(sql: str, slots: dict[str, dict[str, Any]], finish: Callable[[str], str]) -> str:
    """Run ``finish`` (which may parse the SQL) with slot tokens swapped for unique numeric
    literals, which parse anywhere a value can stand, then swap them back.

    The stand-ins are chosen so they do not already occur in the query: swapping back is a
    text replace, and a number the board itself wrote would become a slot the viewer fills.
    """
    if not slots:
        return finish(sql)
    base = 987654301
    while any(str(base + i) in sql for i in range(len(slots))):
        base += len(slots) or 1
    stand_ins = {tok: str(base + i) for i, tok in enumerate(slots)}
    for tok, num in stand_ins.items():
        sql = sql.replace(tok, num)
    sql = finish(sql)
    for tok, num in stand_ins.items():
        sql = sql.replace(num, tok)
    return sql


# ─────────────────────────────────────────────────────────────────────────────
# conditions (variable ``enabled``, layout item ``visible``)
# ─────────────────────────────────────────────────────────────────────────────
def compile_condition(expr: Any, if_none: bool, dims_by_var: dict[str, Dimension], defaults: dict[str, Any], executor: Any, context: str) -> bool | dict[str, Any]:
    """A bool when the condition is constant, else ``{dims, table, default}`` over the
    variables it reads (Jinja truthiness of the live values; free inputs as set/unset)."""
    from dbt_charts.core.compile.template.jinja import extract_variable_dependencies
    from dbt_charts.core.render.conditions import eval_bool_condition

    if expr is None:
        return if_none
    if isinstance(expr, bool):
        return expr

    def evaluate(values: dict[str, Any], exe: Any) -> bool:
        return eval_bool_condition(expr, if_none, values, exe, context)

    try:
        default = evaluate(defaults, executor)
    except Exception:  # noqa: BLE001 — an unevaluable condition keeps its "missing" meaning
        default = if_none
    if not isinstance(expr, str):
        return default  # a {query, column} probe: one answer, with the defaults
    jinja_expr = expr if "{{" in expr else f"{{{{ {expr} }}}}"
    deps = [d for d in dims_by_var if d in extract_variable_dependencies(jinja_expr)]
    dims = [dims_by_var[d] for d in deps]
    if not dims:
        return default
    size = 1
    for d in dims:
        size *= len(d.members)
    if size > VARIANT_CAP:
        return default
    table: dict[str, bool] = {}
    for combo in itertools.product(*(d.members for d in dims)):
        vals = dict(defaults)
        for d, m in zip(dims, combo, strict=True):
            vals[d.name] = m.value
        try:
            table["|".join(m.key for m in combo)] = evaluate(vals, None)
        except Exception:  # noqa: BLE001 — that combination keeps the default answer
            table["|".join(m.key for m in combo)] = default
    return {"dims": [{"key": d.key, "kind": d.kind} for d in dims], "table": table, "default": default}


# ─────────────────────────────────────────────────────────────────────────────
# controls — what the Dive draws, from dct's own resolved controls
# ─────────────────────────────────────────────────────────────────────────────
def json_value(v: Any) -> Any:
    if isinstance(v, _dt.datetime):
        return v.date().isoformat()
    if isinstance(v, _dt.date):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [json_value(x) for x in v]
    return v


def control_spec(control: Any, key: str) -> dict[str, Any]:
    """One control as the template renders it (``variables_resolve.ResolvedControl``)."""
    from dbt_charts.core.render.variables_resolve import (
        UNSET_DATE_LABEL,
        UNSET_DATERANGE_LABEL,
        UNSET_SELECT_LABEL,
        read_only_unset_label,
    )

    var, t = control.var_def, control.input
    current = control.current
    if t in ("select", "radio"):
        # The browser holds the option *string*; a typed default is mapped onto it.
        default = None if current is None or current == "" else next((o for o in control.option_values if o == str(current) or _same(o, current)), str(current))
    elif t == "multiselect":
        default = [str(m) for m in (current or [])]
    elif t == "daterange":
        default = json_value(list(current)) if isinstance(current, (list, tuple)) and len(current) == 2 and all(current) else None
    elif t == "checkbox":
        default = bool(control.checked)
    else:
        default = json_value(current) if current not in (None, "") else None
    unset_default = UNSET_DATERANGE_LABEL if t == "daterange" else UNSET_DATE_LABEL if t in _DATE_INPUTS else UNSET_SELECT_LABEL
    spec: dict[str, Any] = {
        "key": key,
        "name": control.name,
        "input": t,
        "label": control.label,
        "default": default,
        "options": list(control.option_values) if t in ("select", "radio", "multiselect") else [],
        "can_unset": bool(control.can_unset),
        "unset_label": read_only_unset_label(var, unset_default),
        "placeholder": var.placeholder or "",
        "type": member_sql_type(var, t),
        "enabled": True,
    }
    if t in _NUMBER_INPUTS:
        spec.update(min=control.slider_min, max=control.slider_max, step=control.slider_step)
        if t == "number":  # a number field is bounded only by what the author set
            spec.update(min=var.min, max=var.max, step=var.step)
    return spec


def _same(option: str, value: Any) -> bool:
    try:
        return float(option) == float(value)
    except (TypeError, ValueError):
        return False
