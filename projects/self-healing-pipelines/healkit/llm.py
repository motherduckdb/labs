"""Minimal OpenRouter client: JSON-mode chat with cost accounting. Used for Jev fallbacks and the approver."""
import json
import os
import time

import requests

from .redact import redact

URL = "https://openrouter.ai/api/v1/chat/completions"


def api_key() -> str:
    key = os.environ.get("openrouter_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("no OpenRouter key: add the `openrouter` flight secret")
    return key


def chat_json(model: str, system: str, user: str, *, max_tokens: int = 2000, reasoning: str | None = None,
              timeout: float = 300, retries: int = 2) -> tuple[dict, float, dict]:
    """Returns (parsed JSON object, cost_usd, raw usage). Text is redacted before it leaves."""
    body = {
        "model": model, "max_tokens": max_tokens, "response_format": {"type": "json_object"},
        "usage": {"include": True},
        "messages": [{"role": "system", "content": redact(system)}, {"role": "user", "content": redact(user)}],
    }
    if reasoning:
        body["reasoning"] = {"effort": reasoning}
    last = None
    for attempt in range(retries + 1):
        try:
            r = requests.post(URL, json=body, timeout=timeout, headers={
                "Authorization": f"Bearer {api_key()}", "HTTP-Referer": "https://github.com/motherduckdb/labs",
                "X-Title": "self-healing-pipelines"})
            r.raise_for_status()
            d = r.json()
            text = d["choices"][0]["message"]["content"] or "{}"
            text = text.strip().removeprefix("```json").removesuffix("```").strip()
            usage = d.get("usage") or {}
            return json.loads(text), float(usage.get("cost") or 0.0), usage
        except (requests.RequestException, json.JSONDecodeError, KeyError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"OpenRouter call to {model} failed: {last}")
