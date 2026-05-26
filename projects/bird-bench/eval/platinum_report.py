"""
Platinum Candidate Review Report Generator for BIRD-Bench.

Generates a Bloomberg-terminal style HTML report for reviewing platinum candidates
from truth-seeker analysis output.

Features:
- 3-column layout: Question/Context, SQL Comparison, Verdict/Reasoning
- SQL formatting via sqlglot
- Keyboard navigation (j/k or arrows)
- Accept/reject buttons with localStorage persistence
- Filters by verdict, confidence, recommendation, db_id

Usage:
    uv run bird-eval inspect --latest --open
"""

import json
import html
from datetime import datetime
from pathlib import Path

from eval.config import RESULTS_DIR


def format_sql(sql: str) -> str:
    """Format SQL for display using sqlglot."""
    try:
        import sqlglot
        return sqlglot.transpile(sql, pretty=True)[0]
    except Exception:
        return sql  # Fallback to original if parsing fails


def escape_html(text: str) -> str:
    """HTML escape text safely."""
    if text is None:
        return ""
    return html.escape(str(text))


CSS_STYLES = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
    font-size: 11px;
    background: #0a0a0a;
    color: #e0e0e0;
    line-height: 1.3;
}
.header {
    background: #1a1a2e;
    padding: 8px 16px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 1000;
}
.header h1 { font-size: 14px; color: #4ecca3; }
.header .stats { color: #888; }
.header button {
    background: #4ecca3;
    color: #000;
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    font-weight: bold;
    margin-left: 8px;
}
.header button:hover { background: #3db892; }
.filter-bar {
    display: flex;
    gap: 16px;
    align-items: center;
    margin-left: 20px;
}
.filter-bar label { color: #888; font-size: 10px; }
.filter-bar select {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #444;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
}
.container { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
.candidate-card {
    background: #111;
    border: 1px solid #333;
    border-left: 3px solid #666;
}
.candidate-card.PREDICTED_CORRECT { border-left-color: #4ecca3; }
.candidate-card.BOTH_CORRECT { border-left-color: #00aaff; }
.candidate-card.GOLD_CORRECT { border-left-color: #ff8800; }
.candidate-card.BOTH_WRONG { border-left-color: #ff4444; }
.candidate-card.UNCLEAR { border-left-color: #888; }
.candidate-card.accepted { border-left-color: #00ff00 !important; background: #0a1a0a; }
.candidate-card.rejected { border-left-color: #ff0000 !important; background: #1a0a0a; opacity: 0.6; }
.candidate-card.hidden { display: none; }
.candidate-card.selected { box-shadow: 0 0 0 2px #4ecca3; }
.card-header {
    background: #1a1a1a;
    padding: 6px 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    border-bottom: 1px solid #333;
}
.card-header:hover { background: #222; }
.q-id { font-weight: bold; color: #4ecca3; }
.q-db { color: #888; margin-left: 10px; }
.verdict-badge {
    padding: 2px 6px;
    font-size: 10px;
    font-weight: bold;
    margin-left: 8px;
}
.verdict-badge.PREDICTED_CORRECT { background: #4ecca3; color: #000; }
.verdict-badge.BOTH_CORRECT { background: #00aaff; color: #000; }
.verdict-badge.GOLD_CORRECT { background: #ff8800; color: #000; }
.verdict-badge.BOTH_WRONG { background: #ff4444; color: #000; }
.verdict-badge.UNCLEAR { background: #888; color: #000; }
.confidence-badge {
    padding: 2px 6px;
    font-size: 9px;
    margin-left: 4px;
}
.confidence-badge.HIGH { background: #4ecca3; color: #000; }
.confidence-badge.MEDIUM { background: #ffc107; color: #000; }
.confidence-badge.LOW { background: #888; color: #000; }
.recommendation-badge {
    padding: 2px 6px;
    font-size: 9px;
    margin-left: 4px;
}
.recommendation-badge.ADD_TO_PLATINUM { background: #4ecca3; color: #000; }
.recommendation-badge.NEEDS_REVIEW { background: #ffc107; color: #000; }
.recommendation-badge.KEEP_GOLD { background: #888; color: #000; }
.decision-badge {
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    margin-left: 8px;
}
.decision-badge.accepted { background: #00ff00; color: #000; }
.decision-badge.rejected { background: #ff0000; color: #fff; }
.card-body {
    display: grid;
    grid-template-columns: 1fr 1.5fr 1fr;
    gap: 1px;
    background: #333;
}
.card-body.collapsed { display: none; }
.panel {
    background: #111;
    padding: 8px;
    overflow: auto;
    max-height: 600px;
}
.panel h3 {
    color: #00aaff;
    font-size: 10px;
    text-transform: uppercase;
    margin-bottom: 6px;
    border-bottom: 1px solid #333;
    padding-bottom: 4px;
}
.question-text { color: #fff; font-size: 12px; margin-bottom: 8px; }
.evidence { color: #aaa; font-style: italic; margin-bottom: 8px; padding: 6px; background: #0a0a0a; border: 1px solid #222; }
pre {
    background: #0a0a0a;
    padding: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 10px;
    border: 1px solid #222;
}
pre.sql { color: #4ecca3; }
pre.result { color: #ffaa00; max-height: 150px; overflow-y: auto; }
.sql-section { margin-bottom: 12px; }
.sql-label {
    font-size: 9px;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 4px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.sql-label.gold { color: #ff8800; }
.sql-label.predicted { color: #4ecca3; }
.result-label { font-size: 9px; color: #666; margin-top: 6px; margin-bottom: 2px; }
.reasoning-text {
    color: #e0e0e0;
    font-size: 11px;
    line-height: 1.5;
    margin-bottom: 12px;
    padding: 8px;
    background: #0d0d1a;
    border: 1px solid #2a2a4a;
}
.issues-section { margin-bottom: 12px; }
.issues-section h4 {
    font-size: 10px;
    color: #ff8800;
    margin-bottom: 4px;
}
.issues-section.predicted-issues h4 { color: #4ecca3; }
.issues-list {
    list-style: none;
    padding-left: 0;
}
.issues-list li {
    color: #aaa;
    font-size: 10px;
    padding: 4px 8px;
    background: #0a0a0a;
    border-left: 2px solid #ff8800;
    margin-bottom: 2px;
}
.issues-section.predicted-issues .issues-list li { border-left-color: #4ecca3; }
.action-buttons {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #333;
}
.action-buttons button {
    flex: 1;
    padding: 8px 16px;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    font-weight: bold;
}
.action-buttons .accept-btn { background: #4ecca3; color: #000; }
.action-buttons .accept-btn:hover { background: #3db892; }
.action-buttons .reject-btn { background: #ff4444; color: #fff; }
.action-buttons .reject-btn:hover { background: #cc3333; }
.action-buttons .skip-btn { background: #444; color: #e0e0e0; }
.action-buttons .skip-btn:hover { background: #555; }
.nav-help {
    color: #666;
    font-size: 10px;
    text-align: center;
    padding: 8px;
    border-top: 1px solid #333;
}
.nav-help kbd {
    background: #333;
    padding: 2px 6px;
    border-radius: 3px;
    margin: 0 2px;
}
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #111; }
::-webkit-scrollbar-thumb { background: #444; }
::-webkit-scrollbar-thumb:hover { background: #666; }
"""

JS_SCRIPT = """
let decisions = JSON.parse(localStorage.getItem('platinum_decisions') || '{}');
let currentIndex = 0;
let visibleCards = [];

function updateVisibleCards() {
    visibleCards = Array.from(document.querySelectorAll('.candidate-card:not(.hidden)'));
    updateSelection();
}

function updateSelection() {
    document.querySelectorAll('.candidate-card').forEach(c => c.classList.remove('selected'));
    if (visibleCards[currentIndex]) {
        visibleCards[currentIndex].classList.add('selected');
        visibleCards[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function navigateNext() {
    if (currentIndex < visibleCards.length - 1) {
        currentIndex++;
        updateSelection();
    }
}

function navigatePrev() {
    if (currentIndex > 0) {
        currentIndex--;
        updateSelection();
    }
}

function toggleCard(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('collapsed');
}

function expandAll() {
    document.querySelectorAll('.card-body').forEach(b => b.classList.remove('collapsed'));
}

function collapseAll() {
    document.querySelectorAll('.card-body').forEach(b => b.classList.add('collapsed'));
}

function setDecision(qid, decision) {
    const card = document.querySelector(`[data-qid="${qid}"]`);
    if (!card) return;

    // Clear previous decision
    card.classList.remove('accepted', 'rejected');
    const oldBadge = card.querySelector('.decision-badge');
    if (oldBadge) oldBadge.remove();

    if (decision) {
        decisions[qid] = decision;
        card.classList.add(decision);

        // Add badge to header
        const header = card.querySelector('.card-header');
        const badge = document.createElement('span');
        badge.className = `decision-badge ${decision}`;
        badge.textContent = decision.toUpperCase();
        header.appendChild(badge);
    } else {
        delete decisions[qid];
    }

    localStorage.setItem('platinum_decisions', JSON.stringify(decisions));
    updateCounts();
}

function updateCounts() {
    const accepted = Object.values(decisions).filter(d => d === 'accepted').length;
    const rejected = Object.values(decisions).filter(d => d === 'rejected').length;
    document.getElementById('decision-counts').textContent =
        `Accepted: ${accepted} | Rejected: ${rejected}`;
}

function applyFilters() {
    const verdictFilter = document.getElementById('verdict-filter').value;
    const confidenceFilter = document.getElementById('confidence-filter').value;
    const recommendationFilter = document.getElementById('recommendation-filter').value;
    const dbFilter = document.getElementById('db-filter').value;
    const decisionFilter = document.getElementById('decision-filter').value;

    document.querySelectorAll('.candidate-card').forEach(card => {
        const verdict = card.dataset.verdict || '';
        const confidence = card.dataset.confidence || '';
        const recommendation = card.dataset.recommendation || '';
        const db = card.dataset.db || '';
        const qid = card.dataset.qid;
        const decision = decisions[qid] || '';

        const verdictMatch = !verdictFilter || verdict === verdictFilter;
        const confidenceMatch = !confidenceFilter || confidence === confidenceFilter;
        const recommendationMatch = !recommendationFilter || recommendation === recommendationFilter;
        const dbMatch = !dbFilter || db === dbFilter;
        const decisionMatch = !decisionFilter ||
            (decisionFilter === 'pending' && !decision) ||
            (decisionFilter === 'accepted' && decision === 'accepted') ||
            (decisionFilter === 'rejected' && decision === 'rejected');

        if (verdictMatch && confidenceMatch && recommendationMatch && dbMatch && decisionMatch) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });

    currentIndex = 0;
    updateVisibleCards();

    const visible = visibleCards.length;
    const total = document.querySelectorAll('.candidate-card').length;
    document.getElementById('filter-count').textContent = `Showing ${visible}/${total}`;
}

function exportDecisions() {
    const accepted = [];
    const rejected = [];

    document.querySelectorAll('.candidate-card').forEach(card => {
        const qid = parseInt(card.dataset.qid);
        const decision = decisions[card.dataset.qid];

        if (decision === 'accepted') {
            // Get raw predicted_result - try to parse as JSON if possible
            let predictedResult = card.dataset.predictedResult || '';
            try {
                predictedResult = JSON.parse(predictedResult.replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
            } catch (e) {
                // Keep as string if not parseable
            }

            accepted.push({
                question_id: qid,
                db_id: card.dataset.db,
                platinum_sql: (card.dataset.predictedSql || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
                platinum_result: predictedResult,
                reason: (card.dataset.reasoning || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            });
        } else if (decision === 'rejected') {
            rejected.push(qid);
        }
    });

    if (accepted.length === 0 && rejected.length === 0) {
        alert('No decisions to export. Click Accept or Reject on some candidates first.');
        return;
    }

    // Generate filename
    const filename = 'platinum_review_' + new Date().toISOString().slice(0,19).replace(/[:-]/g,'') + '.json';

    // Export in new format with both accepted and rejected
    const exportData = { accepted, rejected };

    // Download file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Copy CLI command to clipboard (assumes file downloaded to ~/Downloads)
    const cmd = `uv run bird-eval inspect --export ~/Downloads/${filename}`;
    navigator.clipboard.writeText(cmd).then(() => {
        alert(`Exported ${accepted.length} accepted, ${rejected.length} rejected to ${filename}\\n\\nCLI command copied to clipboard:\\n${cmd}`);
    }).catch(() => {
        alert(`Exported ${accepted.length} accepted, ${rejected.length} rejected to ${filename}\\n\\nRun this to import:\\n${cmd}`);
    });
}

function restoreDecisions() {
    Object.entries(decisions).forEach(([qid, decision]) => {
        const card = document.querySelector(`[data-qid="${qid}"]`);
        if (card && decision) {
            card.classList.add(decision);
            const header = card.querySelector('.card-header');
            const badge = document.createElement('span');
            badge.className = `decision-badge ${decision}`;
            badge.textContent = decision.toUpperCase();
            header.appendChild(badge);
        }
    });
    updateCounts();
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch(e.key) {
        case 'j':
        case 'ArrowDown':
            e.preventDefault();
            navigateNext();
            break;
        case 'k':
        case 'ArrowUp':
            e.preventDefault();
            navigatePrev();
            break;
        case 'Enter':
        case ' ':
            e.preventDefault();
            if (visibleCards[currentIndex]) {
                const body = visibleCards[currentIndex].querySelector('.card-body');
                body.classList.toggle('collapsed');
            }
            break;
        case 'a':
            if (visibleCards[currentIndex]) {
                const qid = visibleCards[currentIndex].dataset.qid;
                setDecision(qid, 'accepted');
                navigateNext();
            }
            break;
        case 'r':
            if (visibleCards[currentIndex]) {
                const qid = visibleCards[currentIndex].dataset.qid;
                setDecision(qid, 'rejected');
                navigateNext();
            }
            break;
        case 's':
            navigateNext();
            break;
        case 'e':
            expandAll();
            break;
        case 'c':
            collapseAll();
            break;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    restoreDecisions();
    applyFilters();
});
"""


def load_truth_seeker_results(filepath: Path) -> list[dict]:
    """Load truth-seeker results from JSONL file."""
    results = []
    with open(filepath) as f:
        for line in f:
            if line.strip():
                results.append(json.loads(line))
    return results


def generate_candidate_card(result: dict) -> str:
    """Generate HTML for a single platinum candidate card."""
    qid = result.get("question_id", "?")
    db_id = result.get("db_id", "unknown")
    verdict = result.get("verdict", "UNCLEAR")
    confidence = result.get("confidence", "LOW")
    recommendation = result.get("recommendation", "NEEDS_REVIEW")

    question = escape_html(result.get("question", "(question not available)"))
    evidence = escape_html(result.get("evidence") or "None")
    reasoning = escape_html(result.get("reasoning", ""))

    gold_sql = result.get("gold_sql", "")
    predicted_sql = result.get("predicted_sql", "")
    gold_result = escape_html(result.get("gold_result", "(not available)"))
    predicted_result = escape_html(result.get("predicted_result", "(not available)"))

    gold_issues = result.get("gold_issues", [])
    predicted_issues = result.get("predicted_issues", [])

    # Format SQL
    formatted_gold = escape_html(format_sql(gold_sql))
    formatted_pred = escape_html(format_sql(predicted_sql))

    # Build issues HTML
    gold_issues_html = ""
    if gold_issues:
        items = "".join(f"<li>{escape_html(issue)}</li>" for issue in gold_issues)
        gold_issues_html = f'''
        <div class="issues-section">
            <h4>Gold SQL Issues</h4>
            <ul class="issues-list">{items}</ul>
        </div>
        '''

    predicted_issues_html = ""
    if predicted_issues:
        items = "".join(f"<li>{escape_html(issue)}</li>" for issue in predicted_issues)
        predicted_issues_html = f'''
        <div class="issues-section predicted-issues">
            <h4>Predicted SQL Issues</h4>
            <ul class="issues-list">{items}</ul>
        </div>
        '''

    # Escape SQL for data attributes (replace quotes)
    predicted_sql_escaped = predicted_sql.replace('"', '&quot;').replace("'", "&#39;") if predicted_sql else ""
    predicted_result_raw = result.get("predicted_result", "")
    predicted_result_escaped = str(predicted_result_raw).replace('"', '&quot;').replace("'", "&#39;") if predicted_result_raw else ""
    reasoning_escaped = reasoning.replace('"', '&quot;').replace("'", "&#39;")

    return f'''
    <div class="candidate-card {verdict}"
         data-qid="{qid}"
         data-db="{db_id}"
         data-verdict="{verdict}"
         data-confidence="{confidence}"
         data-recommendation="{recommendation}"
         data-predicted-sql="{predicted_sql_escaped}"
         data-predicted-result="{predicted_result_escaped}"
         data-reasoning="{reasoning_escaped}">
        <div class="card-header" onclick="toggleCard(this)">
            <div>
                <span class="q-id">Q{qid}</span>
                <span class="q-db">{db_id}</span>
                <span class="verdict-badge {verdict}">{verdict}</span>
                <span class="confidence-badge {confidence}">{confidence}</span>
                <span class="recommendation-badge {recommendation}">{recommendation}</span>
            </div>
        </div>
        <div class="card-body">
            <!-- Column 1: Question & Context -->
            <div class="panel">
                <h3>Question & Context</h3>
                <div class="question-text">{question}</div>
                <h3>Evidence</h3>
                <div class="evidence">{evidence}</div>
            </div>

            <!-- Column 2: SQL Comparison -->
            <div class="panel">
                <h3>SQL Comparison</h3>
                <div class="sql-section">
                    <div class="sql-label gold">Gold SQL</div>
                    <pre class="sql">{formatted_gold}</pre>
                    <div class="result-label">Result:</div>
                    <pre class="result">{gold_result}</pre>
                </div>
                <div class="sql-section">
                    <div class="sql-label predicted">Predicted SQL</div>
                    <pre class="sql">{formatted_pred}</pre>
                    <div class="result-label">Result:</div>
                    <pre class="result">{predicted_result}</pre>
                </div>
            </div>

            <!-- Column 3: Verdict & Reasoning -->
            <div class="panel">
                <h3>Analysis</h3>
                <div class="reasoning-text">{reasoning}</div>
                {gold_issues_html}
                {predicted_issues_html}
                <div class="action-buttons">
                    <button class="accept-btn" onclick="event.stopPropagation(); setDecision('{qid}', 'accepted')">Accept</button>
                    <button class="reject-btn" onclick="event.stopPropagation(); setDecision('{qid}', 'rejected')">Reject</button>
                    <button class="skip-btn" onclick="event.stopPropagation(); setDecision('{qid}', null)">Clear</button>
                </div>
            </div>
        </div>
    </div>
    '''


def generate_platinum_report(
    results: list[dict],
    output_path: Path,
    source_file: str = "",
) -> Path:
    """Generate HTML report for platinum candidate review."""

    # Collect unique values for filters
    verdicts = sorted(set(r.get("verdict", "") for r in results))
    confidences = sorted(set(r.get("confidence", "") for r in results))
    recommendations = sorted(set(r.get("recommendation", "") for r in results))
    dbs = sorted(set(r.get("db_id", "") for r in results))

    # Build filter options
    verdict_options = '<option value="">All Verdicts</option>' + \
        "".join(f'<option value="{v}">{v}</option>' for v in verdicts)
    confidence_options = '<option value="">All Confidence</option>' + \
        "".join(f'<option value="{c}">{c}</option>' for c in confidences)
    recommendation_options = '<option value="">All Recommendations</option>' + \
        "".join(f'<option value="{r}">{r}</option>' for r in recommendations)
    db_options = '<option value="">All Databases</option>' + \
        "".join(f'<option value="{d}">{d}</option>' for d in dbs)

    # Count stats
    total = len(results)
    by_verdict = {}
    for r in results:
        v = r.get("verdict", "UNCLEAR")
        by_verdict[v] = by_verdict.get(v, 0) + 1

    stats_parts = [f"{v}: {c}" for v, c in sorted(by_verdict.items())]
    stats_text = f"Total: {total} | " + " | ".join(stats_parts)

    # Generate cards
    cards_html = "\n".join(generate_candidate_card(r) for r in results)

    html_content = f'''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Platinum Candidate Review</title>
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="header">
        <div style="display: flex; align-items: center;">
            <h1>Platinum Candidate Review</h1>
            <div class="filter-bar">
                <label>Verdict: <select id="verdict-filter" onchange="applyFilters()">{verdict_options}</select></label>
                <label>Confidence: <select id="confidence-filter" onchange="applyFilters()">{confidence_options}</select></label>
                <label>Recommendation: <select id="recommendation-filter" onchange="applyFilters()">{recommendation_options}</select></label>
                <label>Database: <select id="db-filter" onchange="applyFilters()">{db_options}</select></label>
                <label>Decision: <select id="decision-filter" onchange="applyFilters()">
                    <option value="">All</option>
                    <option value="pending">Pending</option>
                    <option value="accepted">Accepted</option>
                    <option value="rejected">Rejected</option>
                </select></label>
                <span id="filter-count" style="color: #888;">Showing {total}/{total}</span>
            </div>
        </div>
        <div class="stats">
            <span>{stats_text}</span>
            <span id="decision-counts" style="margin-left: 16px; color: #4ecca3;">Accepted: 0 | Rejected: 0</span>
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="exportDecisions()">Export Decisions</button>
        </div>
    </div>
    <div class="container">
        {cards_html}
    </div>
    <div class="nav-help">
        <kbd>j</kbd>/<kbd>↓</kbd> Next | <kbd>k</kbd>/<kbd>↑</kbd> Prev |
        <kbd>Enter</kbd>/<kbd>Space</kbd> Toggle |
        <kbd>a</kbd> Accept | <kbd>r</kbd> Reject | <kbd>s</kbd> Skip |
        <kbd>e</kbd> Expand All | <kbd>c</kbd> Collapse All
    </div>
    <script>{JS_SCRIPT}</script>
</body>
</html>'''

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(html_content)

    return output_path


def get_latest_analysis() -> Path | None:
    """Find the most recent truth-seeker analysis file."""
    analysis_dir = RESULTS_DIR / "truth_seeking"
    if not analysis_dir.exists():
        return None

    files = sorted(analysis_dir.glob("analysis_*.jsonl"), reverse=True)
    return files[0] if files else None
