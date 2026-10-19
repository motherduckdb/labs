"""L0 normalize + fingerprint + token similarity for failure events (§05). Pure functions, unit-tested."""
import hashlib
import re

_URL = re.compile(r"https?://([^/\s:]+)(?::\d+)?(/[^\s\"'<>)]*)?")
_MASKS = [
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<uuid>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b"), "<ts>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}\b"), "<date>"),
    (re.compile(r"\b[0-9a-f]{12,40}\b", re.I), "<hex>"),
    (re.compile(r"(/tmp|/var|/home|/usr|/opt)/[^\s:\"']+"), "<path>"),
    (re.compile(r"\b0x[0-9a-f]+\b", re.I), "<addr>"),
    (re.compile(r"(?<![\w<])-?\d+(\.\d+)?(?![\w>])"), "<n>"),
]
_HTTP = re.compile(r"\bHTTP <n> from")


def normalize(msg: str) -> str:
    """Mask the parts of an error message that vary between occurrences of the same failure."""
    s = (msg or "").strip()
    # URLs keep scheme+host and the first path segment only: per-article/per-date paths vary run to run.
    s = _URL.sub(lambda m: f"https://{m.group(1)}/{(m.group(2) or '/').split('/')[1] if m.group(2) else ''}<…>", s)
    # Keep HTTP status codes: 403 and 429 from the same host are different failures.
    statuses = re.findall(r"\bHTTP (\d{3})\b", s)
    for pat, repl in _MASKS:
        s = pat.sub(repl, s)
    for code in statuses:
        s = s.replace("HTTP <n>", f"HTTP {code}", 1)
    s = re.sub(r"\s+", " ", s)
    return s[:600]


def fingerprint(pipeline: str | None, error_type: str | None, norm_msg: str, frames: list[str] | None) -> str:
    key = "|".join([pipeline or "-", error_type or "-", norm_msg, ",".join((frames or [])[:3])])
    return hashlib.sha1(key.encode()).hexdigest()[:16]


def tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^\w<>]+", (s or "").lower()) if len(t) > 1}


def jaccard(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    return len(ta & tb) / len(ta | tb) if ta and tb else 0.0
