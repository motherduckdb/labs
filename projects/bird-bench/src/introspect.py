"""
Introspection summary aggregation for BIRD-Bench.

Aggregates error investigation results into a markdown summary file
for pattern analysis.
"""

import json
from datetime import datetime
from pathlib import Path


def aggregate_introspection_summary(
    events_file: Path,
    output_dir: Path,
    run_id: str | None = None,
) -> Path | None:
    """
    Aggregate error investigation results into a markdown summary file.

    Args:
        events_file: Path to controllog events.jsonl
        output_dir: Directory to write summary file
        run_id: Filter to specific run_id. Use "latest" to auto-detect.

    Returns:
        Path to generated summary file, or None if no investigations found
    """
    if not events_file.exists():
        return None

    # Load all error_investigation events
    investigations = []
    all_events = []

    with open(events_file) as f:
        for line in f:
            if not line.strip():
                continue
            event = json.loads(line)
            all_events.append(event)
            if event.get("kind") == "error_investigation":
                investigations.append(event)

    if not investigations:
        return None

    # Determine run_id filter
    target_run_id = run_id
    if run_id == "latest" and all_events:
        run_timestamps = {}
        for event in all_events:
            rid = event.get("run_id")
            if rid:
                event_time = event.get("event_time", "")
                if rid not in run_timestamps or event_time > run_timestamps[rid]:
                    run_timestamps[rid] = event_time
        if run_timestamps:
            target_run_id = max(run_timestamps.keys(), key=lambda r: run_timestamps[r])

    # Filter investigations by run_id
    if target_run_id and target_run_id != "latest":
        investigations = [i for i in investigations if i.get("run_id") == target_run_id]

    if not investigations:
        return None

    # Group by category
    by_category: dict[str, list] = {}
    for inv in investigations:
        payload = inv.get("payload_json", {})
        category = payload.get("category", "uncategorized")
        if category not in by_category:
            by_category[category] = []
        by_category[category].append(inv)

    # Generate markdown
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    lines = [
        "# Introspection Summary",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"Run ID: {target_run_id or 'all'}",
        f"Total investigations: {len(investigations)}",
        "",
        "---",
        "",
        "## By Category",
        "",
    ]

    # Summary by category
    for category in sorted(by_category.keys()):
        count = len(by_category[category])
        lines.append(f"- **{category}**: {count}")
    lines.append("")

    # Detailed recommendations
    lines.extend([
        "---",
        "",
        "## All Recommendations",
        "",
    ])

    for inv in investigations:
        payload = inv.get("payload_json", {})
        qid = payload.get("question_id", "?")
        db_id = payload.get("db_id", "unknown")
        category = payload.get("category", "uncategorized")
        short_desc = payload.get("short_description", "")
        detailed_desc = payload.get("detailed_description", "")
        fix = payload.get("fix", "")

        lines.extend([
            f"### Question {qid}",
            f"**DB:** {db_id}",
            f"**Category:** {category}",
            f"**Issue:** {short_desc}",
            "",
        ])

        if detailed_desc:
            lines.extend([
                "**Details:**",
                f"> {detailed_desc}",
                "",
            ])

        if fix:
            lines.extend([
                "**Recommendation:**",
                f"> {fix}",
                "",
            ])

        lines.append("---")
        lines.append("")

    # Write file
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"introspection_summary_{timestamp}.md"

    with open(output_path, "w") as f:
        f.write("\n".join(lines))

    return output_path
