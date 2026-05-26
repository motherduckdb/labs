"""
Truth-Seeking Inspector for BIRD-Bench evaluation.

Analyzes completed eval runs to determine if predicted SQL is more correct
than gold SQL. Uses an objective third-party model (gemini-3-flash-preview) to judge.

This is Mode 2 of the error inspector:
- Mode 1 (error_investigator.py): Model self-reflects on mistakes during eval
- Mode 2 (truth_seeker.py): Post-hoc analysis asking "which answer is better?"
"""

import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Callable

from openai import OpenAI

from eval.config import RESULTS_DIR, DEV_TABLES_FILE, EVAL_DATA_DIR


# Default model for truth-seeking analysis
TRUTH_SEEKING_MODEL = "google/gemini-3-flash-preview"

TRUTH_SEEKING_PROMPT = """You are an expert SQL analyst acting as an impartial judge. Given a natural language question and two SQL answers, determine which answer is MORE CORRECT.

## Question
{question}

## Evidence/Hints
{evidence}

## Database Schema
{schema_summary}

## Answer A: Gold SQL (from benchmark)
```sql
{gold_sql}
```
**Result A:**
{gold_result}

## Answer B: Predicted SQL (from model)
```sql
{predicted_sql}
```
**Result B:**
{predicted_result}

## Your Task
Analyze both SQL queries and their results. Determine which answer better addresses the question.

Consider:
1. Does each query correctly interpret the question's intent?
2. Are the joins and filters logically correct?
3. Does the result actually answer what was asked?
4. Are there edge cases one handles better than the other?

**Be maximally truth-seeking.** The benchmark answer is NOT automatically correct. Many benchmark questions have known bugs.

**Respond with ONLY this JSON:**
```json
{{
  "verdict": "GOLD_CORRECT" | "PREDICTED_CORRECT" | "BOTH_CORRECT" | "BOTH_WRONG" | "UNCLEAR",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "Detailed explanation of which answer is better and why",
  "gold_issues": ["List of issues with gold SQL, if any"],
  "predicted_issues": ["List of issues with predicted SQL, if any"],
  "recommendation": "KEEP_GOLD" | "ADD_TO_PLATINUM" | "NEEDS_REVIEW"
}}
```"""

# Extended prompt for real-time judging with platinum context
JUDGE_PROMPT = """You are an expert SQL analyst acting as an impartial judge. Given a natural language question and two SQL answers, determine which answer is MORE CORRECT.

## Question
{question}

## Evidence/Hints
{evidence}

## Database Schema
{schema_summary}

## Answer A: Gold SQL (from benchmark)
```sql
{gold_sql}
```
**Result A:**
{gold_result}

## Answer B: Predicted SQL (from model being evaluated)
```sql
{predicted_sql}
```
**Result B:**
{predicted_result}
{platinum_section}
## Your Task
Analyze both SQL queries and their results. Determine which answer better addresses the question.

Consider:
1. Does each query correctly interpret the question's intent?
2. Are the joins and filters logically correct?
3. Does the result actually answer what was asked?
4. Are there edge cases one handles better than the other?

**Be maximally truth-seeking.** The benchmark answer is NOT automatically correct. Many benchmark questions have known bugs or ambiguities.
{platinum_note}
**Respond with ONLY this JSON:**
```json
{{
  "verdict": "GOLD_CORRECT" | "PREDICTED_CORRECT" | "BOTH_CORRECT" | "BOTH_WRONG" | "UNCLEAR",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "Detailed explanation of which answer is better and why"
}}
```"""

PLATINUM_SECTION_TEMPLATE = """
## Platinum Answer (Human-Curated Alternative)
A human reviewer previously determined this question has a valid alternative answer:

Platinum SQL:
```sql
{platinum_sql}
```

Platinum Result:
{platinum_result}

Reviewer's Reasoning:
{platinum_reason}
"""

PLATINUM_NOTE = """
Note: A platinum answer exists for this question. If the predicted SQL produces results semantically equivalent to the platinum answer, consider it PREDICTED_CORRECT even if it doesn't match gold exactly.
"""


