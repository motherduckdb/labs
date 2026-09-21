"""The dbt side of publishing: what the hook does, and in what order.

No dbt and no warehouse here. The macro file is loaded into a plain Jinja2 environment with
dbt's own globals stood in for (`return`, `var`, `target`, `graph`, `results`, `log`,
`exceptions`, `tojson`) and a `run_query` that records every statement and answers it from a
canned table. That is enough to run the whole hook and assert on the sequence it issues —
which is where the ordering rules live: the staged project source must never be visible
through the share, and a staging table must not outlive the run.
"""

from __future__ import annotations

import datetime as _dt
import hashlib as _hashlib
import json
import re
import types
from pathlib import Path
from typing import Any

import jinja2
import pytest

MACROS = Path(__file__).resolve().parents[1] / "macros"


class _Returned(Exception):
    def __init__(self, value):
        self.value = value


# ── the hook over a recording warehouse ───────────────────────────────────────
SHARE_URL = "md:_share/db_share/44444444-4444-4444-4444-444444444444"


class Warehouse:
    """`run_query` for the macros: records every statement, answers from a canned table."""

    def __init__(self, shares=(), flights=(("11111111-1111-1111-1111-111111111111", 1),), status="SUCCEEDED", published=(), stale_staging=()):
        self.shares, self.flights, self.status, self.published = list(shares), list(flights), status, list(published)
        self.stale_staging = list(stale_staging)  # staged projects other runs left in the schema
        self.sql: list[str] = []

    def __call__(self, sql: str):
        self.sql.append(sql)
        if sql.startswith("DROP TABLE"):
            self.stale_staging = [name for name in self.stale_staging if f'."{name}"' not in sql]
        return types.SimpleNamespace(rows=self._answer(sql))

    def _answer(self, sql: str):
        if "FROM glob(" in sql:  # the staging probe: every glob matches one file
            return [(g, 1) for g in re.findall(r"SELECT '([^']*)' AS g", sql)]
        if "count(*) FILTER" in sql:
            return [(21, 10, 213015)]
        if "CREATE OR REPLACE SHARE" in sql:  # minting one changes what the list reports
            made = re.search(r'SHARE "([^"]+)".*ACCESS (\w+), UPDATE (\w+)', sql, re.S)
            self.shares = [(made[1], SHARE_URL, made[2], made[3])]
            return []
        if "information_schema" in sql and "dbt_charts_dive_inputs" in sql:
            return [(name,) for name in self.stale_staging]
        if "MD_LIST_DATABASE_SHARES()" in sql:
            return self.shares
        if "MD_LIST_FLIGHTS()" in sql:
            return self.flights
        if "MD_GET_FLIGHT_VERSION" in sql:
            return [("stale program", "stale requirements")]
        if "MD_CREATE_FLIGHT" in sql or "MD_UPDATE_FLIGHT" in sql:
            return [("22222222-2222-2222-2222-222222222222",)]
        if "MD_RUN_FLIGHT" in sql:
            return [("33333333-3333-3333-3333-333333333333", 7)]
        if "MD_LIST_FLIGHT_RUNS" in sql:
            return [(self.status,)]
        if "dbt_charts_dive_runs" in sql:
            return self.published
        if "MD_GET_FLIGHT_LOGS" in sql:
            return [("Traceback: boom",)]
        return []

    def statements(self, *starts: str) -> list[str]:
        """The recorded statements that begin with any of ``starts``, in order."""
        return [s.strip() for s in self.sql if s.strip().upper().startswith(tuple(x.upper() for x in starts))]

    def order(self, *needles: str) -> list[str]:
        """The needles in the order they first appear across the recorded statements."""
        seen = []
        for s in self.sql:
            for n in needles:
                if n in s and n not in seen:
                    seen.append(n)
        return seen


class Failed(Exception):
    """dbt's `exceptions.raise_compiler_error`."""


NOW_STAMP = _dt.datetime.now(_dt.UTC).strftime("%Y%m%d%H")


def run_hook(cfg: dict | None = None, warehouse: Warehouse | None = None, log=None, target=None, **flags) -> Warehouse:
    """`save_charts_as_dives()` end to end, against a recording warehouse."""
    wh = warehouse or Warehouse()
    variables = {"save_charts_as_dives": flags.get("enabled", True), "dbt_charts_dive": cfg or {}}
    node = types.SimpleNamespace(resource_type="model", name="fct_orders")
    globals_ = {
        "execute": True,
        "var": lambda name, default=None: variables.get(name, default),
        "target": target or types.SimpleNamespace(database="db", schema="main", path="md:db"),
        "graph": types.SimpleNamespace(nodes={}, sources={}),
        "results": [types.SimpleNamespace(node=node, status="success")],
        "invocation_id": "0123456789abcdef",
        "invocation_args_dict": {"which": flags.get("which", "build")},
        "run_query": wh,
        "log": (lambda message, info=False: log(message)) if log else (lambda message, info=False: None),
        # exactly the shape dbt exposes: a dict of dicts, and `datetime` carries five
        # names with no `timezone` among them. Handing over the real module here once
        # hid a `modules.datetime.timezone.utc` that cannot work under dbt at all.
        "modules": {"datetime": {n: getattr(_dt, n) for n in ("date", "datetime", "time", "timedelta", "tzinfo")},
                    "pytz": None, "re": re, "itertools": None},
        "run_started_at": _dt.datetime.now(_dt.UTC),
        "local_md5": lambda text: _hashlib.md5(str(text).encode()).hexdigest(),
        "tojson": json.dumps,
        "exceptions": types.SimpleNamespace(raise_compiler_error=_raise),
    }
    call("save_charts_as_dives", _globals=globals_)
    return wh


