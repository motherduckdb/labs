"""Strip secrets before any text leaves a pipeline: logs, HEAL_EVENTs, Jev input, LLM prompts, GitHub."""
import os
import re

_PATTERNS = [
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "<github-token>"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "<github-token>"),
    (re.compile(r"sk-or-[A-Za-z0-9-]{20,}"), "<openrouter-key>"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "<api-key>"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "<jwt>"),
    (re.compile(r"(?i)(authorization|x-api-key|api[_-]?key)\s*[:=]\s*\S+(\s+\S+)?"), r"\1: <redacted>"),
    (re.compile(r"(?i)\b(bearer|token)\s+[A-Za-z0-9._~+/-]{16,}=*"), r"\1 <redacted>"),
    # URL query params whose names look secret: ?token=..., &api_key=..., &sig=...
    (re.compile(r"(?i)([?&](?:access_)?(?:token|key|api_key|apikey|sig|signature|secret|password)=)[^&\s\"']+"), r"\1<redacted>"),
]


def _env_secrets() -> list[str]:
    return [v for k, v in os.environ.items()
            if v and len(v) >= 12 and any(s in k.upper() for s in ("TOKEN", "KEY", "SECRET", "PASSWORD"))]


def redact(text) -> str:
    if text is None:
        return text
    s = str(text)
    for value in _env_secrets():
        s = s.replace(value, "<redacted>")
    for pat, repl in _PATTERNS:
        s = pat.sub(repl, s)
    return s