@dataclass
class TruthSeekingResult:
    """Result of truth-seeking analysis for one question."""
    # Identifiers
    question_id: int
    db_id: str

    # Verdict
    verdict: str  # GOLD_CORRECT, PREDICTED_CORRECT, BOTH_CORRECT, BOTH_WRONG, UNCLEAR
    confidence: str  # HIGH, MEDIUM, LOW
    reasoning: str

    # Issues found
    gold_issues: list[str]
    predicted_issues: list[str]

    # Recommendation
    recommendation: str  # KEEP_GOLD, ADD_TO_PLATINUM, NEEDS_REVIEW

    # Full context for human review
    question: str  # Original natural language question
    evidence: str | None  # Hints/evidence from benchmark

    # SQL comparison
    gold_sql: str
    predicted_sql: str

    # Results comparison
    gold_result: str  # Formatted gold output
    predicted_result: str  # Formatted predicted output

    # Original eval context
    correctness_level: str  # Original eval result

    # Analysis metadata
    inspector_model: str
    analyzed_at: str


class TruthSeekingInspector:
    """
    Analyzes completed eval runs to determine if predicted SQL
    is more correct than gold SQL.
    """

    def __init__(self, model: str = TRUTH_SEEKING_MODEL):
        self.model = model
        self.client = self._init_client()
        self._questions_cache = None
        self._tables_cache = None

    def _init_client(self) -> OpenAI:
        """Initialize OpenRouter client."""
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY environment variable not set")

        return OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            default_headers={
                "HTTP-Referer": "https://github.com/bird-bench-eval",
                "X-Title": "BIRD-Bench Truth Seeker",
            }
        )

    def analyze_error_log(
        self,
        error_log_path: Path,
        output_path: Path | None = None,
        on_progress: Callable[[int, int], None] | None = None,
        limit: int | None = None,
    ) -> list[TruthSeekingResult]:
        """
        Analyze all entries in an error log file.

        Args:
            error_log_path: Path to errors_*.jsonl file
            output_path: Optional path to write results
            on_progress: Optional callback(current, total)
            limit: Optional limit on number of entries to analyze

        Returns:
            List of TruthSeekingResult for each analyzed question
        """
        entries = self._load_error_log(error_log_path)

        if limit:
            entries = entries[:limit]

        results = []
        for i, entry in enumerate(entries):
            if on_progress:
                on_progress(i + 1, len(entries))

            try:
                result = self._analyze_entry(entry)
                results.append(result)

                # Write incrementally if output path provided
                if output_path:
                    self._append_result(output_path, result)
            except Exception as e:
                print(f"  Error analyzing Q{entry.get('question_id')}: {e}")

        return results

    def analyze_controllog(
        self,
        controllog_path: Path,
        output_path: Path | None = None,
        on_progress: Callable[[int, int], None] | None = None,
        limit: int | None = None,
        run_id: str | None = None,
        filter_reviewed: bool = True,
    ) -> list[TruthSeekingResult]:
        """
        Analyze incorrect/partial results from controllog events.

        This is independent of --introspect; works on any eval run.

        Args:
            controllog_path: Path to controllog/events.jsonl
            output_path: Optional path to write results
            on_progress: Optional callback(current, total)
            limit: Optional limit on number of entries to analyze
            run_id: Filter to specific run_id. Use "latest" for most recent run.
            filter_reviewed: If True, exclude already-reviewed question_ids

        Returns:
            List of TruthSeekingResult for each analyzed question
        """
        entries = self._load_from_controllog(
            controllog_path, run_id=run_id, filter_reviewed=filter_reviewed
        )

        if limit:
            entries = entries[:limit]

        results = []
        for i, entry in enumerate(entries):
            if on_progress:
                on_progress(i + 1, len(entries))

            try:
                result = self._analyze_entry(entry)
                results.append(result)

                # Write incrementally if output path provided
                if output_path:
                    self._append_result(output_path, result)
            except Exception as e:
                print(f"  Error analyzing Q{entry.get('question_id')}: {e}")

        return results

    def judge_single(
        self,
        question_id: int,
        db_id: str,
        question: str,
        evidence: str | None,
        gold_sql: str,
        gold_result: list | str | None,
        predicted_sql: str,
        predicted_result: list | str | None,
        platinum_entry: dict | None = None,
    ) -> TruthSeekingResult:
        """
        Judge a single question immediately (for --judge flag during eval).

        This is the real-time version of _analyze_entry, used during evaluation
        rather than post-hoc analysis.

        Args:
            question_id: Question identifier
            db_id: Database identifier
            question: Natural language question text
            evidence: Hints/evidence from benchmark
            gold_sql: Gold SQL from benchmark
            gold_result: Result of executing gold SQL
            predicted_sql: SQL predicted by model
            predicted_result: Result of executing predicted SQL
            platinum_entry: Optional platinum answer dict with 'platinum_sql',
                          'platinum_result', and 'reason' fields

        Returns:
            TruthSeekingResult with verdict and reasoning
        """
        schema_summary = self._get_schema_summary(db_id)

        # Format results
        gold_result_str = self._format_result(gold_result)
        predicted_result_str = self._format_result(predicted_result)

        # Build platinum section if available
        platinum_section = ""
        platinum_note = ""
        if platinum_entry:
            platinum_section = PLATINUM_SECTION_TEMPLATE.format(
                platinum_sql=platinum_entry.get("platinum_sql", "(not available)"),
                platinum_result=self._format_result(platinum_entry.get("platinum_result")),
                platinum_reason=platinum_entry.get("reason", "(no reason provided)"),
            )
            platinum_note = PLATINUM_NOTE

        # Build prompt
        prompt = JUDGE_PROMPT.format(
            question=question,
            evidence=evidence or "None",
            schema_summary=schema_summary,
            gold_sql=gold_sql,
            gold_result=gold_result_str,
            predicted_sql=predicted_sql,
            predicted_result=predicted_result_str,
            platinum_section=platinum_section,
            platinum_note=platinum_note,
        )

        # Call model
        response = self._call_model(prompt)

        # Parse response
        parsed = self._parse_response(response)

        return TruthSeekingResult(
            question_id=question_id,
            db_id=db_id,
            verdict=parsed.get("verdict", "UNCLEAR"),
            confidence=parsed.get("confidence", "LOW"),
            reasoning=parsed.get("reasoning", response),
            gold_issues=parsed.get("gold_issues", []),
            predicted_issues=parsed.get("predicted_issues", []),
            recommendation=parsed.get("recommendation", "NEEDS_REVIEW"),
            question=question,
            evidence=evidence,
            gold_sql=gold_sql,
            predicted_sql=predicted_sql,
            gold_result=gold_result_str,
            predicted_result=predicted_result_str,
            correctness_level="judged",  # Indicates this came from judge
            inspector_model=self.model,
            analyzed_at=datetime.now().isoformat(),
        )

    def _load_error_log(self, path: Path) -> list[dict]:
        """Load error log entries from JSONL file."""
        entries = []
        with open(path) as f:
            for line in f:
                if line.strip():
                    entries.append(json.loads(line))
        return entries

    def _load_from_controllog(
        self,
        path: Path,
        run_id: str | None = None,
        filter_reviewed: bool = True,
    ) -> list[dict]:
        """
        Load entries from controllog events.jsonl file.

        Filters for model_completion events with incorrect/partial results.
        Returns entries in same format as error_log for compatibility.

        Args:
            path: Path to events.jsonl
            run_id: Filter to specific run_id. Use "latest" to auto-detect most recent run.
            filter_reviewed: If True, exclude already-reviewed question_ids
        """
        from src.platinum import load_reviewed, load_platinum

        # Load reviewed set if filtering
        reviewed = load_reviewed() if filter_reviewed else set()

        # Load platinum answers for status reporting
        platinum_answers = load_platinum()

        # First pass: collect all events and find latest run_id if needed
        all_events = []
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                event = json.loads(line)
                if event.get("kind") != "model_completion":
                    continue
                payload = event.get("payload_json", {})
                if payload.get("question_id") is None:
                    continue
                all_events.append(event)

        # Determine run_id filter
        target_run_id = run_id
        if run_id == "latest" and all_events:
            # Find the most recent run_id by timestamp
            run_timestamps = {}
            for event in all_events:
                rid = event.get("run_id")
                if rid:
                    event_time = event.get("event_time", "")
                    if rid not in run_timestamps or event_time > run_timestamps[rid]:
                        run_timestamps[rid] = event_time
            if run_timestamps:
                # Get run_id with latest timestamp
                target_run_id = max(run_timestamps.keys(), key=lambda r: run_timestamps[r])

        # Track skip reasons for reporting
        skip_counts = {
            "correct_gold": 0,
            "correct_platinum": 0,
            "already_reviewed": 0,
            "resolved_partial": 0,
            "no_question_id": 0,
            "wrong_run": 0,
        }
        platinum_status = []  # Track platinum answer status

        # Second pass: filter and build entries
        entries = []
        for event in all_events:
            payload = event.get("payload_json", {})
            question_id = payload.get("question_id")

            # Filter by run_id if specified (supports prefix matching)
            if target_run_id and target_run_id != "latest":
                event_run_id = event.get("run_id", "")
                if not event_run_id.startswith(target_run_id):
                    skip_counts["wrong_run"] += 1
                    continue

            # Check correctness and match source
            correctness = payload.get("correctness_level")
            match_source = payload.get("match_source")

            # Track platinum answer status (before other skips to ensure reporting)
            has_platinum = question_id in platinum_answers
            if has_platinum:
                if correctness == "correct" and match_source == "platinum":
                    platinum_status.append(f"Q{question_id}: PLATINUM_MATCH")
                elif correctness == "correct":
                    platinum_status.append(f"Q{question_id}: GOLD_MATCH (platinum exists)")
                else:
                    platinum_status.append(f"Q{question_id}: NOT_MATCHING (platinum exists)")

            # Skip already-reviewed questions
            if question_id in reviewed:
                skip_counts["already_reviewed"] += 1
                continue

            # Skip correct results
            if correctness == "correct":
                if match_source == "platinum":
                    skip_counts["correct_platinum"] += 1
                else:
                    skip_counts["correct_gold"] += 1
                continue

            # Skip partial results where unique values already match
            # These are DISTINCT-related differences that shouldn't be penalized
            partial_reason = payload.get("partial_reason", "")
            if correctness == "partial" and partial_reason:
                # These reasons indicate unique values match, just different DISTINCT handling
                resolved_reasons = ("extra_duplicates", "implicit_distinct", "aggregated_equivalent")
                if any(reason in partial_reason for reason in resolved_reasons):
                    skip_counts["resolved_partial"] += 1
                    continue

            # Build entry in same format as error_log
            entry = {
                "question_id": question_id,
                "db_id": payload.get("db_id"),
                "gold_sql_duckdb": payload.get("gold_sql", ""),
                "predicted_sql": payload.get("predicted_sql", ""),
                "gold_result": payload.get("gold_result"),
                "predicted_result": payload.get("predicted_result"),
                "correctness_level": correctness,
                "partial_reason": payload.get("partial_reason"),
            }
            entries.append(entry)

        # Print skip summary
        total_in_run = sum(1 for e in all_events
                          if not target_run_id or target_run_id == "latest"
                          or e.get("run_id", "").startswith(target_run_id))
        if total_in_run > 0:
            print(f"\nFiltering summary ({total_in_run} questions in run):")
            if skip_counts["correct_gold"] > 0:
                print(f"  - Correct (gold):      {skip_counts['correct_gold']} skipped")
            if skip_counts["correct_platinum"] > 0:
                print(f"  - Correct (platinum):  {skip_counts['correct_platinum']} skipped")
            if skip_counts["already_reviewed"] > 0:
                print(f"  - Already reviewed:    {skip_counts['already_reviewed']} skipped")
            if skip_counts["resolved_partial"] > 0:
                print(f"  - Resolved partial:    {skip_counts['resolved_partial']} skipped (DISTINCT-related)")

            # Print platinum status if any
            if platinum_status:
                print(f"\nPlatinum answer status:")
                for status in platinum_status:
                    print(f"  {status}")

            print(f"\n  → {len(entries)} questions to analyze")

        return entries

    def _load_questions(self) -> dict[int, dict]:
        """Load questions indexed by question_id from train.json and test.json."""
        if self._questions_cache is not None:
            return self._questions_cache

        self._questions_cache = {}

        # Load from train.json and test.json
        for filename in ["train.json", "test.json"]:
            filepath = EVAL_DATA_DIR / filename
            if filepath.exists():
                with open(filepath) as f:
                    data = json.load(f)
                    # Handle both plain array and {"questions": [...]} formats
                    questions = data if isinstance(data, list) else data.get("questions", [])
                    for q in questions:
                        self._questions_cache[q["question_id"]] = q

        return self._questions_cache

    def _load_tables(self) -> dict[str, dict]:
        """Load table schemas indexed by db_id."""
        if self._tables_cache is not None:
            return self._tables_cache

        if not DEV_TABLES_FILE.exists():
            return {}

        with open(DEV_TABLES_FILE) as f:
            tables = json.load(f)

        self._tables_cache = {t["db_id"]: t for t in tables}
        return self._tables_cache

    def _get_schema_summary(self, db_id: str) -> str:
        """Get a compact schema summary for a database."""
        tables = self._load_tables()
        if db_id not in tables:
            return "(schema not available)"

        db = tables[db_id]
        table_names = db.get("table_names_original", [])
        columns = db.get("column_names_original", [])

        lines = []
        for i, table in enumerate(table_names):
            cols = [c[1] for c in columns if c[0] == i]
            lines.append(f"{table}: {', '.join(cols)}")

        return "\n".join(lines)

    def _analyze_entry(self, entry: dict) -> TruthSeekingResult:
        """Analyze a single error log entry."""
        question_id = entry["question_id"]
        db_id = entry["db_id"]

        # Load question context
        questions = self._load_questions()
        question_data = questions.get(question_id, {})

        question_text = question_data.get("question", "(question not available)")
        evidence = question_data.get("evidence", "None")
        schema_summary = self._get_schema_summary(db_id)

        # Get SQL and results from entry
        gold_sql = entry.get("gold_sql_duckdb", entry.get("gold_sql", "(not available)"))
        predicted_sql = entry.get("predicted_sql", "(not available)")

        # Format results
        gold_result = self._format_result(entry.get("gold_result"))
        predicted_result = self._format_result(entry.get("predicted_result"))

        # Build prompt
        prompt = TRUTH_SEEKING_PROMPT.format(
            question=question_text,
            evidence=evidence,
            schema_summary=schema_summary,
            gold_sql=gold_sql,
            gold_result=gold_result,
            predicted_sql=predicted_sql,
            predicted_result=predicted_result,
        )

        # Call model
        response = self._call_model(prompt)

        # Parse response
        parsed = self._parse_response(response)

        return TruthSeekingResult(
            question_id=question_id,
            db_id=db_id,
            verdict=parsed.get("verdict", "UNCLEAR"),
            confidence=parsed.get("confidence", "LOW"),
            reasoning=parsed.get("reasoning", response),
            gold_issues=parsed.get("gold_issues", []),
            predicted_issues=parsed.get("predicted_issues", []),
            recommendation=parsed.get("recommendation", "NEEDS_REVIEW"),
            question=question_text,
            evidence=evidence if evidence != "None" else None,
            gold_sql=gold_sql,
            predicted_sql=predicted_sql,
            gold_result=gold_result,
            predicted_result=predicted_result,
            correctness_level=entry.get("correctness_level", "unknown"),
            inspector_model=self.model,
            analyzed_at=datetime.now().isoformat(),
        )

    def _format_result(self, result) -> str:
        """Format a SQL result for the prompt, sampling to 20 rows max."""
        if result is None:
            return "(result not available)"
        if isinstance(result, str):
            return result
        if isinstance(result, list):
            if not result:
                return "(empty result)"
            total = len(result)
            rows = result[:20]
            formatted = "\n".join(str(row) for row in rows)
            if total > 20:
                formatted += f"\n... (sampled 20 of {total} total rows)"
            return formatted
        return str(result)

    def _call_model(self, prompt: str) -> str:
        """Call the model and return response text. Retries once on timeout."""
        for attempt in range(2):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=2048,
                    temperature=0.0,
                    timeout=60.0,  # 1 minute timeout
                )
                return response.choices[0].message.content or ""
            except Exception as e:
                if attempt == 0 and "timeout" in str(e).lower():
                    print(f"  Judge timeout, retrying...")
                    continue
                raise
        return ""  # Should not reach here

    def _parse_response(self, response: str) -> dict:
        """Parse JSON from model response."""
        import re

        # Try to extract JSON from code block
        json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find raw JSON
        brace_start = response.find('{')
        if brace_start != -1:
            depth = 0
            for i, c in enumerate(response[brace_start:]):
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(response[brace_start:brace_start + i + 1])
                        except json.JSONDecodeError:
                            break

        # Fallback
        return {
            "verdict": "UNCLEAR",
            "confidence": "LOW",
            "reasoning": f"Failed to parse response: {response[:500]}",
            "gold_issues": [],
            "predicted_issues": [],
            "recommendation": "NEEDS_REVIEW",
        }

    def _append_result(self, path: Path, result: TruthSeekingResult):
        """Append a result to JSONL file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(asdict(result)) + "\n")


def get_latest_error_log() -> Path | None:
    """Find the most recent error log file."""
    error_logs_dir = RESULTS_DIR / "error_logs"
    if not error_logs_dir.exists():
        return None

    logs = sorted(error_logs_dir.glob("errors_*.jsonl"), reverse=True)
    return logs[0] if logs else None


def get_controllog_events() -> Path | None:
    """Get the controllog events.jsonl file."""
    events_file = RESULTS_DIR / "controllog" / "events.jsonl"
    return events_file if events_file.exists() else None


def print_summary(results: list[TruthSeekingResult]):
    """Print summary statistics to terminal."""
    if not results:
        print("No results to summarize.")
        return

    # Count verdicts
    verdicts = {}
    recommendations = {}
    high_confidence_platinum = []

    for r in results:
        verdicts[r.verdict] = verdicts.get(r.verdict, 0) + 1
        recommendations[r.recommendation] = recommendations.get(r.recommendation, 0) + 1

        if r.verdict == "PREDICTED_CORRECT" and r.confidence == "HIGH":
            high_confidence_platinum.append(r)

    total = len(results)

    print("\nSummary:")
    for verdict in ["GOLD_CORRECT", "PREDICTED_CORRECT", "BOTH_CORRECT", "BOTH_WRONG", "UNCLEAR"]:
        count = verdicts.get(verdict, 0)
        pct = 100 * count / total if total > 0 else 0
        print(f"  {verdict:<20} {count:>3} ({pct:.1f}%)")

    print("\nRecommendations:")
    for rec in ["KEEP_GOLD", "ADD_TO_PLATINUM", "NEEDS_REVIEW"]:
        count = recommendations.get(rec, 0)
        print(f"  {rec:<20} {count:>3}")

    if high_confidence_platinum:
        print(f"\nHigh-confidence platinum candidates ({len(high_confidence_platinum)}):")
        for r in high_confidence_platinum[:10]:
            reason_short = r.reasoning[:60] + "..." if len(r.reasoning) > 60 else r.reasoning
            print(f"  - Q{r.question_id} ({r.db_id}): {reason_short}")
        if len(high_confidence_platinum) > 10:
            print(f"  ... and {len(high_confidence_platinum) - 10} more")
