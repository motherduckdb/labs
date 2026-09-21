{#
  The Flight's program and its dependencies.

  The program is deliberately tiny: it writes this package's staged Python source to /tmp,
  puts it on sys.path and hands over to dbt_charts_dive.flight.main(). All of the real logic
  therefore travels with the dbt project that triggered the run — nothing to publish, and no
  version to keep in sync with the Flight.

  Changing either macro makes `_ensure_flight` push a new Flight version on the next run.
#}

{% macro _flight_source() -%}
{{ '' -}}
"""dbt_charts_dive: publish dbt Charts boards as MotherDuck Dives.

Managed by the dbt_charts_dive dbt package — created and updated from a dbt run's
on-run-end hook. The program below only loads the package source that the same run staged
into the DCD_INPUTS table; see dbt_charts_dive/flight.py for what actually happens.
"""

import os
import sys

import duckdb


def main():
    db = os.environ["DCD_DB"]
    schema = os.environ.get("DCD_SCHEMA") or "main"
    table = os.environ.get("DCD_INPUTS") or "dbt_charts_dive_inputs"
    stage = os.environ.get("DCD_STAGE") or "/tmp/dbt_charts_dive"

    con = duckdb.connect("md:")
    package = os.path.join(stage, "package")
    rows = con.execute(
        f'SELECT path, content FROM "{db}"."{schema}"."{table}" WHERE kind = \'package\''
    ).fetchall()
    for rel, content in rows:
        dest = os.path.join(package, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as f:
            f.write(content)
    print(f"bootstrap: wrote {len(rows)} package files to {package}", flush=True)

    sys.path.insert(0, package)
    from dbt_charts_dive.flight import main as run

    run()


if __name__ == "__main__":
    main()
{%- endmacro %}


{% macro _flight_requirements() -%}
{{ '' -}}
# Installed on MotherDuck compute before the program runs. dbt-charts is the compiler whose
# output the Dive renders. The Dive is built out of some 26 of its private functions, so a
# moved name is a silently different Dive rather than an import error; the floor is the
# release this was written against, and tests/test_private_api.py names every one of them.
# dbt-duckdb (and dbt-core, via it) is how dbt Charts reads the warehouse; duckdb is pinned
# to the version MotherDuck supports.
duckdb==1.5.5
dbt-charts>=0.8.0
dbt-duckdb>=1.9,<2
pyyaml>=6
{%- endmacro %}
