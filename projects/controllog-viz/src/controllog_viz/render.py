"""HTML renderers — presentation only; all data arrives as rows from ``queries``.

Two self-contained pages (inline CSS + a touch of inline JS, no external assets):

- :func:`render_run_review` — one run: stats bar, invariant badge, event timeline with
  collapsible generic JSON payloads, postings detail.
- :func:`render_dashboard` — cross-run, tabbed: a sortable/filterable Summary table,
  Trends (inline-SVG line charts), Event-kind stacked bar, a global invariant panel, and
  — when the dataset has ``evaluation_result`` events — a run × question
  progression/regression Matrix.
"""
from __future__ import annotations

import html as _html
import json
import math
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
/* tabs */
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 20px 0 0; flex-wrap: wrap; }
.tab { padding: 10px 18px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent;
  font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; user-select: none; }
.tab:hover { color: var(--fg); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-content { display: none; padding-top: 18px; }
.tab-content.active { display: block; }
.chart-title { font-size: 13px; color: var(--fg); margin: 18px 0 6px; font-weight: 600; }
/* sortable / filterable summary table */
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--fg); }
th.sorted-asc::after { content: " ▲"; color: var(--accent); }
th.sorted-desc::after { content: " ▼"; color: var(--accent); }
tr.hidden { display: none; }
.filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.filters label { color: var(--muted); font-size: 12px; }
.filters select, .filters input { background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  padding: 5px 8px; font-family: inherit; font-size: 12px; border-radius: 6px; }
.filter-count { color: var(--muted); font-size: 12px; }
/* matrix legend */
.mlegend { display: flex; flex-wrap: wrap; gap: 16px; margin: 10px 0 0; font-size: 12px; color: var(--muted); }
.mlegend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 5px;
  vertical-align: middle; }
.mlegend i.b { background: transparent; }
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

def _nice_ticks(data_max: float, n_ticks: int = 4) -> list[float]:
    """Rounded axis ticks from 0 to ~data_max at multiples of 1/2/5×10ⁿ."""
    if data_max <= 0:
        return [0.0, 1.0]
    raw_step = data_max / max(n_ticks, 1)
    magnitude = 10 ** math.floor(math.log10(raw_step))
    residual = raw_step / magnitude
    nice_step = (1 if residual <= 1.5 else 2 if residual <= 3.5 else 5 if residual <= 7.5 else 10) * magnitude
    ticks, t = [], 0.0
    while t <= data_max + nice_step * 0.5:
        ticks.append(round(t, 10))
        t += nice_step
    return ticks


