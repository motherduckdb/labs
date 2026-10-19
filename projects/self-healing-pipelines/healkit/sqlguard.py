"""Deterministic SQL op guard (L2). No LLM, no Jev: this is the part that must never be talked around.

An op profile is the set of (statement_type, table) pairs a pipeline is known to perform, learned from
query_history for its past green runs plus what pipelines/<p>/ops.yaml declares. Destructive
statements outside the profile are blocked:

    UPDATE, DELETE, TRUNCATE, DROP, ALTER ... DROP, CREATE OR REPLACE (TABLE/VIEW),
    MERGE and INSERT OR REPLACE (both can overwrite existing rows, i.e. UPDATE semantics)

Enforced in three places: healkit.execute() at runtime (so SQL built by Python can't slip past after a
merge), the fixer's mdsql broker, and a static scan of the diff.
"""
import re
from dataclasses import dataclass

DESTRUCTIVE = ("UPDATE", "DELETE", "TRUNCATE", "DROP", "ALTER_DROP", "CREATE_OR_REPLACE", "MERGE", "UPSERT")

_ident = r'(?:"[^"]+"|[A-Za-z_][\w$]*)'
_qual = rf"{_ident}(?:\s*\.\s*{_ident}){{0,2}}"
_RULES = [
    ("CREATE_OR_REPLACE", re.compile(rf"^\s*CREATE\s+OR\s+REPLACE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+({_qual})", re.I | re.S)),
    ("ALTER_DROP", re.compile(rf"^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?({_qual})\s+DROP\b", re.I | re.S)),
    ("DROP", re.compile(rf"^\s*DROP\s+(?:TABLE|VIEW|SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?({_qual})", re.I | re.S)),
    ("TRUNCATE", re.compile(rf"^\s*TRUNCATE\s+(?:TABLE\s+)?({_qual})", re.I | re.S)),
    ("DELETE", re.compile(rf"^\s*DELETE\s+FROM\s+({_qual})", re.I | re.S)),
    ("UPDATE", re.compile(rf"^\s*UPDATE\s+({_qual})", re.I | re.S)),
    ("MERGE", re.compile(rf"^\s*MERGE\s+INTO\s+({_qual})", re.I | re.S)),
    ("UPSERT", re.compile(rf"^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+({_qual})", re.I | re.S)),
    ("INSERT", re.compile(rf"^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+({_qual})(?![^;]*\bON\s+CONFLICT\b[^;]*\bDO\s+UPDATE\b)", re.I | re.S)),
    ("UPSERT", re.compile(rf"^\s*INSERT\s+INTO\s+({_qual})", re.I | re.S)),   # INSERT ... ON CONFLICT DO UPDATE
    ("CREATE", re.compile(rf"^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?({_qual})", re.I | re.S)),
]
_TEMP = re.compile(r"^\s*CREATE\s+OR\s+REPLACE\s+TEMP", re.I)


def _strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


def split_statements(sql: str) -> list[str]:
    """Split on semicolons outside quotes."""
    out, buf, q = [], [], None
    for ch in _strip_comments(sql):
        if q:
            q = None if ch == q else q
        elif ch in ("'", '"'):
            q = ch
        elif ch == ";":
            out.append("".join(buf)); buf = []; continue
        buf.append(ch)
    out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def norm_table(name: str, default_db: str | None = None) -> str:
    """Normalise to `schema.table` (database dropped: sandboxes are clones with another name)."""
    parts = [p.strip().strip('"').lower() for p in re.split(r"\s*\.\s*", name.strip())]
    if len(parts) == 3:
        parts = parts[1:]
    if len(parts) == 1:
        parts = ["main", parts[0]]
    return ".".join(parts)


def classify(stmt: str) -> tuple[str, str | None]:
    # WITH ... INSERT / DELETE: look past the CTE for the verb.
    body = stmt
    m = re.match(r"^\s*WITH\b", stmt, re.I)
    if m:
        verb = re.search(r"\)\s*(INSERT|UPDATE|DELETE|MERGE|SELECT)\b", stmt, re.I)
        body = stmt[verb.start(1):] if verb else stmt
    for kind, rx in _RULES:
        mm = rx.match(body)
        if mm:
            if kind == "CREATE_OR_REPLACE" and _TEMP.match(body):
                return "CREATE_TEMP", norm_table(mm.group(1))
            return kind, norm_table(mm.group(1))
    head = body.split(None, 1)[0].upper() if body.split() else ""
    return head or "EMPTY", None


@dataclass
class Verdict:
    allowed: bool
    kind: str
    table: str | None
    reason: str

    def __str__(self):
        return f"{'ALLOW' if self.allowed else 'BLOCK'} {self.kind} {self.table or ''}: {self.reason}"


def check(sql: str, profile: set[tuple[str, str]] | None, *, protected: tuple[str, ...] = ()) -> list[Verdict]:
    """profile None = not enforcing (L1). protected: schema prefixes nobody may touch (e.g. 'heal_chaos')."""
    verdicts = []
    for stmt in split_statements(sql):
        kind, table = classify(stmt)
        low = stmt.lower()
        hit = next((p for p in protected if p in low), None)
        if hit:
            verdicts.append(Verdict(False, kind, table, f"references protected {hit}"))
        elif profile is not None and kind in DESTRUCTIVE and (kind, table) not in profile:
            verdicts.append(Verdict(False, kind, table, "destructive op outside the pipeline's learned op profile"))
        else:
            verdicts.append(Verdict(True, kind, table, "ok"))
    return verdicts


class GuardViolation(Exception):
    pass