def _raise(message):
    raise Failed(message)


def _answering(macro):
    """dbt catches its `return()` at each macro call; plain Jinja lets it fly past."""

    def called(*args, **kwargs):
        try:
            return macro(*args, **kwargs)
        except _Returned as r:
            return r.value

    return called


def call(name: str, *args, _globals: dict | None = None):
    """One macro out of the package's macro files, with dbt's globals stood in for. A dbt
    macro answers by raising out of `return()`, so calling one means catching that."""

    def _return(value):
        raise _Returned(value)

    env = jinja2.Environment(loader=jinja2.FileSystemLoader(str(MACROS)), extensions=["jinja2.ext.do"])
    namespace = types.SimpleNamespace()  # the macros call each other through the package namespace
    scope = {"return": _return, "dbt_charts_dive": namespace, **(_globals or {})}
    macros: dict[str, Any] = {}
    for path in sorted(MACROS.glob("*.sql")):
        template = env.get_template(path.name)
        context = template.new_context(scope)
        list(template.root_render_func(context))  # defines the file's macros; Jinja exports no _name
        macros.update(context.vars)
    for macro_name, macro in macros.items():
        setattr(namespace, macro_name, _answering(macro))
    try:
        rendered = macros[name](*args)  # a macro that emits text rather than returning
    except _Returned as r:
        return r.value
    return rendered


@pytest.mark.parametrize("which", ["build", "run", "seed", "snapshot", "clone", "retry"])
def test_commands_that_build_relations_publish(which):
    assert call("_publishes_on", which, {}) is True


@pytest.mark.parametrize("which", ["compile", "test", "docs", "source", "list", "show", "parse"])
def test_commands_that_build_nothing_do_not_publish(which):
    """`dbt compile` would otherwise republish every board against yesterday's tables."""
    assert call("_publishes_on", which, {}) is False


def test_a_project_can_ask_for_another_command():
    assert call("_publishes_on", "compile", {"commands": ["compile"]}) is True
    assert call("_publishes_on", "build", {"commands": ["compile"]}) is False


def test_an_unknown_command_still_publishes():
    """A dbt whose context does not name the command must keep working."""
    assert call("_publishes_on", "", {}) is True


def test_a_run_without_a_share_touches_no_share():
    wh = run_hook()
    assert wh.statements("CREATE OR REPLACE SHARE", "UPDATE SHARE") == []


def test_a_new_share_does_not_refresh_itself():
    """An automatic share would carry the staging table — the project's own source, boards
    and manifest — for as long as the run lasts, to anyone the share reaches."""
    wh = run_hook({"share": True})
    created = wh.statements("CREATE OR REPLACE SHARE")
    assert len(created) == 1 and "UPDATE MANUAL" in created[0]


