"""HTML renderers — presentation only; all data arrives as rows from ``queries``.

Two self-contained pages (inline CSS + a touch of inline JS, no external assets):

- :func:`render_run_review` — one run: stats bar, invariant badge, event timeline with
  collapsible generic JSON payloads, postings detail.
- :func:`render_dashboard` — all runs: runs table, inline-SVG trend charts, per-run kind
  stacked bar, and a global invariant panel.
"""
from __future__ import annotations

import html as _html
import json
from collections import defaultdict
from datetime import UTC, datetime

import duckdb

from controllog_viz import queries as q

# --------------------------------------------------------------------------- styling

CSS = """
:root {
  --bg: #0f1115; --panel: #171a21; --line: #262b36; --fg: #e6e9ef; --muted: #8b93a7;
  --accent: #ffd23f; --ok: #36d399; --bad: #f87272; --bar: #5b8def;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 80px; }
h1 { font-size: 20px; letter-spacing: .04em; margin: 0 0 2px; }
h2 { font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em;
  margin: 32px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.sub { color: var(--muted); margin: 0 0 20px; font-size: 12px; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
.badge { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 12px; }
.badge .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.badge .v { font-size: 18px; font-weight: 600; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
.pill { display: inline-block; padding: 3px 9px; border-radius: 99px; font-size: 12px; font-weight: 600; }
.pill.ok { background: rgba(54,211,153,.15); } .pill.bad { background: rgba(248,114,114,.15); }
table { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
a { color: var(--accent); }
details { margin: 0; }
summary { cursor: pointer; color: var(--muted); }
pre { margin: 8px 0 0; padding: 10px; background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; overflow-x: auto; font-size: 12px; }
.kind { color: var(--accent); }
svg { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
.empty { color: var(--muted); padding: 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; }
"""

# Categorical palette for stacked bars / legends.
_PALETTE = ["#5b8def", "#ffd23f", "#36d399", "#f87272", "#a78bfa", "#f59e0b", "#22d3ee", "#fb7185"]


# --------------------------------------------------------------------------- helpers

def _esc(text: object) -> str:
    return _html.escape("" if text is None else str(text))


def _doc(title: str, body: str) -> str:
    return (
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"UTF-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{_esc(title)}</title><style>{CSS}</style></head>"
        f"<body><div class=\"wrap\">{body}</div></body></html>"
    )


def _json_block(payload_str: str | None) -> str:
    """Pretty-print a JSON string into a collapsible block; degrade gracefully."""
    if not payload_str or payload_str in ("{}", "null"):
        return '<span style="color:var(--muted)">—</span>'
    try:
        pretty = json.dumps(json.loads(payload_str), indent=2, sort_keys=True)
    except (ValueError, TypeError):
        pretty = str(payload_str)
    return f"<details><summary>payload</summary><pre>{_esc(pretty)}</pre></details>"


def _badge(label: str, value: str, cls: str = "") -> str:
    return f'<div class="badge"><div class="k">{_esc(label)}</div><div class="v {cls}">{value}</div></div>'


def _fmt_num(value: float, places: int = 2) -> str:
    if value is None:
        return "0"
    if value == int(value):
        return f"{int(value):,}"
    return f"{value:,.{places}f}"


