#!/usr/bin/env python3
"""
Error Analysis Report Generator

Generates a Bloomberg-terminal style HTML report for reviewing evaluation errors.
Shows partial/incorrect/error results with full context for manual tuning.

Usage:
    uv run python src/error_analysis.py data/results/results_*.json
    uv run python src/error_analysis.py  # Uses most recent results file
"""

import json
import sys
from pathlib import Path
from datetime import datetime
import html

def load_results(filepath: Path) -> dict:
    """Load results from JSON file."""
    with open(filepath) as f:
        return json.load(f)

def load_prompt_templates() -> tuple[str, str]:
    """Load the system and user prompt templates."""
    prompts_dir = Path(__file__).parent.parent / "prompts"
    sys_prompt = ""
    user_prompt = ""

    sys_file = prompts_dir / "system_prompt.md"
    if sys_file.exists():
        sys_prompt = sys_file.read_text()

    user_file = prompts_dir / "user_prompt.md"
    if user_file.exists():
        user_prompt = user_file.read_text()

    return sys_prompt, user_prompt

def load_schema_info(db_id: str) -> str:
    """Load schema info for a database."""
    # Try to get from dev_tables.json
    tables_file = Path("mini_dev_data/MINIDEV/dev_tables.json")
    if tables_file.exists():
        with open(tables_file) as f:
            all_tables = json.load(f)
        for db in all_tables:
            if db.get("db_id") == db_id:
                tables = db.get("table_names_original", [])
                columns = db.get("column_names_original", [])
                # Format as compact schema
                schema_lines = []
                for i, table in enumerate(tables):
                    cols = [c[1] for c in columns if c[0] == i]
                    schema_lines.append(f"{table}: {', '.join(cols)}")
                return "\n".join(schema_lines)
    return "Schema not available"

def escape(text: str) -> str:
    """HTML escape text."""
    if text is None:
        return ""
    return html.escape(str(text))