def test_the_share_is_refreshed_after_the_staging_table_is_gone():
    wh = run_hook({"share": True}, Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")]))
    assert wh.order("CREATE OR REPLACE TABLE", "MD_RUN_FLIGHT", "DROP TABLE", "UPDATE SHARE") == [
        "CREATE OR REPLACE TABLE", "MD_RUN_FLIGHT", "DROP TABLE", "UPDATE SHARE"]


def test_a_share_is_not_refreshed_while_the_staging_table_is_still_there():
    """`wait: false` leaves the Flight running and the staging table in place."""
    wh = run_hook({"share": True, "wait": False}, Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")]))
    assert wh.statements("UPDATE SHARE") == []


def test_a_project_that_asks_for_an_automatic_share_gets_one():
    wh = run_hook({"share": {"update": "automatic"}})
    assert "UPDATE AUTOMATIC" in wh.statements("CREATE OR REPLACE SHARE")[0]


def test_the_share_is_not_refreshed_while_another_run_is_staging():
    """`UPDATE SHARE` snapshots the whole database, so it would publish the other run's
    staged project along with this run's data."""
    wh = Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")], stale_staging=[f"dbt_charts_dive_inputs_beef0000feed_{NOW_STAMP}"])
    run_hook({"share": True}, wh)
    assert wh.statements("UPDATE SHARE") == []


def test_a_flight_that_never_finished_keeps_its_staging_table():
    """The Flight may still be reading it; dropping it would break the run that is running."""
    wh = Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")], status="RUNNING")
    run_hook({"share": True, "fail_on_error": False, "timeout": 6}, wh)
    assert wh.statements("DROP TABLE") == [] and wh.statements("UPDATE SHARE") == []


def test_the_share_keeps_the_name_the_project_gave_it():
    wh = run_hook({"share": {"name": "public_demo"}})
    assert wh.statements("UPDATE SHARE") == ['UPDATE SHARE "public_demo"']


def test_a_share_whose_settings_changed_is_not_silently_replaced():
    """`CREATE OR REPLACE SHARE` mints a new URL, and every Dive published against the old
    one stops working. Say so and stop, rather than break them and log it."""
    wh = Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")])
    with pytest.raises(Failed, match="re-creates the share"):
        run_hook({"share": {"access": "unrestricted"}}, wh)
    assert wh.statements("CREATE OR REPLACE SHARE") == []


def test_a_share_can_be_replaced_when_the_project_says_so():
    wh = Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")])
    run_hook({"share": {"access": "unrestricted", "recreate": True}}, wh)
    assert len(wh.statements("CREATE OR REPLACE SHARE")) == 1


# ── the Flight, the staging table, and what is quoted ─────────────────────────
def test_the_flight_is_named_for_the_program_it_runs():
    """One Flight named `dbt_charts_dive` is a global two projects rewrite under each other:
    `MD_UPDATE_FLIGHT` replaces the program a run that is starting is about to use."""
    wh = run_hook()
    looked_up = next(s for s in wh.sql if "MD_LIST_FLIGHTS" in s)
    assert re.search(r"flight_name = 'dbt_charts_dive_[0-9a-f]{8}'", looked_up), looked_up


def test_a_project_can_still_pin_the_flight_name():
    wh = run_hook({"flight_name": "service_account_dives"})
    assert "'service_account_dives'" in next(s for s in wh.sql if "MD_LIST_FLIGHTS" in s)


def test_a_staging_table_another_run_abandoned_is_dropped():
    """A killed run leaves its staged project in the database; nothing was going to remove
    it, and a share refresh would have published it."""
    wh = Warehouse(stale_staging=["dbt_charts_dive_inputs_abc123456789_2020010100"])
    run_hook({}, wh)
    assert 'DROP TABLE IF EXISTS "db"."main"."dbt_charts_dive_inputs_abc123456789_2020010100"' in wh.statements("DROP TABLE")


@pytest.mark.parametrize("left", [f"dbt_charts_dive_inputs_abc123456789_{NOW_STAMP}", "dbt_charts_dive_inputs"])
def test_a_staging_table_that_may_still_be_in_use_is_left(left):
    """This hour's, and the one a Flight config names when nothing overrode it: neither is
    old enough to be nobody's."""
    wh = Warehouse(shares=[("db_share", SHARE_URL, "ORGANIZATION", "MANUAL")], stale_staging=[left])
    run_hook({"share": True}, wh)
    assert not any(f'."{left}"' in s for s in wh.statements("DROP TABLE"))
    assert wh.statements("UPDATE SHARE") == [], "somebody else's staged project is still here"


def test_every_name_the_hook_writes_is_quoted():
    """A database or schema with a space or a quote in it is a name, not SQL: it belongs
    inside `"` as an identifier or inside `'` as a value, never bare."""
    wh = run_hook(target=types.SimpleNamespace(database='my "db"', schema="report ing", path="md:my db"))
    for sql in wh.sql:
        bare = re.sub(r"'(?:[^']|'')*'", "", re.sub(r'"(?:[^"]|"")*"', "", sql))
        for name in ("my ", "report ing"):
            assert name not in bare, sql[:200]


def test_not_waiting_says_that_nothing_can_fail_the_build():
    logged = []
    run_hook({"wait": False, "fail_on_error": True}, log=logged.append)
    assert any("fail_on_error" in m for m in logged)


def test_the_flight_installs_the_dbt_charts_the_package_declares():
    """The version lives in two files — `pyproject.toml`, for anyone importing the compiler,
    and the Flight's own requirements, for the copy that actually builds the Dives. They have
    to say the same thing: a Flight that installed a different dbt Charts than the one the
    tests ran against would compile silently different Dives. It also has to say *something*,
    because the compiler is built out of ~26 of that version's private functions."""
    # not `dbt-charts-dive`, which is this package's own name a few lines above it
    declared = re.search(r'"dbt-charts((?:==|>=|~=)[^"]*)"', (MACROS.parent / "pyproject.toml").read_text())
    assert declared, "pyproject.toml does not depend on dbt-charts"
    bound = declared.group(1).strip()
    assert re.fullmatch(r"(==|>=|~=)\d+\.\d+\.\d+", bound), f"dbt-charts needs a version bound, got {bound!r}"
    assert re.search(rf"^dbt-charts{re.escape(bound)}$", call("_flight_requirements"), re.M), (
        f"the Flight installs a different dbt-charts than pyproject.toml declares ({bound})"
    )
