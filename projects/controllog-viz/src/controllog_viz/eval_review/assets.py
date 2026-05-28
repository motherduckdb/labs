"""Inline CSS and JS for the evaluation review page (ported from the reference)."""

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
    flex-wrap: wrap;
    gap: 8px;
}
.header h1 { font-size: 14px; color: #00ff88; }
.header .stats { color: #888; }
.header button {
    background: #00ff88;
    color: #000;
    border: none;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    font-weight: bold;
    margin-left: 8px;
}
.header button:hover { background: #00cc6a; }
.stats-bar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}
.stats-bar .stat-badge {
    padding: 2px 8px;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
}
.stats-bar .stat-badge.total { background: #333; color: #e0e0e0; }
.stats-bar .stat-badge.correct { background: #00ff88; color: #000; }
.stats-bar .stat-badge.error { background: #ff4444; color: #fff; }
.stats-bar .stat-badge.hit_limit { background: #aa0000; color: #fff; }
.stats-bar .stat-badge.incorrect { background: #ff8800; color: #000; }
.stats-bar .stat-badge.partial { background: #ffff00; color: #000; }
.container { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
.question-card {
    background: #111;
    border: 1px solid #333;
    border-left: 3px solid #666;
}
.question-card.error { border-left-color: #ff4444; }
.question-card.hit_limit { border-left-color: #aa0000; }
.question-card.incorrect { border-left-color: #ff8800; }
.question-card.partial { border-left-color: #ffff00; }
.question-card.correct { border-left-color: #00ff88; }
.question-card.judge_correct { border-left-color: #00aaff; }
.question-card.hidden { display: none; }
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
.q-id { font-weight: bold; color: #00ff88; }
.q-db { color: #888; margin-left: 10px; }
.q-model { color: #00aaff; margin-left: 10px; }
.q-config { color: #ff00ff; margin-left: 10px; font-weight: bold; }
.q-level { padding: 2px 6px; font-size: 10px; font-weight: bold; }
.q-level.error { background: #ff0000; color: #fff; }
.q-level.hit_limit { background: #aa0000; color: #fff; }
.q-level.incorrect { background: #ff8800; color: #000; }
.q-level.partial { background: #ffff00; color: #000; }
.q-level.correct { background: #00ff88; color: #000; }
.q-level.judge_correct { background: #00aaff; color: #000; }
.header-category {
    display: inline-block;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    border-radius: 3px;
    margin-left: 8px;
    background: #888;
    color: #000;
}
.card-body {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1px;
    background: #333;
}
.card-body.collapsed { display: none; }
.panel {
    background: #111;
    padding: 8px;
    overflow: auto;
    max-height: 500px;
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
.evidence { color: #aaa; font-style: italic; margin-bottom: 8px; }
pre {
    background: #0a0a0a;
    padding: 6px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 10px;
    border: 1px solid #222;
}
pre.sql { color: #00ff88; }
pre.result { color: #ffaa00; }
pre.trace { color: #aaa; font-size: 10px; line-height: 1.4; }
pre.error-msg { color: #ff4444; }
.result-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.result-box { border: 1px solid #333; padding: 4px; }
.result-box.gold { border-color: #00ff88; }
.result-box.pred { border-color: #ff8800; }
.result-label { font-size: 9px; color: #666; margin-bottom: 4px; }
.metric { display: inline-block; margin-right: 16px; color: #888; }
.metric .value { color: #00ff88; font-weight: bold; }
.partial-reason { color: #ffff00; font-size: 10px; margin-top: 4px; }
.investigation-section {
    margin-bottom: 12px;
    padding: 8px;
    background: #0d1a0d;
    border: 1px solid #2a4a2a;
    border-radius: 4px;
}
.investigation-section h4 {
    color: #00ff88;
    font-size: 10px;
    text-transform: uppercase;
    margin-bottom: 6px;
}
.investigation-category {
    display: inline-block;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
    margin-bottom: 6px;
    background: #888;
    color: #000;
}
.investigation-description {
    color: #aaa;
    font-size: 10px;
    background: #0a0a0a;
    padding: 6px;
    border: 1px solid #222;
}
.comment-section {
    grid-column: 1 / -1;
    background: #0d0d1a;
    padding: 8px;
    border-top: 1px solid #333;
}
.comment-section textarea {
    width: 100%;
    background: #111;
    color: #e0e0e0;
    border: 1px solid #333;
    padding: 6px;
    font-family: inherit;
    font-size: 11px;
    resize: vertical;
    min-height: 40px;
}
.comment-section textarea:focus { outline: none; border-color: #00ff88; }
.filter-bar {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
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
/* COT Trace collapsible sections */
.cot-section {
    margin-bottom: 4px;
    border: 1px solid #333;
    background: #0d0d0d;
}
.cot-section summary {
    padding: 6px 10px;
    cursor: pointer;
    font-weight: bold;
    font-size: 10px;
    text-transform: uppercase;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
}
.cot-section summary::-webkit-details-marker { display: none; }
.cot-section summary::before {
    content: '\\25B6';
    font-size: 8px;
    transition: transform 0.2s;
}
.cot-section[open] summary::before { transform: rotate(90deg); }
.cot-section .cot-content {
    padding: 8px;
    max-height: 400px;
    overflow: auto;
}
.cot-section.system summary { color: #888; }
.cot-section.user summary { color: #00aaff; }
.cot-section.thinking summary { color: #cc88ff; }
.cot-section.tool summary { color: #ff8800; }
.cot-section.assistant summary { color: #00ff88; }
.cot-section.final summary { color: #00ff88; background: #1a2a1a; }
.tool-args-label, .tool-result-label {
    color: #666;
    font-size: 9px;
    text-transform: uppercase;
    margin-top: 8px;
    margin-bottom: 4px;
}
.tool-args-label:first-child { margin-top: 0; }
.cot-section .tool-args { color: #888; }
.cot-section .tool-result { color: #aaa; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: #111; }
::-webkit-scrollbar-thumb { background: #444; }
::-webkit-scrollbar-thumb:hover { background: #666; }
"""

JS_SCRIPT = """
let comments = {};

function toggleCard(header) {
    const body = header.nextElementSibling;
    body.classList.toggle('collapsed');
}

function expandAll() {
    document.querySelectorAll('.question-card:not(.hidden) .card-body').forEach(b => b.classList.remove('collapsed'));
}

function collapseAll() {
    document.querySelectorAll('.card-body').forEach(b => b.classList.add('collapsed'));
}

function applyFilters() {
    const statusFilter = document.getElementById('status-filter').value;
    const modelFilter = document.getElementById('model-filter').value;
    const configFilter = document.getElementById('config-filter').value;
    const categoryFilter = document.getElementById('category-filter').value;

    document.querySelectorAll('.question-card').forEach(card => {
        const status = card.dataset.status || '';
        const model = card.dataset.model || '';
        const config = card.dataset.config || '';
        const category = card.dataset.category || '';

        const statusMatch = !statusFilter || statusFilter === 'all' || status === statusFilter ||
            (statusFilter === 'errors' && (status === 'error' || status === 'incorrect' || status === 'partial' || status === 'hit_limit'));
        const modelMatch = !modelFilter || model === modelFilter;
        const configMatch = !configFilter || config === configFilter;
        const categoryMatch = !categoryFilter || category === categoryFilter;

        if (statusMatch && modelMatch && configMatch && categoryMatch) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });

    const visible = document.querySelectorAll('.question-card:not(.hidden)').length;
    const total = document.querySelectorAll('.question-card').length;
    document.getElementById('filter-count').textContent = 'Showing ' + visible + '/' + total;
}

function exportComments() {
    document.querySelectorAll('textarea[data-qid]').forEach(ta => {
        const qid = ta.dataset.qid;
        if (ta.value.trim()) {
            comments[qid] = ta.value.trim();
        }
    });

    const exportData = {
        timestamp: new Date().toISOString(),
        feedback: Object.entries(comments).map(([qid, comment]) => ({
            question_id: qid,
            comment: comment
        })).filter(f => f.comment)
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'error_feedback_' + new Date().toISOString().slice(0,19).replace(/[:-]/g,'') + '.json';
    a.click();
    URL.revokeObjectURL(url);
}

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'e') expandAll();
    if (e.key === 'c') collapseAll();
});

document.addEventListener('DOMContentLoaded', () => {
    applyFilters();
});
"""