def generate_html_report(results_file: Path, output_file: Path = None):
    """Generate the error analysis HTML report."""

    data = load_results(results_file)
    results = data.get("results", [])
    model_name = data.get("model", "Unknown")
    timestamp = data.get("timestamp", "")

    # Load prompt templates for showing the request
    sys_prompt_template, user_prompt_template = load_prompt_templates()

    # Filter to errors/partials/incorrect only
    issues = [r for r in results if r.get("correctness_level") in ("error", "partial", "incorrect")]

    if not issues:
        print("No errors or partials found!")
        return

    # Sort by correctness level (errors first, then incorrect, then partial)
    level_order = {"error": 0, "incorrect": 1, "partial": 2}
    issues.sort(key=lambda x: (level_order.get(x.get("correctness_level"), 3), x.get("question_id", 0)))

    if output_file is None:
        output_file = results_file.parent / f"error_analysis_{timestamp}.html"

    html_content = f'''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Error Analysis - {model_name} - {timestamp}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
            font-size: 11px;
            background: #0a0a0a;
            color: #e0e0e0;
            line-height: 1.3;
        }}
        .header {{
            background: #1a1a2e;
            padding: 8px 16px;
            border-bottom: 1px solid #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
            position: sticky;
            top: 0;
            z-index: 1000;
        }}
        .header h1 {{
            font-size: 14px;
            color: #00ff88;
        }}
        .header .stats {{
            color: #888;
        }}
        .header button {{
            background: #00ff88;
            color: #000;
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            font-family: inherit;
            font-weight: bold;
        }}
        .header button:hover {{ background: #00cc6a; }}

        .container {{
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 8px;
        }}

        .question-card {{
            background: #111;
            border: 1px solid #333;
            border-left: 3px solid #666;
        }}
        .question-card.error {{ border-left-color: #ff4444; }}
        .question-card.incorrect {{ border-left-color: #ff8800; }}
        .question-card.partial {{ border-left-color: #ffff00; }}

        .card-header {{
            background: #1a1a1a;
            padding: 6px 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            border-bottom: 1px solid #333;
        }}
        .card-header:hover {{ background: #222; }}

        .q-id {{
            font-weight: bold;
            color: #00ff88;
        }}
        .q-db {{
            color: #888;
            margin-left: 10px;
        }}
        .q-level {{
            padding: 2px 6px;
            font-size: 10px;
            font-weight: bold;
        }}
        .q-level.error {{ background: #ff4444; color: #000; }}
        .q-level.incorrect {{ background: #ff8800; color: #000; }}
        .q-level.partial {{ background: #ffff00; color: #000; }}

        .card-body {{
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 1px;
            background: #333;
        }}
        .card-body.collapsed {{ display: none; }}

        .panel {{
            background: #111;
            padding: 8px;
            overflow: auto;
            max-height: 400px;
        }}
        .panel h3 {{
            color: #00aaff;
            font-size: 10px;
            text-transform: uppercase;
            margin-bottom: 6px;
            border-bottom: 1px solid #333;
            padding-bottom: 4px;
        }}

        .question-text {{
            color: #fff;
            font-size: 12px;
            margin-bottom: 8px;
        }}
        .evidence {{
            color: #aaa;
            font-style: italic;
            margin-bottom: 8px;
        }}

        pre {{
            background: #0a0a0a;
            padding: 6px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
            font-size: 10px;
            border: 1px solid #222;
        }}
        pre.sql {{ color: #00ff88; }}
        pre.result {{ color: #ffaa00; }}
        pre.trace {{
            color: #aaa;
            font-size: 10px;
            line-height: 1.4;
        }}
        pre.trace .assistant {{ color: #00ff88; }}
        pre.trace .tool-call {{ color: #00aaff; }}
        pre.trace .tool-result {{ color: #ffaa00; }}
        pre.error-msg {{ color: #ff4444; }}

        .result-compare {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }}
        .result-box {{
            border: 1px solid #333;
            padding: 4px;
        }}
        .result-box.gold {{ border-color: #00ff88; }}
        .result-box.pred {{ border-color: #ff8800; }}
        .result-label {{
            font-size: 9px;
            color: #666;
            margin-bottom: 4px;
        }}

        .comment-section {{
            grid-column: 1 / -1;
            background: #0d0d1a;
            padding: 8px;
            border-top: 1px solid #333;
        }}
        .comment-section textarea {{
            width: 100%;
            background: #111;
            color: #e0e0e0;
            border: 1px solid #333;
            padding: 6px;
            font-family: inherit;
            font-size: 11px;
            resize: vertical;
            min-height: 40px;
        }}
        .comment-section textarea:focus {{
            outline: none;
            border-color: #00ff88;
        }}

        .schema-compact {{
            font-size: 9px;
            color: #666;
        }}

        .partial-reason {{
            color: #ffff00;
            font-size: 10px;
            margin-top: 4px;
        }}

        /* Scrollbar styling */
        ::-webkit-scrollbar {{ width: 6px; height: 6px; }}
        ::-webkit-scrollbar-track {{ background: #111; }}
        ::-webkit-scrollbar-thumb {{ background: #444; }}
        ::-webkit-scrollbar-thumb:hover {{ background: #666; }}
    </style>
</head>
<body>
    <div class="header">
        <h1>ERROR ANALYSIS: {escape(model_name)}</h1>
        <div class="stats">
            {len(issues)} issues | {len([i for i in issues if i.get('correctness_level')=='error'])} errors |
            {len([i for i in issues if i.get('correctness_level')=='incorrect'])} incorrect |
            {len([i for i in issues if i.get('correctness_level')=='partial'])} partial |
            {timestamp}
        </div>
        <div>
            <button onclick="expandAll()">Expand All</button>
            <button onclick="collapseAll()">Collapse All</button>
            <button onclick="exportComments()">Export Comments (JSON)</button>
        </div>
    </div>

    <div class="container">
'''

    for r in issues:
        qid = r.get("question_id", "?")
        db_id = r.get("db_id", "unknown")
        level = r.get("correctness_level", "unknown")
        question = r.get("question", "")
        evidence = r.get("evidence", "")
        gold_sql = r.get("gold_sql", "")
        pred_sql = r.get("predicted_sql", "")
        gold_result = r.get("gold_result", [])
        pred_result = r.get("predicted_result", [])
        partial_reason = r.get("partial_match_reason", "")
        raw_response = r.get("raw_response", {})

        # Build the initial request that was sent to the model
        initial_request = ""
        if sys_prompt_template:
            sys_preview = sys_prompt_template.replace("{db_id}", db_id).replace("{schema_info}", "[schema shown in left panel]")
            initial_request += f"━━━ SYSTEM PROMPT ━━━\n{sys_preview}\n\n"

        if user_prompt_template:
            user_prompt = user_prompt_template.replace("{question}", question).replace("{evidence}", evidence or "None provided")
            initial_request += f"━━━ USER PROMPT ━━━\n{user_prompt}\n\n"

        # Extract COT trace from raw_response - show full conversation
        cot_trace = initial_request
        cot_trace += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        cot_trace += "               MODEL RESPONSES\n"
        cot_trace += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"

        if isinstance(raw_response, dict):
            messages = raw_response.get("messages", [])
            for i, msg in enumerate(messages):
                if not isinstance(msg, dict):
                    continue

                role = msg.get("role", "unknown")

                if role == "assistant":
                    content = msg.get("content", "")
                    tool_calls = msg.get("tool_calls", [])

                    # Show tool calls first (model's action)
                    if tool_calls:
                        for tc in tool_calls:
                            func_name = tc.get("name") or tc.get("function", {}).get("name", "?")
                            args = tc.get("arguments") or tc.get("function", {}).get("arguments", "{}")
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except (json.JSONDecodeError, TypeError, ValueError):
                                    pass
                            args_str = json.dumps(args, indent=2) if isinstance(args, dict) else str(args)
                            cot_trace += f"▶ CALL {func_name}()\n{args_str}\n\n"

                    # Show assistant content/thinking (if any)
                    if content and content.strip():
                        cot_trace += f"◆ ASSISTANT:\n{content}\n\n"

                elif role == "tool":
                    tool_name = msg.get("tool_name", "?")
                    result = msg.get("result", {})

                    # Format result - could be nested
                    if isinstance(result, dict):
                        result_content = result.get("result", result)
                        if isinstance(result_content, str):
                            try:
                                result_content = json.loads(result_content)
                            except (json.JSONDecodeError, TypeError, ValueError):
                                pass
                        result_str = json.dumps(result_content, indent=2) if isinstance(result_content, dict) else str(result_content)
                    else:
                        result_str = str(result)

                    cot_trace += f"◀ RESULT {tool_name}:\n{result_str}\n\n"

        # Get schema info
        schema_info = load_schema_info(db_id)

        # Format results for display
        # Format results - show all rows (don't truncate for analysis)
        if gold_result:
            gold_str = json.dumps(gold_result, indent=2)
        else:
            gold_str = "None"

        if pred_result:
            pred_str = json.dumps(pred_result, indent=2) if isinstance(pred_result, list) else str(pred_result)
        else:
            pred_str = "None"

        html_content += f'''
        <div class="question-card {level}" data-qid="{qid}">
            <div class="card-header" onclick="toggleCard(this)">
                <div>
                    <span class="q-id">Q{qid}</span>
                    <span class="q-db">{escape(db_id)}</span>
                </div>
                <div style="flex: 1; margin: 0 20px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    {escape(question[:100])}...
                </div>
                <span class="q-level {level}">{level.upper()}</span>
            </div>
            <div class="card-body collapsed">
                <div class="panel">
                    <h3>Question & Evidence</h3>
                    <div class="question-text">{escape(question)}</div>
                    <div class="evidence">Hints: {escape(evidence) if evidence else 'None'}</div>
                    {f'<div class="partial-reason">Partial reason: {escape(partial_reason)}</div>' if partial_reason else ''}

                    <h3 style="margin-top: 12px;">Schema ({escape(db_id)})</h3>
                    <pre class="schema-compact">{escape(schema_info)}</pre>
                </div>

                <div class="panel">
                    <h3>SQL Comparison</h3>
                    <div style="margin-bottom: 8px;">
                        <div class="result-label">GOLD SQL:</div>
                        <pre class="sql">{escape(gold_sql)}</pre>
                    </div>
                    <div>
                        <div class="result-label">PREDICTED SQL:</div>
                        <pre class="sql">{escape(pred_sql) if pred_sql else 'No SQL generated'}</pre>
                    </div>

                    <h3 style="margin-top: 12px;">Results</h3>
                    <div class="result-compare">
                        <div class="result-box gold">
                            <div class="result-label">GOLD ({len(gold_result) if isinstance(gold_result, list) else '?'} rows)</div>
                            <pre class="result">{escape(gold_str)}</pre>
                        </div>
                        <div class="result-box pred">
                            <div class="result-label">PREDICTED</div>
                            <pre class="result {'error-msg' if 'ERROR' in str(pred_result) else ''}">{escape(pred_str)}</pre>
                        </div>
                    </div>
                </div>

                <div class="panel">
                    <h3>Chain of Thought Trace</h3>
                    <pre class="trace">{escape(cot_trace) if cot_trace else 'No trace available'}</pre>
                </div>

                <div class="comment-section">
                    <h3>Analysis Notes</h3>
                    <textarea
                        id="comment-{qid}"
                        placeholder="Add notes about this failure pattern, potential fixes, or prompt improvements..."
                        onchange="saveComment({qid}, this.value)"
                    ></textarea>
                </div>
            </div>
        </div>
'''

    html_content += '''
    </div>

    <script>
        // Store comments
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

        function exportComments() {
            // Collect all comments from textareas
            document.querySelectorAll('textarea[id^="comment-"]').forEach(ta => {
                const qid = ta.id.replace('comment-', '');
                if (ta.value.trim()) {
                    comments[qid] = ta.value.trim();
                }
            });

            // Build export data
            const exportData = {
                timestamp: new Date().toISOString(),
                model: "''' + escape(model_name) + '''",
                source_file: "''' + escape(str(results_file)) + '''",
                feedback: Object.entries(comments).map(([qid, comment]) => ({
                    question_id: parseInt(qid),
                    comment: comment
                })).filter(f => f.comment)
            };

            // Download as JSON
            const blob = new Blob([JSON.stringify(exportData, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'error_feedback_' + new Date().toISOString().slice(0,19).replace(/[:-]/g,'') + '.json';
            a.click();
            URL.revokeObjectURL(url);
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'e' && e.ctrlKey) { expandAll(); e.preventDefault(); }
            if (e.key === 'c' && e.ctrlKey && e.shiftKey) { collapseAll(); e.preventDefault(); }
        });
    </script>
</body>
</html>
'''

    with open(output_file, 'w') as f:
        f.write(html_content)

    print(f"Generated error analysis report: {output_file}")
    print(f"  {len(issues)} issues analyzed")
    return output_file


def find_latest_results() -> Path:
    """Find the most recent results file."""
    results_dir = Path("data/results")
    results_files = list(results_dir.glob("results_*.json"))
    if not results_files:
        raise FileNotFoundError("No results files found in data/results/")
    return max(results_files, key=lambda p: p.stat().st_mtime)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        results_file = Path(sys.argv[1])
    else:
        results_file = find_latest_results()
        print(f"Using latest results: {results_file}")

    generate_html_report(results_file)