def _fmt_time(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


def _invariant_pill(violations: list[dict]) -> str:
    if not violations:
        return '<span class="pill ok">invariants balanced</span>'
    return f'<span class="pill bad">{len(violations)} invariant violation(s)</span>'


# --------------------------------------------------------------------------- charts (inline SVG)

def _line_chart(labels: list[str], values: list[float], color: str, title: str) -> str:
    """Minimal responsive line chart. Falls back to a note for <2 points."""
    w, h, pad = 1060, 160, 28
    if not values:
        return f'<h2>{_esc(title)}</h2><div class="empty">no data</div>'
    if len(values) < 2:
        return (
            f'<h2>{_esc(title)}</h2><div class="empty">'
            f"single run · {_fmt_num(values[0])}</div>"
        )
    if max(values) == 0 and min(values) == 0:
        return f'<h2>{_esc(title)}</h2><div class="empty">no data</div>'
    vmax = max(values) or 1
    n = len(values)
    pts = []
    for i, v in enumerate(values):
        x = pad + (w - 2 * pad) * i / (n - 1)
        y = h - pad - (h - 2 * pad) * (v / vmax)
        pts.append(f"{x:.1f},{y:.1f}")
    poly = " ".join(pts)
    dots = "".join(
        f'<circle cx="{p.split(",")[0]}" cy="{p.split(",")[1]}" r="3" fill="{color}"/>'
        for p in pts
    )
    return (
        f'<h2>{_esc(title)}</h2>'
        f'<svg viewBox="0 0 {w} {h}" width="100%" preserveAspectRatio="none" role="img">'
        f'<text x="{pad}" y="16" fill="#8b93a7" font-size="11">max {_fmt_num(vmax)}</text>'
        f'<polyline points="{poly}" fill="none" stroke="{color}" stroke-width="2"/>'
        f"{dots}</svg>"
    )


def _stacked_bar(by_run: dict[str, dict[str, int]], title: str) -> str:
    """Per-run stacked bar of event-kind counts."""
    if not by_run:
        return f'<h2>{_esc(title)}</h2><div class="empty">no data</div>'
    kinds = sorted({k for counts in by_run.values() for k in counts})
    color_of = {k: _PALETTE[i % len(_PALETTE)] for i, k in enumerate(kinds)}
    run_ids = list(by_run)
    totals = [sum(by_run[r].values()) for r in run_ids]
    vmax = max(totals) or 1

    w, h, pad = 1060, 200, 28
    n = len(run_ids)
    slot = (w - 2 * pad) / n
    bar_w = min(48, slot * 0.6)
    bars = []
    for i, r in enumerate(run_ids):
        x = pad + slot * i + (slot - bar_w) / 2
        y = h - pad
        for k in kinds:
            c = by_run[r].get(k, 0)
            if not c:
                continue
            seg = (h - 2 * pad) * (c / vmax)
            y -= seg
            bars.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{seg:.1f}" '
                f'fill="{color_of[k]}"><title>{_esc(r)} · {_esc(k)}: {c}</title></rect>'
            )
    legend = "".join(
        f'<span><i style="background:{color_of[k]}"></i>{_esc(k)}</span>' for k in kinds
    )
    return (
        f'<h2>{_esc(title)}</h2>'
        f'<svg viewBox="0 0 {w} {h}" width="100%" role="img">'
        f'<text x="{pad}" y="16" fill="#8b93a7" font-size="11">max {vmax}</text>'
        f'{"".join(bars)}</svg>'
        f'<div class="legend">{legend}</div>'
    )


# --------------------------------------------------------------------------- run review

def render_run_review(con: duckdb.DuckDBPyConnection, run_id: str) -> str:
    """Render the per-run review page."""
    events = q.events_for_run(con, run_id)
    rollup = q.postings_rollup(con, run_id)
    kinds = q.kind_counts(con, run_id)
    violations = q.trial_balance(con, run_id)

    label = run_id if run_id is not None else "(no run_id)"
    stats = [
        _badge("events", str(len(events))),
        _badge("kinds", str(len(kinds))),
    ]
    for row in rollup:
        name = q.ACCOUNT_LABELS.get(row["account_type"], row["account_type"])
        unit = f' <span style="color:var(--muted);font-size:12px">{_esc(row["unit"])}</span>'
        stats.append(_badge(name, _fmt_num(row["flow"], 4) + unit))
    stats_html = '<div class="stats">' + "".join(stats) + "</div>"

    # Event timeline
    if events:
        rows = "".join(
            "<tr>"
            f"<td>{_esc(_fmt_time(e['event_time']))}</td>"
            f'<td><span class="kind">{_esc(e["kind"])}</span></td>'
            f"<td>{_esc(e['actor_agent_id'])}{('/' + _esc(e['actor_task_id'])) if e['actor_task_id'] else ''}</td>"
            f"<td>{_json_block(e['payload_json'])}</td>"
            "</tr>"
            for e in events
        )
        timeline = (
            "<table><thead><tr><th>time</th><th>kind</th><th>actor</th><th>payload</th>"
            f"</tr></thead><tbody>{rows}</tbody></table>"
        )
    else:
        timeline = '<div class="empty">no events for this run</div>'

    # Postings detail
    if rollup:
        prows = "".join(
            "<tr>"
            f"<td>{_esc(r['account_type'])}</td>"
            f"<td>{_esc(r['unit'])}</td>"
            f"<td class=\"num\">{_fmt_num(r['flow'], 4)}</td>"
            f"<td class=\"num\">{_fmt_num(r['net'], 6)}</td>"
            f"<td class=\"num\">{r['posting_count']}</td>"
            "</tr>"
            for r in rollup
        )
        postings = (
            '<table><thead><tr><th>account_type</th><th>unit</th>'
            '<th class="num">flow</th><th class="num">net</th><th class="num">postings</th>'
            f"</tr></thead><tbody>{prows}</tbody></table>"
        )
    else:
        postings = '<div class="empty">no postings for this run</div>'

    inv = _invariant_panel(violations)

    body = (
        f"<h1>RUN REVIEW · {_esc(label)}</h1>"
        f'<p class="sub">{_invariant_pill(violations)} · generated {datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")}</p>'
        f"{stats_html}"
        f"<h2>Invariants</h2>{inv}"
        f"<h2>Events</h2>{timeline}"
        f"<h2>Postings</h2>{postings}"
    )
    return _doc(f"Run review · {label}", body)


