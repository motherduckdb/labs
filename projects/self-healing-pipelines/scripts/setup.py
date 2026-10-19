"""Create / migrate the healer's databases and tables (idempotent).

    source ~/.config/self-healing/env.sh   # self_healing_svc token
    uv run --with duckdb==1.5.6 --with pytz python scripts/setup.py
"""
import pathlib

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent.parent

con = duckdb.connect("md:")
con.execute("SET TimeZone='UTC'")
for stmt in (ROOT / "sql/schema.sql").read_text().split(";\n"):
    if stmt.strip() and not all(l.strip().startswith("--") or not l.strip() for l in stmt.splitlines()):
        con.execute(stmt)
print(con.execute("""SELECT database_name, count(*) AS tables FROM duckdb_tables()
                     WHERE database_name IN ('heal', 'heal_lake', 'heal_chaos') GROUP BY ALL ORDER BY 1""").fetchall())
