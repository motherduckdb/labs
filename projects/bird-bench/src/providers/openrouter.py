import asyncio
import json
import os
import re
import time
from typing import Any

from openai import OpenAI
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

from .base import BaseProvider, ModelConfig
from src.mcp_client import MCP_TOOL_DEFINITIONS
from src.constants import MAX_TOOL_ITERATIONS, CHARS_PER_TOKEN_ESTIMATE
class OpenRouterProvider(BaseProvider):
    """Provider using OpenRouter's OpenAI-compatible API with MCP tools."""

    OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

    def __init__(self, config: ModelConfig, motherduck_token: str, use_optimized_prompts: bool = False, shared_mcp_client=None):
        super().__init__(config, motherduck_token, use_optimized_prompts, shared_mcp_client)
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY environment variable not set")

        # Build headers, optionally including provider API keys for BYOK
        headers = {
            "HTTP-Referer": "https://github.com/bird-bench-eval",
            "X-Title": "BIRD-Bench Evaluation",
        }

        # Pass through provider API keys if available (BYOK mode)
        if os.environ.get("OPENAI_API_KEY"):
            headers["X-OpenAI-Api-Key"] = os.environ["OPENAI_API_KEY"]
        if os.environ.get("ANTHROPIC_API_KEY"):
            headers["X-Anthropic-Api-Key"] = os.environ["ANTHROPIC_API_KEY"]
        if os.environ.get("GOOGLE_API_KEY"):
            headers["X-Google-Api-Key"] = os.environ["GOOGLE_API_KEY"]

        self.client = OpenAI(
            base_url=self.OPENROUTER_BASE_URL,
            api_key=api_key,
            default_headers=headers
        )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=4, max=60),
        retry=retry_if_exception_type((Exception,)),
        reraise=True,
    )
    def _call_api(self, messages: list, tools: list, temperature: float | None = None) -> Any:
        """Make API call with retry logic.

        Args:
            messages: Chat messages
            tools: Tool definitions
            temperature: Optional temperature override (for thread-safe candidate generation)
        """
        # Build extra_body for OpenRouter-specific features
        extra_body = {}
        if self.config.provider:
            extra_body["provider"] = self.config.provider

        return self.client.chat.completions.create(
            model=self.config.model_id,
            messages=messages,
            tools=tools,
            tool_choice="auto",
            max_tokens=self.config.max_tokens,
            temperature=temperature if temperature is not None else self.config.temperature,
            extra_body=extra_body if extra_body else None,
            timeout=60.0,  # 1 minute timeout per API call (retried by tenacity)
        )

    async def run_query(
        self,
        question: str,
        evidence: str,
        db_id: str,
        motherduck_db: str = None,
        relevant_tables: list[str] = None
    ) -> tuple[str | None, dict]:
        """Run text-to-SQL query using OpenRouter with MCP tools."""
        start_time = time.time()
        predicted_sql = None
        final_sql_submitted = False  # Track if model submitted FINAL_SQL (not just query tool calls)
        tool_calls_count = 0
        total_input_tokens = 0
        total_output_tokens = 0
        actual_cost = 0.0  # Actual cost from OpenRouter
        actual_upstream_cost = 0.0  # Upstream cost for BYOK
        error = None
        raw_messages = []
        thinking_content = []  # Collect thinking/reasoning from models that support it

        system_content = self.build_system_prompt(db_id, motherduck_db)
        user_content = self.build_user_prompt(question, evidence, db_id, relevant_tables)

        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

        # Add initial messages to raw_messages for verification/debugging
        raw_messages.append({"role": "system", "content": system_content})
        raw_messages.append({"role": "user", "content": user_content})

        # Use all MCP tool definitions
        tools = MCP_TOOL_DEFINITIONS

        # controllog logging happens at the runner level (eval/runner.py) per
        # evaluated question — no duplicate logging here.

        hit_iteration_limit = False
        already_nudged_for_final = False  # Track if we've already asked for FINAL_SQL

        try:
            for iteration in range(MAX_TOOL_ITERATIONS):
                # Run API call in thread pool to not block event loop
                response = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._call_api(messages, tools)
                )

                # Track token usage and costs from OpenRouter response
                if response.usage:
                    total_input_tokens += response.usage.prompt_tokens or 0
                    total_output_tokens += response.usage.completion_tokens or 0

                # Extract actual costs from OpenRouter response (if available)
                # OpenRouter returns cost info in response.usage.model_extra for BYOK
                if response.usage and hasattr(response.usage, 'model_extra') and response.usage.model_extra:
                    usage_extra = response.usage.model_extra
                    # Direct cost (OpenRouter markup, 0 for BYOK)
                    if 'cost' in usage_extra:
                        actual_cost += usage_extra.get('cost', 0) or 0
                    # Upstream cost is in cost_details for BYOK
                    cost_details = usage_extra.get('cost_details', {})
                    if cost_details and 'upstream_inference_cost' in cost_details:
                        actual_upstream_cost += cost_details.get('upstream_inference_cost', 0) or 0

                msg = response.choices[0].message

                # Capture thinking/reasoning if model returns it (e.g., Claude extended thinking)
                if hasattr(msg, 'thinking') and msg.thinking:
                    thinking_content.append(msg.thinking)
                elif hasattr(msg, 'reasoning') and msg.reasoning:
                    thinking_content.append(msg.reasoning)

                raw_messages.append({
                    "role": "assistant",
                    "content": msg.content,
                    "thinking": getattr(msg, 'thinking', None) or getattr(msg, 'reasoning', None),
                    "tool_calls": [
                        {"name": tc.function.name, "arguments": tc.function.arguments}
                        for tc in (msg.tool_calls or [])
                    ] if msg.tool_calls else None
                })

                # Handle tool calls
                if msg.tool_calls:
                    # Add assistant message with tool calls
                    messages.append({
                        "role": "assistant",
                        "content": msg.content,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments
                                }
                            }
                            for tc in msg.tool_calls
                        ]
                    })

                    # Process each tool call
                    for tc in msg.tool_calls:
                        tool_calls_count += 1
                        tool_name = tc.function.name

                        try:
                            args = json.loads(tc.function.arguments)
                        except json.JSONDecodeError as e:
                            result = {"success": False, "error": f"Invalid JSON: {e}"}
                            messages.append({
                                "role": "tool",
                                "tool_call_id": tc.id,
                                "content": json.dumps(result)
                            })
                            continue

                        # Execute the MCP tool (enforce correct database)
                        result = self.execute_tool(tool_name, args, db_id, motherduck_db=motherduck_db)

                        # Track SQL from query tool
                        if tool_name == "query" and "sql" in args:
                            predicted_sql = args["sql"]

                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": json.dumps(result, default=str)
                        })

                        raw_messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "tool_name": tool_name,
                            "arguments": args,
                            "result": result
                        })

                    # Add iteration countdown warning when running low
                    remaining = MAX_TOOL_ITERATIONS - iteration - 1
                    if remaining <= 5 and remaining > 0:
                        if remaining == 1:
                            # Final warning - maximum urgency, explicitly forbid tool calls
                            warning = "🚨 FINAL WARNING: You have ONE request left. Do NOT make any more tool calls. Output your FINAL_SQL now with your best query, even if imperfect. Any tool call will cause failure."
                        elif remaining <= 3:
                            # Increased urgency
                            warning = f"⚠️ {remaining} requests left. Wrap up now and submit your FINAL_SQL soon."
                        else:
                            warning = f"⚠️ {remaining} tool calls remaining. Remember to submit FINAL_SQL before running out."
                        messages.append({"role": "user", "content": warning})
                        raw_messages.append({"role": "user", "content": warning})
                else:
                    # No tool calls - check for final answer
                    if msg.content:
                        final_sql = self._extract_final_sql(msg.content)
                        if final_sql:
                            predicted_sql = final_sql
                            final_sql_submitted = True
                    break

                # Check stop reason
                if response.choices[0].finish_reason == "stop":
                    if msg.content:
                        final_sql = self._extract_final_sql(msg.content)
                        if final_sql:
                            predicted_sql = final_sql
                            final_sql_submitted = True
                            break

                    # Model stopped without FINAL_SQL - prompt for it explicitly (once)
                    if not final_sql_submitted and predicted_sql and not already_nudged_for_final:
                        # We have SQL from a query tool call, ask model to confirm it
                        already_nudged_for_final = True
                        nudge = "You've tested your query successfully. Now output your final answer in this exact format:\n\nFINAL_SQL: ```sql\nYOUR QUERY\n```"
                        messages.append({"role": "user", "content": nudge})
                        raw_messages.append({"role": "user", "content": nudge})
                        continue  # One more iteration to get FINAL_SQL
                    break

                # Also check for FINAL_SQL even if there were tool calls
                # (model might submit answer alongside tool calls on last iteration)
                if msg.content:
                    final_sql = self._extract_final_sql(msg.content)
                    if final_sql:
                        predicted_sql = final_sql
                        final_sql_submitted = True
                        break
            else:
                # Loop completed without breaking - hit_limit unless FINAL_SQL was submitted
                if not final_sql_submitted:
                    hit_iteration_limit = True

        except Exception as e:
            error = str(e)

        duration_ms = int((time.time() - start_time) * 1000)

        # Use upstream cost for BYOK, or OpenRouter cost otherwise
        # For BYOK mode, actual_cost is 0 and actual_upstream_cost has the real cost
        cost_usd = actual_upstream_cost if actual_upstream_cost > 0 else actual_cost

        return predicted_sql, {
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "duration_ms": duration_ms,
            "tool_calls": tool_calls_count,
            "error": error,
            "cost_usd": cost_usd,
            "upstream_cost_usd": actual_upstream_cost if actual_upstream_cost > 0 else None,
            "raw_messages": raw_messages,
            "hit_iteration_limit": hit_iteration_limit,
        }

    def _extract_final_sql(self, content: str) -> str | None:
        """Extract SQL from FINAL_SQL marker in response."""
        # Try code block format first
        match = re.search(
            r'FINAL_SQL:\s*```(?:sql)?\s*(.+?)\s*```',
            content,
            re.DOTALL | re.IGNORECASE
        )
        if match:
            return match.group(1).strip()

        # Try inline format
        match = re.search(
            r'FINAL_SQL:\s*(.+?)(?:\n\n|$)',
            content,
            re.DOTALL | re.IGNORECASE
        )
        if match:
            sql = match.group(1).strip()
            # Clean up any trailing markdown
            sql = re.sub(r'```\s*$', '', sql).strip()
            return sql

        return None
