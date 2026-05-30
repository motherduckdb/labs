"""controllog-viz — static HTML views for controllog datasets.

Reads the universal controllog ``events`` + ``postings`` schema (from local JSONL
or MotherDuck, via one DuckDB layer) and renders two self-contained HTML pages:
a per-run review and a cross-run dashboard. No domain-specific code — payloads are
shown generically and postings are rolled up dynamically by ``(account_type, unit)``.
"""

__version__ = "0.1.0"

from controllog_viz.reader import connect
from controllog_viz.render import render_dashboard, render_run_review

__all__ = ["connect", "render_run_review", "render_dashboard", "__version__"]
