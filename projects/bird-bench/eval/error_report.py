"""
Evaluation Review Report Generator for BIRD-Bench.

Generates a Bloomberg-terminal style HTML report for reviewing all evaluation results.
Shows all questions with filtering by status (errors by default).

Features:
- 3-column layout: Question/Evidence, COT Trace, SQL/Results/Analysis
- Predicted vs Gold SQL and results comparison
- Full conversation trace with tool calls
- Model self-analysis for errors (via --introspect)
- Comment section for notes (exportable to JSON)

Usage:
    uv run bird-eval errors                    # From controllog events
    uv run bird-eval errors --file events.jsonl  # From specific file
"""

import json
import html
from datetime import datetime
from pathlib import Path

from eval.config import RESULTS_DIR, DEV_TABLES_FILE

# Constants
QUESTION_PREVIEW_LENGTH = 100

# Sorting order for correctness levels (errors first, then hit_limit, then incorrect, then partial, then correct/judge)
LEVEL_ORDER = {"error": 0, "hit_limit": 1, "incorrect": 2, "partial": 3, "correct": 4, "judge_correct": 4}

# HTML Templates
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
.container { display: flex; flex-direction: column; gap: 2px; padding: 8px; }
.question-card {
    background: #111;
    border: 1px solid #333;
    border-left: 3px solid #666;
}
.question-card.error { border-left-color: #ff4444; }
.question-card.incorrect { border-left-color: #ff8800; }
.question-card.partial { border-left-color: #ffff00; }
.question-card.correct { border-left-color: #00ff88; }
.question-card.judge_correct { border-left-color: #00aaff; }
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
.q-level { padding: 2px 6px; font-size: 10px; font-weight: bold; }
.q-level.error { background: #ff0000; color: #fff; }
.q-level.hit_limit { background: #aa0000; color: #fff; }
.q-level.incorrect { background: #ff8800; color: #000; }
.q-level.partial { background: #ffff00; color: #000; }
.q-level.correct { background: #00ff88; color: #000; }
.q-level.judge_correct { background: #00aaff; color: #000; }
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
.schema-compact { font-size: 9px; color: #666; }
.partial-reason { color: #ffff00; font-size: 10px; margin-top: 4px; }
.metric { display: inline-block; margin-right: 16px; color: #888; }

/* Investigation section styles */
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
}
.investigation-category.HIT_ITERATION_LIMIT { background: #ff0000; color: #fff; }
.investigation-category.BAD_JOIN { background: #ff4444; color: #000; }
.investigation-category.WRONG_TABLES { background: #ff8800; color: #000; }
.investigation-category.MISSING_COLUMNS { background: #ffaa00; color: #000; }
.investigation-category.DISTINCT { background: #00aaff; color: #000; }
.investigation-category.SEMANTIC_MISUNDERSTANDING { background: #cc88ff; color: #000; }
.investigation-category.OTHER { background: #888; color: #000; }
.investigation-category.FAILED_TO_PARSE { background: #666; color: #fff; }
/* Header category badges (same colors as investigation) */
.header-category {
    display: inline-block;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    border-radius: 3px;
    margin-left: 8px;
}
.header-category.HIT_ITERATION_LIMIT { background: #ff0000; color: #fff; }
.header-category.BAD_JOIN { background: #ff4444; color: #000; }
.header-category.WRONG_TABLES { background: #ff8800; color: #000; }
.header-category.MISSING_COLUMNS { background: #ffaa00; color: #000; }
.header-category.DISTINCT { background: #00aaff; color: #000; }
.header-category.SEMANTIC_MISUNDERSTANDING { background: #cc88ff; color: #000; }
.header-category.OTHER { background: #888; color: #000; }
.header-category.FAILED_TO_PARSE { background: #666; color: #fff; }
.investigation-short { color: #aaa; font-style: italic; margin-bottom: 6px; }
.investigation-detail {
    color: #888;
    font-size: 10px;
    background: #0a0a0a;
    padding: 6px;
    border: 1px solid #222;
    max-height: 150px;
    overflow-y: auto;
}
.investigation-fix {
    color: #00ff88;
    font-size: 10px;
    background: #0a1a0a;
    padding: 6px;
    border: 1px solid #2a4a2a;
    margin-top: 6px;
}
.investigation-fix-label {
    color: #00ff88;
    font-weight: bold;
    font-size: 9px;
    text-transform: uppercase;
    margin-bottom: 4px;
}
.iteration-limit-badge {
    background: #ff0000;
    color: #fff;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    margin-left: 8px;
}
/* Judge section styles */
.judge-section {
    margin-bottom: 12px;
    padding: 8px;
    background: #0d0d1a;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
}
.judge-section h4 {
    color: #00aaff;
    font-size: 10px;
    text-transform: uppercase;
    margin-bottom: 6px;
}
.judge-verdict {
    display: inline-block;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: bold;
    border-radius: 3px;
    margin-bottom: 6px;
}
.judge-verdict.PREDICTED_CORRECT { background: #00ff88; color: #000; }
.judge-verdict.BOTH_CORRECT { background: #00ff88; color: #000; }
.judge-verdict.GOLD_CORRECT { background: #ffaa00; color: #000; }
.judge-verdict.BOTH_WRONG { background: #ff4444; color: #fff; }
.judge-verdict.UNCLEAR { background: #888; color: #000; }
.judge-confidence { color: #888; font-size: 10px; margin-left: 8px; }
.judge-reasoning {
    color: #aaa;
    font-size: 10px;
    background: #0a0a0a;
    padding: 6px;
    border: 1px solid #222;
    margin-top: 6px;
    max-height: 150px;
    overflow-y: auto;
}
/* Partial badge styles */
.partial-badge {
    display: inline-block;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: bold;
    border-radius: 3px;
    margin-left: 4px;
}
.partial-badge.accepted { background: #00ff88; color: #000; }
.partial-badge.unaccepted { background: #ff8800; color: #000; }
.metric .value { color: #00ff88; font-weight: bold; }
.q-config { color: #ff00ff; margin-left: 10px; font-weight: bold; }
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
.question-card.hidden { display: none; }

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
    content: '▶';
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
.cot-section.iteration-warning summary { color: #ff0000; background: #2a1a1a; font-weight: bold; }
.cot-section.iteration-warning { border-color: #ff4444; }
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
    document.querySelectorAll('.card-body').forEach(b => b.classList.remove('collapsed'));
}

function collapseAll() {
    document.querySelectorAll('.card-body').forEach(b => b.classList.add('collapsed'));
}

function saveComment(qid, value) {
    comments[qid] = value;
}

function applyFilters() {
    const runFilter = document.getElementById('run-filter').value;
    const modelFilter = document.getElementById('model-filter').value;
    const configFilter = document.getElementById('config-filter').value;
    const statusFilter = document.getElementById('status-filter').value;

    document.querySelectorAll('.question-card').forEach(card => {
        const runid = card.dataset.runid || '';
        const model = card.dataset.model || '';
        const config = card.dataset.config || '';
        const status = card.dataset.status || '';

        const runMatch = !runFilter || runid === runFilter;
        const modelMatch = !modelFilter || model === modelFilter;
        const configMatch = !configFilter || config === configFilter;
        const statusMatch = !statusFilter || statusFilter === 'all' || status === statusFilter ||
            (statusFilter === 'errors' && (status === 'error' || status === 'incorrect' || status === 'partial'));

        if (runMatch && modelMatch && configMatch && statusMatch) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });

    // Update visible count
    const visible = document.querySelectorAll('.question-card:not(.hidden)').length;
    const total = document.querySelectorAll('.question-card').length;
    document.getElementById('filter-count').textContent = `Showing ${visible}/${total}`;
}

function exportComments() {
    document.querySelectorAll('textarea[id^="comment-"]').forEach(ta => {
        const qid = ta.id.replace('comment-', '');
        if (ta.value.trim()) {
            comments[qid] = ta.value.trim();
        }
    });

    const exportData = {
        timestamp: new Date().toISOString(),
        source_file: "{events_file}",
        feedback: Object.entries(comments).map(([qid, comment]) => ({
            question_id: parseInt(qid),
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

// Keyboard shortcuts: 'e' to expand, 'k' to collapse
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'e') expandAll();
    if (e.key === 'k') collapseAll();
});

// Apply default filter on page load
document.addEventListener('DOMContentLoaded', () => {
    applyFilters();
});
"""


def escape_html(text: str) -> str:
    """HTML escape text safely."""
    if text is None:
        return ""
    return html.escape(str(text))


def _issue_sort_key(issue: dict) -> tuple:
    """Sort key for issues: errors first, then incorrect, then partial, then by question ID."""
    payload = issue.get("payload_json", {})
    level = payload.get("correctness_level", "")
    return (LEVEL_ORDER.get(level, 3), payload.get("question_id", 0))


def extract_from_response(response: list) -> dict:
    """
    Extract question, evidence, and predicted SQL from the response messages.
    Builds HTML with collapsible sections for COT trace.

    Sections (in order as they appear):
    - System prompt: collapsed by default
    - User prompt: EXPANDED by default (unique question info)
    - Thinking: collapsed, each block separate
    - Tool calls: collapsed, call + result combined in same section
    - Final answer: EXPANDED by default
    """
    result = {
        "question": "",
        "evidence": "",
        "predicted_sql": "",
        "cot_trace_html": "",
    }

    if not response or not isinstance(response, list):
        result["cot_trace_html"] = '<div class="cot-section"><summary>No trace available</summary></div>'
        return result

    # Build HTML sections in order as we process messages
    html_parts = []
    thinking_count = 0
    tool_call_count = 0
    response_number = 0  # Track API response/iteration number

    # Track pending tool calls (to match with results) - keyed by id AND by index order
    pending_tool_calls = {}  # id -> {name, args, response_num, position, total_in_response}
    pending_tool_calls_order = []  # list of ids in order

    for msg in response:
        if not isinstance(msg, dict):
            continue

        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "system":
            # System prompt - collapsed
            if content:
                html_parts.append(f'''<details class="cot-section system">
<summary>SYSTEM PROMPT ({len(content)} chars)</summary>
<div class="cot-content"><pre>{escape_html(content)}</pre></div>
</details>''')

        elif role == "user":
            # Check for iteration countdown warning
            if content and "tool call" in content.lower() and "remaining" in content.lower():
                html_parts.append(f'''<details class="cot-section iteration-warning">
<summary>⚠️ ITERATION WARNING</summary>
<div class="cot-content"><pre>{escape_html(content)}</pre></div>
</details>''')
                continue

            # Parse question and evidence
            if content and "**Question:**" in content:
                q_start = content.find("**Question:**")
                q_end = content.find("**Hints:**", q_start)
                if q_start != -1:
                    q_text = content[q_start + len("**Question:**"):q_end if q_end != -1 else len(content)]
                    result["question"] = q_text.strip()
                if q_end != -1:
                    h_end = content.find("\n\nHints define", q_end)
                    h_text = content[q_end + len("**Hints:**"):h_end if h_end != -1 else len(content)]
                    result["evidence"] = h_text.strip()

            # User prompt - EXPANDED
            if content:
                html_parts.append(f'''<details class="cot-section user" open>
<summary>USER PROMPT</summary>
<div class="cot-content"><pre>{escape_html(content)}</pre></div>
</details>''')

        elif role == "assistant":
            # Check for explicit thinking field (used by some models like Gemini)
            thinking = msg.get("thinking")
            if thinking and thinking.strip():
                thinking_count += 1
                html_parts.append(f'''<details class="cot-section thinking">
<summary>THINKING #{thinking_count}</summary>
<div class="cot-content"><pre>{escape_html(thinking)}</pre></div>
</details>''')

            # Check for thinking/reasoning in content (before tool calls)
            if content and content.strip():
                # Check if this is the final answer
                if "FINAL_SQL:" in content:
                    # Extract SQL
                    sql_start = content.find("```sql")
                    sql_end = content.find("```", sql_start + 6)
                    if sql_start != -1 and sql_end != -1:
                        result["predicted_sql"] = content[sql_start + 6:sql_end].strip()

                    # Final answer - EXPANDED
                    html_parts.append(f'''<details class="cot-section final" open>
<summary>FINAL ANSWER</summary>
<div class="cot-content"><pre>{escape_html(content)}</pre></div>
</details>''')
                else:
                    # This is thinking/reasoning in content - collapsed
                    thinking_count += 1
                    html_parts.append(f'''<details class="cot-section thinking">
<summary>THINKING #{thinking_count}</summary>
<div class="cot-content"><pre>{escape_html(content)}</pre></div>
</details>''')

            # Store tool calls (don't emit HTML yet - wait for results)
            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                response_number += 1  # New API response with tool calls
            total_in_response = len(tool_calls)
            for position, tc in enumerate(tool_calls):
                func_name = tc.get("name", "unknown")
                tc_id = tc.get("id", str(len(pending_tool_calls_order)))
                args = tc.get("arguments", "{}")

                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, ValueError):
                        pass
                args_str = json.dumps(args, indent=2) if isinstance(args, dict) else str(args)

                # Store for matching with result (include response tracking for labeling)
                pending_tool_calls[tc_id] = {
                    "name": func_name,
                    "args": args_str,
                    "response_num": response_number,
                    "position": position,
                    "total_in_response": total_in_response,
                }
                pending_tool_calls_order.append(tc_id)

        elif role == "tool":
            tool_call_id = msg.get("tool_call_id", "")
            tool_name = msg.get("tool_name", msg.get("name", "unknown"))
            tool_result = msg.get("result", msg.get("content", {}))

            # Format result
            if isinstance(tool_result, dict):
                result_content = tool_result.get("result", tool_result)
                if isinstance(result_content, str):
                    try:
                        result_content = json.loads(result_content)
                    except (json.JSONDecodeError, ValueError):
                        pass
                result_str = json.dumps(result_content, indent=2) if isinstance(result_content, (dict, list)) else str(result_content)
            else:
                result_str = str(tool_result)

            # Find the matching tool call and emit combined section
            tc_info = None
            if tool_call_id and tool_call_id in pending_tool_calls:
                tc_info = pending_tool_calls.pop(tool_call_id)
                if tool_call_id in pending_tool_calls_order:
                    pending_tool_calls_order.remove(tool_call_id)
            elif pending_tool_calls_order:
                # Fall back to first pending call (order-based matching)
                first_id = pending_tool_calls_order.pop(0)
                tc_info = pending_tool_calls.pop(first_id, None)

            tool_call_count += 1
            if tc_info:
                # Generate label: use "3a", "3b" if multiple tool calls per response
                resp_num = tc_info.get("response_num", tool_call_count)
                total = tc_info.get("total_in_response", 1)
                pos = tc_info.get("position", 0)
                if total > 1:
                    suffix = chr(ord('a') + pos)  # 0->a, 1->b, 2->c, etc.
                    label = f"{resp_num}{suffix}"
                else:
                    label = str(resp_num)

                # Combined tool call + result
                html_parts.append(f'''<details class="cot-section tool">
<summary>TOOL CALL #{label} - {escape_html(tc_info["name"])}</summary>
<div class="cot-content">
<div class="tool-args-label">Arguments:</div>
<pre class="tool-args">{escape_html(tc_info["args"])}</pre>
<div class="tool-result-label">Result:</div>
<pre class="tool-result">{escape_html(result_str)}</pre>
</div>
</details>''')
            else:
                # Standalone tool result (no matching call found)
                tool_call_count += 1
                html_parts.append(f'''<details class="cot-section tool">
<summary>TOOL RESULT - {escape_html(tool_name)}</summary>
<div class="cot-content">
<pre class="tool-result">{escape_html(result_str)}</pre>
</div>
</details>''')

    result["cot_trace_html"] = "\n".join(html_parts) if html_parts else '<div class="cot-section">No trace available</div>'
    return result


def get_database_config_name(database: str) -> str:
    """Map database name to config label (A/B/C)."""
    if "bird_bench_a" in database:
        return "A"
    elif "bird_bench_b" in database:
        return "B"
    elif "bird_bench_c" in database:
        return "C"
    return "?"


def load_events_from_controllog(events_file: Path) -> tuple[list[dict], dict, dict]:
    """
    Load model completion events, error investigations, and judge results from controllog JSONL.

    Returns:
        Tuple of (model_completion events, investigation map, judge map)
        Investigation map is keyed by (run_id, question_id, model) -> investigation payload
        Judge map is keyed by (run_id, question_id) -> judge payload
    """
    events = []
    investigations = {}
    judge_results = {}

    with open(events_file) as f:
        for line in f:
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("kind") == "model_completion":
                # Only include evaluation completions (have question_id)
                # Filter out error investigation API calls (no question_id)
                payload = event.get("payload_json", {})
                if payload.get("question_id") is not None:
                    events.append(event)
            elif event.get("kind") == "error_investigation":
                payload = event.get("payload_json", {})
                run_id = event.get("run_id")  # Use event's run_id to scope investigations
                key = (run_id, payload.get("question_id"), payload.get("model"))
                investigations[key] = payload
            elif event.get("kind") == "llm_judge":
                payload = event.get("payload_json", {})
                run_id = event.get("run_id")
                key = (run_id, payload.get("question_id"))
                judge_results[key] = payload

    return events, investigations, judge_results


def load_schema_info(db_id: str) -> str:
    """Load schema info for a database."""
    if not DEV_TABLES_FILE.exists():
        return "Schema not available"

    with open(DEV_TABLES_FILE) as f:
        all_tables = json.load(f)

    for db in all_tables:
        if db.get("db_id") != db_id:
            continue

        tables = db.get("table_names_original", [])
        columns = db.get("column_names_original", [])
        schema_lines = []
        for i, table in enumerate(tables):
            cols = [c[1] for c in columns if c[0] == i]
            schema_lines.append(f"{table}: {', '.join(cols)}")
        return "\n".join(schema_lines)

    return "Schema not available"


def generate_error_report(
    events_file: Path | None = None,
    output_file: Path | None = None,
    run_id: str | None = None,
) -> Path | None:
    """
    Generate Bloomberg-style HTML error analysis report.

    Args:
        events_file: Path to controllog events.jsonl (default: latest in RESULTS_DIR)
        output_file: Output HTML path (default: auto-generated)
        run_id: Filter to specific run_id (default: all runs, or latest if specified as "latest")

    Returns:
        Path to generated report, or None if no errors found
    """
    # Find events file
    if events_file is None:
        events_file = RESULTS_DIR / "controllog" / "events.jsonl"

    if not events_file.exists():
        print(f"Events file not found: {events_file}")
        return None

    # Load events, investigations, and judge results
    events, investigations, judge_results = load_events_from_controllog(events_file)
    if not events:
        print("No model completion events found")
        return None

    # Get all run_ids and find the latest one
    all_run_ids = set(e.get("run_id") for e in events if e.get("run_id"))
    latest_run_id = None
    if events:
        # Events are in chronological order, last one has the latest run_id
        for e in reversed(events):
            if e.get("run_id"):
                latest_run_id = e.get("run_id")
                break

    # Filter by run_id if specified
    if run_id == "latest" and latest_run_id:
        run_id = latest_run_id
        print(f"Filtering to latest run: {run_id[:8]}...")

    if run_id:
        events = [e for e in events if e.get("run_id") == run_id]
        if not events:
            print(f"No events found for run_id: {run_id}")
            return None

    # Use ALL events (not just failures) - filter in UI
    all_events = events

    # Sort by correctness level (errors first, then incorrect, then partial, then correct)
    all_events.sort(key=_issue_sort_key)

    # Count by level
    # Error includes both model errors (success=False) and SQL execution errors (correctness_level="error")
    error_count = len([i for i in all_events if (
        not i.get("payload_json", {}).get("success", True) or
        i.get("payload_json", {}).get("correctness_level") == "error"
    )])
    hit_limit_count = len([i for i in all_events if i.get("payload_json", {}).get("correctness_level") == "hit_limit"])
    incorrect_count = len([i for i in all_events if i.get("payload_json", {}).get("correctness_level") == "incorrect"])
    partial_count = len([i for i in all_events if i.get("payload_json", {}).get("correctness_level") == "partial"])
    correct_count = len([i for i in all_events if i.get("payload_json", {}).get("correctness_level") == "correct"])
    judge_correct_count = len([i for i in all_events if i.get("payload_json", {}).get("correctness_level") == "judge_correct"])
    # Count by match source for correct answers
    platinum_count = len([i for i in all_events if i.get("payload_json", {}).get("match_source") == "platinum"])

    # Partial breakdown: accepted (1 point) vs unaccepted (0 points)
    accepted_partial_prefixes = ("extra_columns", "extra_duplicates", "implicit_distinct", "aggregated_equivalent")
    partial_accepted_count = len([
        i for i in all_events
        if i.get("payload_json", {}).get("correctness_level") == "partial"
        and any(i.get("payload_json", {}).get("partial_reason", "").startswith(p) for p in accepted_partial_prefixes)
    ])
    partial_unaccepted_count = partial_count - partial_accepted_count

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Collect unique models, configs, and run_ids for filters
    models = set()
    configs = set()
    run_ids = set()
    run_timestamps = {}  # Map run_id to earliest event_time
    for e in all_events:
        if e.get("run_id"):
            rid = e.get("run_id")
            run_ids.add(rid)
            # Track earliest timestamp for each run
            event_time = e.get("event_time", "")
            if rid not in run_timestamps or event_time < run_timestamps[rid]:
                run_timestamps[rid] = event_time
        payload = e.get("payload_json", {})
        model = payload.get("model", "unknown")
        models.add(model.split("/")[-1])  # Short name
        # Get database config from exchange_id or database field
        exchange_id = payload.get("exchange_id", "")
        database = payload.get("database", "")
        config_type = payload.get("config_type", "")
        if config_type:
            configs.add(config_type.upper() if len(config_type) == 1 else config_type[0].upper())
        elif "bird_bench_a" in exchange_id or "bird_bench_a" in database:
            configs.add("A")
        elif "bird_bench_b" in exchange_id or "bird_bench_b" in database:
            configs.add("B")
        elif "bird_bench_c" in exchange_id or "bird_bench_c" in database:
            configs.add("C")

    if output_file is None:
        output_file = RESULTS_DIR / f"error_analysis_{timestamp}.html"

    # Build filter options
    model_options = "".join(f'<option value="{m}">{m}</option>' for m in sorted(models))
    config_options = "".join(f'<option value="{c}">Config {c}</option>' for c in sorted(configs))

    # Format run timestamps for display (sort by timestamp descending - newest first)
    def format_run_timestamp(rid: str) -> str:
        ts = run_timestamps.get(rid, "")
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                return dt.strftime("%b %d %H:%M")  # e.g., "Jan 30 14:25"
            except (ValueError, AttributeError):
                pass
        return rid[:8] + "..."

    sorted_runs = sorted(run_ids, key=lambda r: run_timestamps.get(r, ""), reverse=True)
    latest_run = sorted_runs[0] if sorted_runs else None
    run_options = "".join(
        f'<option value="{r}"{" selected" if r == latest_run else ""}>{format_run_timestamp(r)}</option>'
        for r in sorted_runs
    )

    # Show run info
    if run_id:
        run_display = format_run_timestamp(run_id)
        run_info = f" | run: {run_display}"
    else:
        run_info = f" | {len(run_ids)} runs"

    # Build HTML using templates
    # Build detailed correct breakdown
    gold_count = correct_count - platinum_count  # correct without platinum match_source
    correct_detail = f"{correct_count} correct"
    if platinum_count > 0 or judge_correct_count > 0:
        parts = []
        if gold_count > 0:
            parts.append(f"{gold_count} gold")
        if platinum_count > 0:
            parts.append(f"{platinum_count} platinum")
        if judge_correct_count > 0:
            parts.append(f"{judge_correct_count} judge")
        correct_detail = f"{correct_count + judge_correct_count} correct ({', '.join(parts)})"

    # Build partial detail
    partial_detail = f"{partial_count} partial"
    if partial_count > 0:
        partial_detail = f"{partial_count} partial ({partial_accepted_count} accepted, {partial_unaccepted_count} unaccepted)"

    stats_text = f"{len(all_events)} total | {correct_detail} | {error_count} errors | {hit_limit_count} hit limit | {incorrect_count} incorrect | {partial_detail}{run_info}"

    html_content = f'''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Error Analysis - {timestamp}</title>
    <style>{CSS_STYLES}</style>
</head>
<body>
    <div class="header">
        <h1>BIRD-BENCH EVALUATION REVIEW</h1>
        <div class="stats">{stats_text}</div>
        <div class="filter-bar">
            <label>Run:</label>
            <select id="run-filter" onchange="applyFilters()">
                <option value="">All runs</option>
                {run_options}
            </select>
            <label>Model:</label>
            <select id="model-filter" onchange="applyFilters()">
                <option value="">All</option>
                {model_options}
            </select>
            <label>Config:</label>
            <select id="config-filter" onchange="applyFilters()">
                <option value="">All</option>
                {config_options}
            </select>
            <label>Status:</label>
            <select id="status-filter" onchange="applyFilters()">
                <option value="errors" selected>Errors Only</option>
                <option value="all">All</option>
                <option value="correct">Correct (Gold/Platinum)</option>
                <option value="judge_correct">Correct (Judge)</option>
                <option value="incorrect">Incorrect</option>
                <option value="partial">Partial</option>
                <option value="error">Error</option>
            </select>
            <span id="filter-count" style="color: #888;"></span>
        </div>
        <div>
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="exportComments()">Export Comments</button>
        </div>
    </div>

    <div class="container">
'''

    for idx, event in enumerate(all_events):
        payload = event.get("payload_json", {})
        event_run_id = event.get("run_id", "")

        # Get basic fields
        qid = payload.get("question_id", idx)
        db_id = payload.get("db_id", "unknown")
        model = payload.get("model", "unknown")
        model_short = model.split("/")[-1]
        error = payload.get("error")
        success = payload.get("success", True)
        correctness_level = payload.get("correctness_level", "")
        partial_reason = payload.get("partial_reason", "")
        hit_iteration_limit = payload.get("hit_iteration_limit", False)
        cost_usd = payload.get("cost_usd", 0) or 0
        duration_ms = payload.get("duration_ms", 0) or 0

        # Determine database config (A/B/C)
        exchange_id = payload.get("exchange_id", "")
        database = payload.get("database", "")
        config_type = payload.get("config_type", "")
        if config_type:
            config_label = config_type.upper() if len(config_type) == 1 else config_type[0].upper()
        elif "bird_bench_a" in exchange_id or "bird_bench_a" in database:
            config_label = "A"
        elif "bird_bench_b" in exchange_id or "bird_bench_b" in database:
            config_label = "B"
        elif "bird_bench_c" in exchange_id or "bird_bench_c" in database:
            config_label = "C"
        else:
            config_label = "?"

        # Look up investigation results if available (scoped to this run)
        investigation = investigations.get((event_run_id, qid, model_short)) or investigations.get((event_run_id, qid, model))

        # Try new format first, fall back to extracting from response
        question = payload.get("question", "")
        evidence = payload.get("evidence", "")
        gold_sql = payload.get("gold_sql", "")
        predicted_sql = payload.get("predicted_sql", "")
        gold_result = payload.get("gold_result", [])
        predicted_result = payload.get("predicted_result", [])
        raw_response = payload.get("raw_response", {})

        # Extract COT trace from raw_response (new format: {"messages": [...]})
        cot_trace_html = ""

        # New format: raw_response is a dict with "messages" key
        if isinstance(raw_response, dict) and "messages" in raw_response:
            messages = raw_response.get("messages", [])
            if messages:
                extracted = extract_from_response(messages)
                if not question:
                    question = extracted["question"]
                if not evidence:
                    evidence = extracted["evidence"]
                if not predicted_sql:
                    predicted_sql = extracted["predicted_sql"]
                cot_trace_html = extracted["cot_trace_html"]

        # Fall back to old format 'response' field
        if not cot_trace_html:
            response = payload.get("response", [])
            if response:
                extracted = extract_from_response(response)
                if not question:
                    question = extracted["question"]
                if not evidence:
                    evidence = extracted["evidence"]
                if not predicted_sql:
                    predicted_sql = extracted["predicted_sql"]
                cot_trace_html = extracted["cot_trace_html"]

        # Try reasoning field
        if not cot_trace_html:
            reasoning = payload.get("reasoning", [])
            if reasoning:
                extracted = extract_from_response(reasoning)
                cot_trace_html = extracted["cot_trace_html"]

        if not cot_trace_html:
            cot_trace_html = '<div class="cot-section">No trace available</div>'

        # Determine card type
        match_source = payload.get("match_source", "")
        if error or not success:
            level = "error"
            level_display = "ERROR"
        elif correctness_level == "hit_limit":
            level = "hit_limit"
            level_display = "HIT LIMIT"
        elif correctness_level == "error":
            # SQL execution error (model succeeded but SQL failed)
            level = "error"
            level_display = "ERROR"
        elif correctness_level == "judge_correct":
            level = "judge_correct"
            level_display = "CORRECT (JUDGE)"
        elif correctness_level == "correct":
            level = "correct"
            # Show match source (gold/platinum)
            if match_source == "platinum":
                level_display = "CORRECT (PLATINUM)"
            else:
                level_display = "CORRECT (GOLD)"
        elif correctness_level == "partial":
            level = "partial"
            level_display = "PARTIAL"
        elif correctness_level == "incorrect":
            level = "incorrect"
            level_display = "INCORRECT"
        else:
            # Unknown level - fallback
            level = "incorrect"
            level_display = "INCORRECT"

        # Format results
        gold_str = json.dumps(gold_result, indent=2) if gold_result else "Not available"
        if isinstance(predicted_result, str) and "ERROR" in predicted_result:
            pred_str = predicted_result
            pred_class = "error-msg"
        else:
            pred_str = json.dumps(predicted_result, indent=2) if predicted_result else "Not available"
            pred_class = "result"

        gold_rows = len(gold_result) if isinstance(gold_result, list) else "?"
        pred_rows = len(predicted_result) if isinstance(predicted_result, list) else "?"

        # Get schema
        schema_info = load_schema_info(db_id)

        # Build partial reason section with accepted/unaccepted badge
        partial_section = ""
        if partial_reason:
            is_accepted = any(partial_reason.startswith(p) for p in accepted_partial_prefixes)
            badge_class = "accepted" if is_accepted else "unaccepted"
            badge_text = "1 pt" if is_accepted else "0 pts"
            partial_section = f'<div class="partial-reason">Partial reason: {escape_html(partial_reason)} <span class="partial-badge {badge_class}">{badge_text}</span></div>'

        # Look up judge results if available (scoped to this run)
        judge = judge_results.get((event_run_id, qid))

        # Build judge section if available
        judge_section = ""
        if judge:
            verdict = judge.get("verdict", "UNKNOWN")
            confidence = judge.get("confidence", "")
            reasoning = judge.get("reasoning", "")
            approved = judge.get("approved", False)
            judge_section = f'''
                    <div class="judge-section">
                        <h4>LLM Judge Analysis</h4>
                        <span class="judge-verdict {escape_html(verdict)}">{escape_html(verdict)}</span>
                        <span class="judge-confidence">({escape_html(confidence)} confidence)</span>
                        <div class="judge-reasoning">{escape_html(reasoning)}</div>
                    </div>'''

        # Build investigation section if available
        investigation_section = ""
        inv_category = None  # Track for header badge
        if investigation:
            inv_category = investigation.get("category", "OTHER")
            inv_short = investigation.get("short_description", "")
            inv_detail = investigation.get("detailed_description", "")
            inv_fix = investigation.get("fix", "")
            fix_html = ""
            if inv_fix:
                fix_html = f'''
                        <div class="investigation-fix">
                            <div class="investigation-fix-label">Suggested Fix</div>
                            {escape_html(inv_fix)}
                        </div>'''
            investigation_section = f'''
                    <div class="investigation-section">
                        <h4>Model Self-Analysis</h4>
                        <span class="investigation-category {escape_html(inv_category)}">{escape_html(inv_category)}</span>
                        <div class="investigation-short">{escape_html(inv_short)}</div>
                        <div class="investigation-detail">{escape_html(inv_detail)}</div>{fix_html}
                    </div>'''

        # Question preview
        question_preview = question[:QUESTION_PREVIEW_LENGTH] if question else "(no question)"

        html_content += f'''
        <div class="question-card {level}" data-qid="{qid}" data-model="{escape_html(model_short)}" data-config="{config_label}" data-runid="{event_run_id}" data-status="{level}">
            <div class="card-header" onclick="toggleCard(this)">
                <div>
                    <span class="q-id">Q{qid}</span>
                    <span class="q-db">{escape_html(db_id)}</span>
                    <span class="q-config">[{config_label}]</span>
                    <span class="q-model">{escape_html(model_short)}</span>
                </div>
                <div style="flex: 1; margin: 0 20px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    {escape_html(question_preview)}...
                </div>
                <div>
                    <span class="metric">$<span class="value">{cost_usd:.4f}</span></span>
                    <span class="metric"><span class="value">{duration_ms}</span>ms</span>
                </div>
                <span class="q-level {level}">{level_display}</span>{f'<span class="header-category {escape_html(inv_category)}">{escape_html(inv_category)}</span>' if inv_category else ''}
            </div>
            <div class="card-body collapsed">
                <div class="panel">
                    <h3>Question & Evidence</h3>
                    <div class="question-text">{escape_html(question) if question else 'Not available'}</div>
                    <div class="evidence">Hints: {escape_html(evidence) if evidence else 'None'}</div>
                    {partial_section}

                    <h3 style="margin-top: 12px;">Schema ({escape_html(db_id)})</h3>
                    <pre class="schema-compact">{escape_html(schema_info)}</pre>
                </div>

                <div class="panel">
                    <h3>Chain of Thought Trace</h3>
                    {cot_trace_html}
                </div>

                <div class="panel">
                    {judge_section}
                    {investigation_section}
                    <h3>SQL Comparison</h3>
                    <div style="margin-bottom: 8px;">
                        <div class="result-label">PREDICTED SQL:</div>
                        <pre class="sql">{escape_html(predicted_sql) if predicted_sql else 'No SQL generated'}</pre>
                    </div>
                    <div>
                        <div class="result-label">GOLD SQL:</div>
                        <pre class="sql">{escape_html(gold_sql) if gold_sql else 'Not available'}</pre>
                    </div>

                    <h3 style="margin-top: 12px;">Results</h3>
                    <div class="result-compare">
                        <div class="result-box pred">
                            <div class="result-label">PREDICTED ({pred_rows} rows)</div>
                            <pre class="{pred_class}">{escape_html(pred_str)}</pre>
                        </div>
                        <div class="result-box gold">
                            <div class="result-label">GOLD ({gold_rows} rows)</div>
                            <pre class="result">{escape_html(gold_str)}</pre>
                        </div>
                    </div>
                </div>

                <div class="comment-section">
                    <h3>Analysis Notes</h3>
                    <textarea
                        id="comment-{qid}"
                        placeholder="Add notes about this failure pattern, potential fixes, or prompt improvements..."
                        onchange="saveComment('{qid}', this.value)"
                    ></textarea>
                </div>
            </div>
        </div>
'''

    # Add footer with JavaScript
    js_with_events_file = JS_SCRIPT.replace("{events_file}", escape_html(str(events_file)))
    html_content += f'''
    </div>

    <script>{js_with_events_file}</script>
</body>
</html>
'''

    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, 'w') as f:
        f.write(html_content)

    print(f"Generated error analysis report: {output_file}")
    total_correct = correct_count + judge_correct_count
    correct_breakdown = f"{total_correct} correct"
    if platinum_count > 0 or judge_correct_count > 0:
        parts = []
        if gold_count > 0:
            parts.append(f"{gold_count} gold")
        if platinum_count > 0:
            parts.append(f"{platinum_count} platinum")
        if judge_correct_count > 0:
            parts.append(f"{judge_correct_count} judge")
        correct_breakdown = f"{total_correct} correct ({', '.join(parts)})"
    partial_breakdown = f"{partial_count} partial"
    if partial_count > 0:
        partial_breakdown = f"{partial_count} partial ({partial_accepted_count}+, {partial_unaccepted_count}-)"
    print(f"  {len(all_events)} total ({correct_breakdown}, {error_count} errors, {hit_limit_count} hit limit, {incorrect_count} incorrect, {partial_breakdown})")
    return output_file


if __name__ == "__main__":
    import sys

    events_file = None
    if len(sys.argv) > 1:
        events_file = Path(sys.argv[1])

    generate_error_report(events_file)