def _invariant_panel(violations: list[dict]) -> str:
    if not violations:
        return '<div class="empty ok">All balanced slices net to zero.</div>'
    rows = "".join(
        "<tr>"
        f"<td>{_esc(v['account_type'])}</td><td>{_esc(v['unit'])}</td>"
        f"<td class=\"num bad\">{_fmt_num(v['net'], 6)}</td>"
        "</tr>"
        for v in violations
    )
    return (
        '<table><thead><tr><th>account_type</th><th>unit</th>'
        f'<th class="num">net (should be 0)</th></tr></thead><tbody>{rows}</tbody></table>'
    )


# --------------------------------------------------------------------------- dashboard

def render_dashboard(con: duckdb.DuckDBPyConnection, source_label: str = "") -> str:
    """Render the cross-run dashboard page."""
    run_rows = q.runs(con)
    global_violations = q.trial_balance(con)

    by_run_raw = q.kind_counts_by_run(con)
    by_run: dict[str, dict[str, int]] = defaultdict(dict)
    for row in by_run_raw:
        by_run[str(row["run_id"])][row["kind"]] = row["count"]

    total_events = sum(r["event_count"] for r in run_rows)
    stats_html = '<div class="stats">' + "".join([
        _badge("runs", str(len(run_rows))),
        _badge("events", f"{total_events:,}"),
        _badge("cost", _fmt_num(sum(r["cost"] for r in run_rows), 4)),
        _badge("utility", _fmt_num(sum(r["utility"] for r in run_rows), 2)),
        _badge("invariants", "OK" if not global_violations else f"{len(global_violations)} bad",
               "ok" if not global_violations else "bad"),
    ]) + "</div>"

    # Charts
    labels = [str(r["run_id"]) for r in run_rows]
    charts = (
        _line_chart(labels, [r["cost"] for r in run_rows], "#ffd23f", "Cost per run")
        + _line_chart(labels, [r["latency_ms"] for r in run_rows], "#5b8def", "Latency (ms) per run")
        + _line_chart(labels, [r["utility"] for r in run_rows], "#36d399", "Utility per run")
        + _stacked_bar(dict(by_run), "Event kinds per run")
    )

    # Runs table
    if run_rows:
        ok_cell = '<span class="ok">ok</span>'
        drift_cell = '<span class="bad">drift</span>'
        trs = "".join(
            "<tr>"
            f"<td>{_esc(r['run_id'])}</td>"
            f"<td>{_esc(_fmt_time(r['first_time']))}</td>"
            f'<td class="num">{r["event_count"]:,}</td>'
            f'<td class="num">{r["kind_count"]}</td>'
            f'<td class="num">{_fmt_num(r["cost"], 4)}</td>'
            f'<td class="num">{_fmt_num(r["latency_ms"], 0)}</td>'
            f'<td class="num">{_fmt_num(r["utility"], 2)}</td>'
            f"<td>{ok_cell if r['invariant_ok'] else drift_cell}</td>"
            "</tr>"
            for r in run_rows
        )
        runs_table = (
            '<table><thead><tr><th>run_id</th><th>started</th><th class="num">events</th>'
            '<th class="num">kinds</th><th class="num">cost</th><th class="num">latency ms</th>'
            '<th class="num">utility</th><th>inv</th></tr></thead>'
            f"<tbody>{trs}</tbody></table>"
        )
    else:
        runs_table = '<div class="empty">no runs found</div>'

    sub = f"{_esc(source_label)} · " if source_label else ""
    body = (
        "<h1>CONTROLLOG DASHBOARD</h1>"
        f'<p class="sub">{sub}generated {datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")}</p>'
        f"{stats_html}"
        f"{charts}"
        f"<h2>Runs</h2>{runs_table}"
        f"<h2>Global invariants</h2>{_invariant_panel(global_violations)}"
    )
    return _doc("Controllog dashboard", body)
