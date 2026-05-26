"""
HTML Report Generator for BIRD-Bench Evaluation Results.
"""

from datetime import datetime
from pathlib import Path

from jinja2 import Template


HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BIRD-Bench Evaluation Report</title>
    <style>
        :root {
            --bg: #0d1117;
            --bg-secondary: #161b22;
            --border: #30363d;
            --text: #c9d1d9;
            --text-muted: #8b949e;
            --green: #238636;
            --red: #da3633;
            --blue: #58a6ff;
            --yellow: #d29922;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.6;
            padding: 2rem;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1, h2, h3 { margin-bottom: 1rem; }
        h1 { color: var(--blue); border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
        }
        .summary-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1.5rem;
        }
        .summary-card h3 { color: var(--blue); font-size: 0.9rem; text-transform: uppercase; }
        .summary-card .value { font-size: 2rem; font-weight: bold; margin: 0.5rem 0; }
        .summary-card .subtext { color: var(--text-muted); font-size: 0.85rem; }
        .model-comparison {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            overflow: hidden;
            margin: 2rem 0;
        }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 1rem; text-align: left; border-bottom: 1px solid var(--border); }
        th { background: var(--bg); color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.8rem; }
        tr:hover { background: rgba(88, 166, 255, 0.05); }
        .accuracy-bar {
            width: 100px;
            height: 8px;
            background: var(--border);
            border-radius: 4px;
            overflow: hidden;
            display: inline-block;
            vertical-align: middle;
            margin-right: 0.5rem;
        }
        .accuracy-fill {
            height: 100%;
            background: var(--green);
            border-radius: 4px;
        }
        .pass { color: var(--green); }
        .fail { color: var(--red); }
        .details-section { margin: 2rem 0; }
        .question-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            margin: 1rem 0;
            overflow: hidden;
        }
        .question-header {
            padding: 1rem;
            background: var(--bg);
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
        }
        .question-header:hover { background: rgba(88, 166, 255, 0.05); }
        .question-body { padding: 1rem; display: none; }
        .question-body.open { display: block; }
        .sql-block {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 1rem;
            margin: 0.5rem 0;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 0.85rem;
            overflow-x: auto;
            white-space: pre-wrap;
        }
        .label {
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            margin-top: 1rem;
            margin-bottom: 0.25rem;
        }
        .badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
        }
        .badge-pass { background: rgba(35, 134, 54, 0.2); color: var(--green); }
        .badge-partial { background: rgba(210, 153, 34, 0.2); color: var(--yellow); }
        .badge-fail { background: rgba(218, 54, 51, 0.2); color: var(--red); }
        .badge-db { background: rgba(88, 166, 255, 0.2); color: var(--blue); }
        .tabs {
            display: flex;
            gap: 0.5rem;
            margin: 1rem 0;
        }
        .tab {
            padding: 0.5rem 1rem;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 4px;
            cursor: pointer;
            color: var(--text-muted);
        }
        .tab.active { background: var(--blue); color: white; border-color: var(--blue); }
        .model-section { display: none; }
        .model-section.active { display: block; }
        .stats-row {
            display: flex;
            gap: 2rem;
            margin: 0.5rem 0;
            color: var(--text-muted);
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>BIRD-Bench Evaluation Report</h1>
        <p style="color: var(--text-muted);">Generated: {{ timestamp }}</p>

        <div class="summary-grid">
            <div class="summary-card">
                <h3>Questions Evaluated</h3>
                <div class="value">{{ num_questions }}</div>
                <div class="subtext">Challenging difficulty</div>
            </div>
            <div class="summary-card">
                <h3>Models Tested</h3>
                <div class="value">{{ num_models }}</div>
                <div class="subtext">{{ model_names }}</div>
            </div>
            <div class="summary-card">
                <h3>Best Accuracy</h3>
                <div class="value">{{ best_accuracy }}%</div>
                <div class="subtext">{{ best_model }}</div>
            </div>
            <div class="summary-card">
                <h3>Total Cost</h3>
                <div class="value">${{ total_cost }}</div>
                <div class="subtext">Across all models</div>
            </div>
        </div>

        <h2>Model Comparison</h2>
        <div class="model-comparison">
            <table>
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Accuracy</th>
                        <th>Correct</th>
                        <th>Partial</th>
                        <th>Cost</th>
                        <th>Avg Time</th>
                        <th>Avg Tool Calls</th>
                    </tr>
                </thead>
                <tbody>
                    {% for model in models_sorted %}
                    <tr>
                        <td><strong>{{ model.name }}</strong><br><span style="color: var(--text-muted); font-size: 0.8rem;">{{ model.model_id }}</span></td>
                        <td>
                            <div class="accuracy-bar"><div class="accuracy-fill" style="width: {{ model.accuracy }}%;"></div></div>
                            {{ model.accuracy }}%
                        </td>
                        <td>{{ model.correct }}/{{ model.total }}</td>
                        <td style="color: var(--yellow);">{{ model.partial if model.partial > 0 else '-' }}</td>
                        <td>${{ model.cost }}</td>
                        <td>{{ model.avg_time }}ms</td>
                        <td>{{ model.avg_tools }}</td>
                    </tr>
                    {% endfor %}
                </tbody>
            </table>
        </div>

        <h2>Detailed Results</h2>
        <div class="tabs">
            {% for model in models_sorted %}
            <div class="tab {% if loop.first %}active{% endif %}" onclick="showModel('{{ model.name | replace(' ', '_') }}')">
                {{ model.name }}
            </div>
            {% endfor %}
        </div>

        {% for model_name, results in all_results.items() %}
        <div class="model-section {% if loop.first %}active{% endif %}" id="model_{{ model_name | replace(' ', '_') }}">
            {% for r in results %}
            <div class="question-card">
                <div class="question-header" onclick="toggleQuestion(this)">
                    <div>
                        <span class="badge {% if r.is_correct %}badge-pass{% elif r.correctness_level == 'partial' %}badge-partial{% else %}badge-fail{% endif %}">
                            {% if r.is_correct %}PASS{% elif r.correctness_level == 'partial' %}PARTIAL{% else %}FAIL{% endif %}
                        </span>
                        {% if r.partial_match_reason %}
                        <span style="color: var(--yellow); font-size: 0.75rem; margin-left: 0.25rem;">({{ r.partial_match_reason }})</span>
                        {% endif %}
                        <span class="badge badge-db">{{ r.db_id }}</span>
                        <strong style="margin-left: 0.5rem;">Q{{ r.question_id }}</strong>
                        <span style="color: var(--text-muted); margin-left: 0.5rem;">{{ r.question[:80] }}{% if r.question|length > 80 %}...{% endif %}</span>
                    </div>
                    <div class="stats-row">
                        <span>${{ "%.4f"|format(r.cost_usd) }}</span>
                        <span>{{ r.duration_ms }}ms</span>
                        <span>{{ r.tool_calls }} calls</span>
                    </div>
                </div>
                <div class="question-body">
                    <div class="label">Question</div>
                    <p>{{ r.question }}</p>

                    {% if r.evidence %}
                    <div class="label">Evidence</div>
                    <p style="color: var(--text-muted);">{{ r.evidence }}</p>
                    {% endif %}

                    <div class="label">Gold SQL</div>
                    <div class="sql-block">{{ r.gold_sql }}</div>

                    <div class="label">Predicted SQL</div>
                    <div class="sql-block {% if r.is_correct %}pass{% else %}fail{% endif %}">{{ r.predicted_sql or 'No SQL generated' }}</div>

                    {% if r.error %}
                    <div class="label">Error</div>
                    <div class="sql-block" style="border-color: var(--red);">{{ r.error }}</div>
                    {% endif %}
                </div>
            </div>
            {% endfor %}
        </div>
        {% endfor %}
    </div>

    <script>
        function toggleQuestion(header) {
            const body = header.nextElementSibling;
            body.classList.toggle('open');
        }

        function showModel(modelId) {
            // Update tabs
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');

            // Update sections
            document.querySelectorAll('.model-section').forEach(s => s.classList.remove('active'));
            document.getElementById('model_' + modelId).classList.add('active');
        }
    </script>
</body>
</html>
"""


def generate_html_report(
    all_results: dict,
    summary: dict,
    output_path: str
):
    """
    Generate an HTML report from evaluation results.

    Args:
        all_results: Dict mapping model names to lists of EvalResult
        summary: Summary statistics dictionary
        output_path: Path to write HTML file
    """
    template = Template(HTML_TEMPLATE)

    # Prepare model data for template
    models_sorted = []
    for model_name, stats in sorted(
        summary["models"].items(),
        key=lambda x: x[1]["accuracy_percent"],
        reverse=True
    ):
        models_sorted.append({
            "name": model_name,
            "model_id": stats.get("model_id", ""),
            "accuracy": f"{stats['accuracy_percent']:.1f}",
            "correct": stats["correct"],
            "partial": stats.get("partial", 0),
            "total": stats["total"],
            "cost": f"{stats['total_cost_usd']:.4f}",
            "avg_time": f"{stats['avg_duration_ms']:.0f}",
            "avg_tools": f"{stats['avg_tool_calls']:.1f}",
        })

    # Convert results to serializable format
    results_data = {}
    for model_name, results in all_results.items():
        results_data[model_name] = []
        for r in results:
            results_data[model_name].append({
                "question_id": r.question_id,
                "db_id": r.db_id,
                "question": r.question,
                "evidence": r.evidence,
                "gold_sql": r.gold_sql,
                "predicted_sql": r.predicted_sql,
                "is_correct": r.is_correct,
                "correctness_level": r.correctness_level.value if hasattr(r.correctness_level, 'value') else str(r.correctness_level),
                "partial_match_reason": r.partial_match_reason,
                "error": r.error,
                "cost_usd": r.cost_usd,
                "duration_ms": r.duration_ms,
                "tool_calls": r.tool_calls,
            })

    # Calculate totals
    total_cost = sum(s["total_cost_usd"] for s in summary["models"].values())
    best_model = models_sorted[0]["name"] if models_sorted else "N/A"
    best_accuracy = models_sorted[0]["accuracy"] if models_sorted else 0

    # Render template
    html = template.render(
        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        num_questions=summary["num_questions"],
        num_models=len(summary["models"]),
        model_names=", ".join(m["name"] for m in models_sorted),
        best_accuracy=best_accuracy,
        best_model=best_model,
        total_cost=f"{total_cost:.2f}",
        models_sorted=models_sorted,
        all_results=results_data,
    )

    # Write file
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(html)

    return output_path
