"""Semantic-layer context store backing the `fetch_context` tool.

Knowledge that used to be dumped wholesale into the system prompt (fee-matching
rules, bucketing logic, term mappings, SQL patterns, format rules) lives here as
discrete *context items* — one markdown file per item under `context/items/`,
each with YAML frontmatter:

    ---
    id: fees-matching-9dim
    domain: fees
    summary: How a payment matches fee rules across all 9 dimensions (NULL = wildcard).
    ---
    <full markdown body>

The agent navigates this store progressively, exactly like Anthropic's
self-service-analytics semantic layer:

    fetch_context()                      -> list of domains (+ one-line each)
    fetch_context(domains=["fees"])      -> {id, summary} for every item in a domain
    fetch_context(ids=["fees-matching-9dim"]) -> full body of those items

Each domain also carries a one-sentence description, taken from a `domain:`
description item if present, else synthesized from the domain name.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ITEMS_DIR = REPO_ROOT / "context" / "items"

# One-line description per domain, shown by the no-arg fetch_context() call.
DOMAIN_DESCRIPTIONS: dict[str, str] = {
    "schema": "Tables, columns, relationships, and what 'the dataset' means.",
    "fees": "How fee rules match transactions and how the fee amount is computed.",
    "bucketing": "How capture_delay / monthly_volume / monthly_fraud_level and months are bucketed.",
    "terminology": "Code lookups (account_type, ACI, MCC) and how question wording maps to fields.",
    "sql_patterns": "Verified DuckDB query templates for the hard fee/steering question types.",
    "answer_format": "Strict validator rules: exact format, rounding, separators, empty vs Not Applicable.",
}

# Stable display order for domains.
DOMAIN_ORDER = list(DOMAIN_DESCRIPTIONS.keys())

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


@dataclass(frozen=True)
class ContextItem:
    id: str
    domain: str
    summary: str
    body: str


def _parse_frontmatter(text: str, path: Path) -> ContextItem:
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(f"context item {path} is missing YAML frontmatter")
    raw_meta, body = m.group(1), m.group(2).strip()
    meta: dict[str, str] = {}
    for line in raw_meta.splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, _, val = line.partition(":")
        meta[key.strip()] = val.strip().strip('"').strip("'")
    missing = [k for k in ("id", "domain", "summary") if k not in meta]
    if missing:
        raise ValueError(f"context item {path} missing frontmatter keys: {missing}")
    return ContextItem(id=meta["id"], domain=meta["domain"], summary=meta["summary"], body=body)


class ContextStore:
    """In-memory index over all context items. Cheap to build; load once."""

    def __init__(self, items_dir: Path = ITEMS_DIR) -> None:
        self.items_dir = items_dir
        self._by_id: dict[str, ContextItem] = {}
        self._by_domain: dict[str, list[ContextItem]] = {}
        self._load()

    def _load(self) -> None:
        if not self.items_dir.exists():
            raise FileNotFoundError(f"context items dir not found: {self.items_dir}")
        for path in sorted(self.items_dir.glob("*.md")):
            item = _parse_frontmatter(path.read_text(), path)
            if item.id in self._by_id:
                raise ValueError(f"duplicate context id {item.id!r} ({path})")
            self._by_id[item.id] = item
            self._by_domain.setdefault(item.domain, []).append(item)

    # -- ordering helpers ---------------------------------------------------

    def _ordered_domains(self) -> list[str]:
        known = [d for d in DOMAIN_ORDER if d in self._by_domain]
        extra = sorted(d for d in self._by_domain if d not in DOMAIN_ORDER)
        return known + extra

    # -- the three fetch_context modes -------------------------------------

    def list_domains(self) -> list[dict]:
        out = []
        for d in self._ordered_domains():
            out.append(
                {
                    "domain": d,
                    "description": DOMAIN_DESCRIPTIONS.get(d, f"Context for {d}."),
                    "n_items": len(self._by_domain[d]),
                }
            )
        return out

    def list_items(self, domains: list[str]) -> tuple[list[dict], list[str]]:
        """Return ({id, domain, summary} dicts, unknown_domain_names)."""
        items: list[dict] = []
        unknown: list[str] = []
        seen_ids: set[str] = set()
        for d in domains:
            key = d.strip()
            if key not in self._by_domain:
                unknown.append(key)
                continue
            for it in self._by_domain[key]:
                if it.id in seen_ids:
                    continue
                seen_ids.add(it.id)
                items.append({"id": it.id, "domain": it.domain, "summary": it.summary})
        return items, unknown

    def get_items(self, ids: list[str]) -> tuple[list[ContextItem], list[str]]:
        """Return (items, unknown_ids)."""
        found: list[ContextItem] = []
        unknown: list[str] = []
        for i in ids:
            key = i.strip()
            if key in self._by_id:
                found.append(self._by_id[key])
            else:
                unknown.append(key)
        return found, unknown


# ---------------------------------------------------------------------------
# String rendering for the tool surface
# ---------------------------------------------------------------------------


def _split_arg(value) -> list[str]:
    """Accept a list, a comma/whitespace string, or None. Returns clean tokens."""
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[,\n]", value)
        return [p.strip() for p in parts if p.strip()]
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for v in value:
            out.extend(_split_arg(v))
        return out
    return [str(value).strip()]


def render_fetch_context(store: ContextStore, domains=None, ids=None) -> str:
    """Render the fetch_context tool output for all three modes.

    Precedence: ids > domains > (neither -> domain list).
    """
    id_tokens = _split_arg(ids)
    domain_tokens = _split_arg(domains)

    if id_tokens:
        items, unknown = store.get_items(id_tokens)
        chunks: list[str] = []
        for it in items:
            chunks.append(f"### {it.id}  (domain: {it.domain})\n{it.body}")
        # Tolerate a common mistake: passing a DOMAIN name in `ids`. Surface that
        # domain's item list instead of silently returning nothing.
        domain_names = {d["domain"] for d in store.list_domains()}
        as_domains = [u for u in unknown if u in domain_names]
        truly_unknown = [u for u in unknown if u not in domain_names]
        if as_domains:
            ditems, _ = store.list_items(as_domains)
            lines = [
                f"[note: {', '.join(as_domains)} is a DOMAIN, not an item id — here are "
                f"its items; call fetch_context(ids=[...]) with one of these:]"
            ]
            for it in ditems:
                lines.append(f"- {it['id']}  [{it['domain']}] — {it['summary']}")
            chunks.append("\n".join(lines))
        valid_domains = ", ".join(d["domain"] for d in store.list_domains())
        if truly_unknown:
            chunks.append(
                f"[unknown ids: {', '.join(truly_unknown)}. To browse, call "
                f"fetch_context(domains=[...]) — valid domains: {valid_domains}]"
            )
        if not items and not as_domains:
            return (
                f"No context found for ids: {', '.join(id_tokens)}. Call "
                f"fetch_context(domains=[...]) to see valid ids. Domains: {valid_domains}"
            )
        return "\n\n".join(chunks)

    if domain_tokens:
        items, unknown = store.list_items(domain_tokens)
        lines: list[str] = []
        if items:
            lines.append("Context items (call fetch_context(ids=[...]) to read the full text):")
            for it in items:
                lines.append(f"- {it['id']}  [{it['domain']}] — {it['summary']}")
        if unknown:
            valid = ", ".join(d["domain"] for d in store.list_domains())
            lines.append(f"\n[unknown domains: {', '.join(unknown)}. Valid domains: {valid}]")
        if not items and not unknown:
            lines.append("(no items in the requested domains)")
        return "\n".join(lines)

    # No args -> list domains.
    lines = ["Knowledge domains (call fetch_context(domains=[...]) to see items in one or more):"]
    for d in store.list_domains():
        lines.append(f"- {d['domain']} ({d['n_items']} items) — {d['description']}")
    return "\n".join(lines)
