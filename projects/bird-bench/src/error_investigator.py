"""
Error investigation module for analyzing incorrect SQL predictions.

Uses conversation continuation to let the model self-reflect on its mistakes
with full context of its reasoning process.

Results are logged to JSONL files and Controllog for aggregate analysis.
"""

import asyncio
import json
from dataclasses import dataclass, asdict
from pathlib import Path
from datetime import datetime

from src.constants import PROMPTS_DIR
from eval.hydrator import translate_sqlite_to_duckdb


@dataclass
class ErrorInvestigation:
    """Result of investigating an incorrect prediction."""
    # Identifiers
    question_id: int
    db_id: str
    dataset: str  # a, b, or c (extracted from database name)
    model: str    # model being evaluated

    # Classification
    category: str  # BAD_JOIN, WRONG_TABLES, etc.
    short_description: str
    detailed_description: str
    fix: str  # Suggested prompt improvements

    # Table analysis
    gold_tables: list[str]
    predicted_tables: list[str]

    # Context (for debugging)
    correctness_level: str  # PARTIAL, INCORRECT, ERROR
    partial_reason: str | None

    # SQL (gold is translated to DuckDB for fair comparison)
    gold_sql_duckdb: str
    predicted_sql: str

    # Results (for truth-seeking analysis)
    gold_result: str
    predicted_result: str


# Investigation prompt that continues the conversation
INVESTIGATION_PROMPT = """Your SQL query produced incorrect results. Analyze what went wrong.

## Correct Answer (Gold SQL, translated to DuckDB dialect)
```sql
{gold_sql_duckdb}
```

**Expected Result**:
{gold_result}

## Your Answer
```sql
{predicted_sql}
```

**Your Result**:
{predicted_result}

## Your Task
Classify the error into exactly ONE category:
- **HIT_ITERATION_LIMIT**: Ran out of tool calls before completing
- **BAD_JOIN**: Incorrect join conditions, missing joins, or wrong join types
- **WRONG_TABLES**: Used incorrect tables or missed required tables
- **MISSING_COLUMNS**: Query omits columns that should be in output
- **DISTINCT**: Missing/incorrect DISTINCT or GROUP BY
- **SEMANTIC_MISUNDERSTANDING**: Misinterpreted question intent
- **OTHER**: None of the above

**IMPORTANT: Respond with ONLY the JSON below. No other text, no explanation, no markdown outside the JSON block.**

```json
{{
  "category": "CATEGORY_NAME",
  "short_description": "10 words max",
  "detailed_description": "What went wrong in your reasoning",
  "fix": "Generalizable prompt improvement advice",
  "gold_tables": ["table1", "table2"],
  "predicted_tables": ["table1", "table2"]
}}
```"""


