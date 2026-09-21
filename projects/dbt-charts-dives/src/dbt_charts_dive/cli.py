"""``dctmd`` — the dbt Charts CLI (``dct``) with MotherDuck ``md:`` path support patched in."""

from __future__ import annotations

import sys


def main() -> None:
    import dbt_charts_dive  # noqa: F401 — applies md_compat on import
    from dbt_charts.cli.main import app

    sys.exit(app())