def _line_chart(labels: list[str], values: list[float], color: str, title: str, places: int = 2) -> str:
    """Responsive line chart with a y-axis (nice ticks + gridlines) and thinned x labels."""
    if not values:
        return f'<h3 class="chart-title">{_esc(title)}</h3><div class="empty">no data</div>'
    if len(values) < 2:
        return (
            f'<h3 class="chart-title">{_esc(title)}</h3><div class="empty">'
            f"single run · {_fmt_num(values[0], places)}</div>"
        )
    if max(values) == 0 and min(values) == 0:
        return f'<h3 class="chart-title">{_esc(title)}</h3><div class="empty">all zero</div>'

    w, h = 1060, 240
    ml, mr, mt, mb = 84, 20, 16, 64
    plot_w, plot_h = w - ml - mr, h - mt - mb
    ticks = _nice_ticks(max(values))
    vmax = ticks[-1] or 1
    n = len(values)

    def x(i: int) -> float:
        return ml + plot_w * i / (n - 1)

    def y(v: float) -> float:
        return mt + plot_h * (1 - v / vmax)

    grid, ylabels = [], []
    for t in ticks:
        gy = y(t)
        grid.append(f'<line x1="{ml}" y1="{gy:.1f}" x2="{w - mr}" y2="{gy:.1f}" stroke="#262b36" stroke-width="1"/>')
        ylabels.append(
            f'<text x="{ml - 8}" y="{gy + 3:.1f}" text-anchor="end" fill="#8b93a7" font-size="10">{_fmt_num(t, places)}</text>'
        )

    step = max(1, n // 12)
    xlabels = []
    for i, lab in enumerate(labels):
        if i % step and i != n - 1:
            continue
        xx = x(i)
        xlabels.append(
            f'<text x="{xx:.1f}" y="{h - mb + 14:.1f}" text-anchor="end" fill="#8b93a7" '
            f'font-size="9" transform="rotate(-40 {xx:.1f} {h - mb + 14:.1f})">{_esc(str(lab)[-14:])}</text>'
        )

    poly = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(values))
    dots = "".join(
        f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="2.5" fill="{color}">'
        f'<title>{_esc(labels[i])}: {_fmt_num(v, places)}</title></circle>'
        for i, v in enumerate(values)
    )
    return (
        f'<h3 class="chart-title">{_esc(title)}</h3>'
        f'<svg viewBox="0 0 {w} {h}" width="100%" role="img">'
        f'{"".join(grid)}{"".join(ylabels)}{"".join(xlabels)}'
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
    """Render the per-run review page.

    If the run carries ``evaluation_result`` events, render the rich evaluation review
    (question-by-question cards, conversation explorer, filters — full parity with
    agentic-sql's review). Otherwise fall back to the universal per-run review.
    """
    from controllog_viz import eval_review

    if eval_review.has_eval_results(con, run_id):
        return eval_review.generate_eval_review(con, run_id)
    return _render_universal_run_review(con, run_id)


def _render_universal_run_review(con: duckdb.DuckDBPyConnection, run_id: str) -> str:
    """Render the universal per-run review (any controllog data, payload-agnostic)."""
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

DASHBOARD_JS = """
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

let sortCol = -1, sortAsc = true;
document.querySelectorAll('#summaryTable th.sortable').forEach(th => {
    th.addEventListener('click', () => {
        const col = parseInt(th.dataset.col);
        if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
        document.querySelectorAll('#summaryTable th').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(sortAsc ? 'sorted-asc' : 'sorted-desc');
        const tbody = document.querySelector('#summaryTable tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
            const va = a.children[col].textContent.trim();
            const vb = b.children[col].textContent.trim();
            const na = parseFloat(va.replace(/[%$,\\/]/g, ''));
            const nb = parseFloat(vb.replace(/[%$,\\/]/g, ''));
            if (!isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
            return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
        rows.forEach(r => tbody.appendChild(r));
    });
});

function applyFilters() {
    const proj = (document.getElementById('filterProject') || {}).value || '';
    const q = ((document.getElementById('filterRunId') || {}).value || '').toLowerCase();
    let visible = 0, total = 0;
    document.querySelectorAll('#summaryTable tbody tr').forEach(row => {
        total++;
        const okProj = !proj || row.dataset.project === proj;
        const okId = !q || (row.dataset.runid || '').toLowerCase().includes(q);
        const show = okProj && okId;
        row.classList.toggle('hidden', !show);
        if (show) visible++;
    });
    const c = document.getElementById('filter-count');
    if (c) c.textContent = 'Showing ' + visible + '/' + total;
}

document.addEventListener('DOMContentLoaded', applyFilters);
"""


def _heatmap_matrix(run_ids: list[str], rows_data: list[tuple]) -> str:
    """run × question progression/regression matrix as inline SVG.

    rows_data: list of (question_id, seq, flips, transitions) where seq[i] is
    True/False/None per run (chronological) and transitions maps a column index to
    'prog' (incorrect→correct) or 'regr' (correct→incorrect).
    """
    n_cols, n_rows = len(run_ids), len(rows_data)
    if not n_cols or not n_rows:
        return '<div class="empty">no evaluation_result data in the shown runs</div>'

    ml, mt, mr, mb = 160, 92, 16, 12
    cell = min(18, max(6, (1060 - ml - mr) // max(n_cols, 1)))
    w = ml + cell * n_cols + mr
    h = mt + cell * n_rows + mb
    color = {True: "#36d399", False: "#f87272", None: "#2a2f3a"}

    parts = [f'<svg viewBox="0 0 {w} {h}" width="100%" role="img">']

    step = max(1, n_cols // 16)
    for ci, rid in enumerate(run_ids):
        if ci % step and ci != n_cols - 1:
            continue
        cx = ml + ci * cell + cell / 2
        parts.append(
            f'<text x="{cx:.1f}" y="{mt - 6}" text-anchor="end" fill="#8b93a7" font-size="8" '
            f'transform="rotate(-45 {cx:.1f} {mt - 6})">{_esc(str(rid)[-12:])}</text>'
        )

    for ri, (qid, seq, flips, trans) in enumerate(rows_data):
        ry = mt + ri * cell + cell - 3
        parts.append(
            f'<text x="{ml - 6}" y="{ry:.1f}" text-anchor="end" fill="#8b93a7" font-size="9">'
            f'{_esc(("Q" + str(qid))[:24])} · {flips}↕</text>'
        )
        for ci in range(n_cols):
            v = seq[ci]
            x, y = ml + ci * cell, mt + ri * cell
            tkind = trans.get(ci)
            stroke = ""
            if tkind == "prog":
                stroke = ' stroke="#22d3ee" stroke-width="2"'
            elif tkind == "regr":
                stroke = ' stroke="#ffd23f" stroke-width="2"'
            status = "correct" if v is True else "incorrect" if v is False else "n/a"
            tip = f"{_esc(str(run_ids[ci]))} · Q{_esc(str(qid))}: {status}"
            if tkind:
                tip += " (progression)" if tkind == "prog" else " (regression)"
            parts.append(
                f'<rect x="{x}" y="{y}" width="{cell - 1}" height="{cell - 1}" '
                f'fill="{color[v]}" rx="1"{stroke}><title>{tip}</title></rect>'
            )
    parts.append("</svg>")

    legend = (
        '<div class="mlegend">'
        '<span><i style="background:#36d399"></i>correct</span>'
        '<span><i style="background:#f87272"></i>incorrect</span>'
        '<span><i style="background:#2a2f3a"></i>missing</span>'
        '<span><i class="b" style="border:2px solid #22d3ee"></i>progression (→correct)</span>'
        '<span><i class="b" style="border:2px solid #ffd23f"></i>regression (→incorrect)</span>'
        "</div>"
    )
    return "".join(parts) + legend


def _build_matrix(con: duckdb.DuckDBPyConnection, run_rows: list[dict], cap: int = 100) -> list[tuple]:
    """Build matrix rows from evaluation_result correctness, scoped to the shown runs."""
    ordered = [str(r["run_id"]) for r in run_rows]
    order_index = {rid: i for i, rid in enumerate(ordered)}

    corr: dict[tuple, bool] = {}
    qids: set[str] = set()
    for row in q.eval_matrix(con):
        rid = str(row["run_id"])
        if rid not in order_index:
            continue
        qid = str(row["question_id"])
        corr[(rid, qid)] = bool(row["is_correct"])
        qids.add(qid)

    rows_data: list[tuple] = []
    for qid in qids:
        seq = [corr.get((rid, qid)) for rid in ordered]
        flips, trans, prev = 0, {}, None
        for ci, v in enumerate(seq):
            if v is None:
                continue
            if prev is not None and v != prev:
                flips += 1
                trans[ci] = "prog" if v else "regr"
            prev = v
        rows_data.append((qid, seq, flips, trans))

    # Most-volatile questions first; then those with any data; cap for legibility.
    rows_data.sort(key=lambda t: (-t[2], _qsort(t[0])))
    return rows_data[:cap]


def _qsort(qid: str):
    """Sort question ids numerically when possible, else lexically."""
    return (0, int(qid)) if qid.isdigit() else (1, qid)


def render_dashboard(con: duckdb.DuckDBPyConnection, source_label: str = "", limit: int | None = None) -> str:
    """Render the cross-run dashboard: tabbed, sortable/filterable, with charts.

    ``limit`` scopes the table/charts/matrix to the most recent N runs; the invariant
    panel always reports across the whole dataset. A run × question progression/regression
    Matrix tab appears when the dataset has ``evaluation_result`` events.
    """
    run_rows = q.runs(con, limit=limit)
    global_violations = q.trial_balance(con)

    shown_ids = {str(r["run_id"]) for r in run_rows}
    by_run: dict[str, dict[str, int]] = defaultdict(dict)
    for row in q.kind_counts_by_run(con):
        rid = str(row["run_id"])
        if rid in shown_ids:
            by_run[rid][row["kind"]] = row["count"]

    total_events = sum(r["event_count"] for r in run_rows)
    stats_html = '<div class="stats">' + "".join([
        _badge("runs", str(len(run_rows))),
        _badge("events", f"{total_events:,}"),
        _badge("cost", _fmt_num(sum(r["cost"] for r in run_rows), 4)),
        _badge("utility", _fmt_num(sum(r["utility"] for r in run_rows), 2)),
        _badge("invariants", "OK" if not global_violations else f"{len(global_violations)} bad",
               "ok" if not global_violations else "bad"),
    ]) + "</div>"

    labels = [str(r["run_id"]) for r in run_rows]

    # --- Summary tab: filters + sortable table ---
    projects = sorted({str(r["project"]) for r in run_rows if r.get("project")})
    proj_filter = ""
    if len(projects) > 1:
        opts = "".join(f'<option value="{_esc(p)}">{_esc(p)}</option>' for p in projects)
        proj_filter = (
            '<label>Project:</label>'
            f'<select id="filterProject" onchange="applyFilters()"><option value="">All</option>{opts}</select>'
        )
    filters_html = (
        '<div class="filters">'
        f"{proj_filter}"
        '<label>Run id:</label>'
        '<input id="filterRunId" type="text" placeholder="substring…" oninput="applyFilters()">'
        '<span class="filter-count" id="filter-count"></span>'
        "</div>"
    )

    if run_rows:
        ok_cell = '<span class="ok">ok</span>'
        drift_cell = '<span class="bad">drift</span>'
        trs = "".join(
            f'<tr data-runid="{_esc(r["run_id"])}" data-project="{_esc(r.get("project") or "")}">'
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
        headers = ["run_id", "started", "events", "kinds", "cost", "latency ms", "utility", "inv"]
        num_cols = {2, 3, 4, 5, 6}
        ths = "".join(
            f'<th class="sortable{" num" if i in num_cols else ""}" data-col="{i}">{h}</th>'
            for i, h in enumerate(headers)
        )
        summary_tab = (
            f"{filters_html}"
            f'<table id="summaryTable"><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table>'
        )
    else:
        summary_tab = '<div class="empty">no runs found</div>'

    # --- Trends tab ---
    trends_tab = (
        _line_chart(labels, [r["cost"] for r in run_rows], "#ffd23f", "Cost per run", places=4)
        + _line_chart(labels, [r["latency_ms"] for r in run_rows], "#5b8def", "Latency (ms) per run", places=0)
        + _line_chart(labels, [r["utility"] for r in run_rows], "#36d399", "Utility per run", places=2)
    )

    # --- Event kinds tab ---
    kinds_tab = _stacked_bar(dict(by_run), "Event kinds per run")

    # --- Invariants tab ---
    invariants_tab = _invariant_panel(global_violations)

    # --- Matrix tab (eval-aware) ---
    has_matrix = q.has_any_eval_results(con) and bool(run_rows)
    matrix_tab = ""
    if has_matrix:
        rows_data = _build_matrix(con, run_rows)
        n_q = len(rows_data)
        matrix_tab = (
            f'<p class="sub">{n_q} question(s), shown runs only, oldest → newest. '
            "Sorted by volatility (flips ↕). Cells: green=correct, red=incorrect, gray=missing; "
            "borders mark progressions/regressions.</p>"
            f"{_heatmap_matrix(labels, rows_data)}"
        )

    # --- Assemble tabs ---
    tab_defs = [("summary", "Summary", summary_tab), ("trends", "Trends", trends_tab),
                ("kinds", "Event Kinds", kinds_tab)]
    if has_matrix:
        tab_defs.append(("matrix", "Matrix", matrix_tab))
    tab_defs.append(("invariants", "Invariants", invariants_tab))

    nav = "".join(
        f'<div class="tab{" active" if i == 0 else ""}" data-tab="{key}">{label}</div>'
        for i, (key, label, _) in enumerate(tab_defs)
    )
    contents = "".join(
        f'<div id="tab-{key}" class="tab-content{" active" if i == 0 else ""}">{content}</div>'
        for i, (key, label, content) in enumerate(tab_defs)
    )

    sub = f"{_esc(source_label)} · " if source_label else ""
    scope = f" · most recent {len(run_rows)}" if limit and len(run_rows) >= limit else ""
    body = (
        "<h1>CONTROLLOG DASHBOARD</h1>"
        f'<p class="sub">{sub}{len(run_rows)} runs{scope} · '
        f'generated {datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")}</p>'
        f"{stats_html}"
        f'<div class="tabs">{nav}</div>'
        f"{contents}"
    )
    return (
        '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Controllog dashboard</title><style>{CSS}</style></head>"
        f'<body><div class="wrap">{body}</div><script>{DASHBOARD_JS}</script></body></html>'
    )