class ErrorInvestigator:
    """
    Investigates incorrect SQL predictions using conversation continuation.

    The same model that made the prediction analyzes its own mistake with
    full context of its reasoning process.
    """

    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.error_logs_dir = log_dir / "error_logs"
        self.error_logs_dir.mkdir(parents=True, exist_ok=True)

        # Create timestamped log file for this run
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_file = self.error_logs_dir / f"errors_{timestamp}.jsonl"

    def _extract_dataset(self, database_name: str) -> str:
        """Extract dataset letter from database name."""
        if "bird_bench_a" in database_name:
            return "a"
        elif "bird_bench_b" in database_name:
            return "b"
        elif "bird_bench_c" in database_name:
            return "c"
        return "unknown"

    def _format_result(self, result) -> str:
        """Format SQL result for prompt, sampling to 20 rows max."""
        if isinstance(result, str) and "ERROR" in result:
            return result
        if not result:
            return "(empty result)"
        if isinstance(result, list):
            total = len(result)
            rows = result[:20]
            formatted = "\n".join(str(row) for row in rows)
            if total > 20:
                formatted += f"\n... (sampled 20 of {total} total rows)"
            return formatted
        return str(result)

    def _sanitize_messages(self, messages: list[dict]) -> list[dict]:
        """
        Sanitize conversation history to standard OpenAI format.

        Removes provider-specific fields and converts tool messages to
        a format compatible with all providers.
        """
        sanitized = []
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content")

            if role == "system":
                sanitized.append({"role": "system", "content": content or ""})
            elif role == "user":
                sanitized.append({"role": "user", "content": content or ""})
            elif role == "assistant":
                # Include content, skip tool_calls for simplicity
                # (investigation doesn't need to re-run tools)
                if content:
                    sanitized.append({"role": "assistant", "content": content})
            elif role == "tool":
                # Convert tool result to assistant message summarizing the result
                tool_name = msg.get("tool_name", "tool")
                result = msg.get("result", "")
                # Truncate long results
                result_str = str(result)[:500]
                if len(str(result)) > 500:
                    result_str += "... (truncated)"
                sanitized.append({
                    "role": "assistant",
                    "content": f"[Tool {tool_name} returned: {result_str}]"
                })

        # Ensure we have at least one message
        if not sanitized:
            sanitized.append({
                "role": "user",
                "content": "(No conversation history available)"
            })

        return sanitized

    async def investigate(
        self,
        provider,  # OpenRouterProvider - same one used for evaluation
        conversation_history: list[dict],  # From raw_response["messages"]
        question_id: int,
        db_id: str,
        database_name: str,
        model_name: str,
        gold_sql: str,
        predicted_sql: str,
        gold_result: list | str,
        predicted_result: list | str,
        correctness_level: str,
        partial_reason: str | None,
        hit_iteration_limit: bool = False,
    ) -> ErrorInvestigation:
        """
        Investigate why a prediction was incorrect by continuing the conversation.

        The model reflects on its own reasoning with full context.
        """
        # Translate gold SQL from SQLite to DuckDB dialect for fair comparison
        try:
            gold_sql_duckdb = translate_sqlite_to_duckdb(gold_sql, db_id)
        except Exception:
            # Fallback to original if translation fails
            gold_sql_duckdb = gold_sql

        # Build investigation prompt
        investigation_prompt = INVESTIGATION_PROMPT.format(
            gold_sql_duckdb=gold_sql_duckdb,
            gold_result=self._format_result(gold_result),
            predicted_sql=predicted_sql or "(no SQL generated)",
            predicted_result=self._format_result(predicted_result),
        )

        # Add context if hit iteration limit
        if hit_iteration_limit:
            investigation_prompt = f"**Note: You ran out of tool calls (hit the 10 iteration limit) before completing this query.**\n\n{investigation_prompt}"

        # Continue the conversation - add investigation prompt as new user message
        # Sanitize messages to only include standard fields that all providers support
        messages = self._sanitize_messages(conversation_history)
        messages.append({"role": "user", "content": investigation_prompt})

        # Build extra_body for OpenRouter-specific features
        extra_body = {}
        if provider.config.provider:
            extra_body["provider"] = provider.config.provider

        # Call API to continue conversation
        response = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: provider.client.chat.completions.create(
                model=provider.config.model_id,
                messages=messages,
                max_tokens=2048,
                temperature=0.0,
                extra_body=extra_body if extra_body else None,
            )
        )

        response_text = response.choices[0].message.content or ""

        # Parse JSON response
        parsed = self._parse_investigation_response(response_text)

        investigation = ErrorInvestigation(
            question_id=question_id,
            db_id=db_id,
            dataset=self._extract_dataset(database_name),
            model=model_name,
            category=parsed.get("category", "OTHER"),
            short_description=parsed.get("short_description", ""),
            detailed_description=parsed.get("detailed_description", ""),
            fix=parsed.get("fix", ""),
            gold_tables=parsed.get("gold_tables", []),
            predicted_tables=parsed.get("predicted_tables", []),
            correctness_level=correctness_level,
            partial_reason=partial_reason,
            gold_sql_duckdb=gold_sql_duckdb,
            predicted_sql=predicted_sql or "",
            gold_result=self._format_result(gold_result),
            predicted_result=self._format_result(predicted_result),
        )

        # Write to JSONL log
        self._log_investigation(investigation)

        return investigation

    def _log_investigation(self, investigation: ErrorInvestigation):
        """Append investigation to JSONL log file."""
        with open(self.log_file, "a") as f:
            f.write(json.dumps(asdict(investigation)) + "\n")

    def _parse_investigation_response(self, response_text: str) -> dict:
        """Parse JSON from investigation response with multiple fallback strategies."""
        import re

        # Strategy 1: Look for ```json ... ``` code block
        json_match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Strategy 2: Look for any ``` ... ``` code block that contains JSON
        code_match = re.search(r'```\s*(.*?)\s*```', response_text, re.DOTALL)
        if code_match:
            try:
                return json.loads(code_match.group(1))
            except json.JSONDecodeError:
                pass

        # Strategy 3: Look for raw JSON object anywhere in response
        json_match = re.search(r'\{[^{}]*"category"[^{}]*\}', response_text, re.DOTALL)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass

        # Strategy 4: Try to find JSON with nested objects
        brace_start = response_text.find('{')
        if brace_start != -1:
            # Find matching closing brace
            depth = 0
            for i, c in enumerate(response_text[brace_start:]):
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(response_text[brace_start:brace_start + i + 1])
                        except json.JSONDecodeError:
                            break

        # Fallback if all parsing fails - include full response for debugging
        return {
            "category": "OTHER",
            "short_description": "Failed to parse JSON - see full response below",
            "detailed_description": response_text,  # Full response for debugging
            "fix": "",
            "gold_tables": [],
            "predicted_tables": [],
        }

    def close(self):
        """Clean up resources (no-op now, but kept for interface compatibility)."""
        pass
