# Integrating the staging MCP tool surface into data-chat-mini

Companion to [mcp-prod-vs-staging-tool-diff.md](mcp-prod-vs-staging-tool-diff.md) (full per-tool diff of the two servers, 2026-07-08).

## Where we stand

data-chat-mini is already MCP-native: it pulls tool descriptions **live** from the server via
`listTools()` and passes them through unchanged (`lib/mcp-client.ts:114`), filtered by
`ALLOWED_TOOLS` (`lib/mcp-client.ts:13`):

```
query, list_tables, list_columns, list_databases, search_catalog, ask_docs_question
```

The connection URL defaults to **staging** (`lib/motherduck-env.ts:15`, `https://api.staging.motherduck.com`),
with `.env.local` setting `MOTHERDUCK_API_URL` explicitly. So description changes on shared tools
(query, list_tables, search_catalog, list_databases) already flow into the app automatically —
the allowlist is the only thing blocking the *new* staging tools.

## The bug we already have

Staging's `query` description now opens with:

> "Before writing SQL to answer a data question, call `get_guide(\"guides.md\")` first — it
> returns this organization's query guidance and the guide catalog."

When the app points at staging, the model receives that instruction verbatim — but `get_guide`
is not in the allowlist, so the model is told to call a tool it doesn't have. Same class of
problem with `list_tables`/`search_catalog` now returning `relatedGuides` paths the model
can't dereference. **Any staging deployment should ship with `get_guide` allowlisted, or the
description sanitized.**

## The design tension: guides vs. the local context layer

Staging's guides subsystem and data-chat-mini's IndexedDB context layer are the same idea at
different scopes:

| | Local context layer | MotherDuck guides (staging) |
|---|---|---|
| Tools | `query_context_layer` / `update_context_layer` (intercepted, never hit MCP) | `get_guide`, `list_guides` (+ 6 write tools) |
| Storage | Per-browser IndexedDB | Org/personal, server-side, versioned |
| Protocol | "Step 0: call first" (system prompt) | "call `get_guide('guides.md')` before SQL" (tool description) |
| Content | Small atomic fragments the agent saves itself | Curated markdown docs (metric defs, join rules, pitfalls) |

Left unreconciled, the model gets **two competing "call me first" instructions**. Proposed
resolution: treat them as layers, not rivals —

- **Guides = org truth** (curated, shared, survives the browser). Read-only from the app.
- **Context fragments = session/user learnings** (what the agent discovers while chatting).
- Ordering in the system prompt: `get_guide("guides.md")` once per conversation (cacheable —
  it's the same doc every turn), `query_context_layer` per data question as today.

Longer term (phase 3), the write-side guide tools could replace `update_context_layer` entirely
— agent learnings would persist to MotherDuck personal guides (`users/<you>/…`) instead of
IndexedDB, making them durable across browsers and shareable. That's a product decision, not
part of the first integration.

## Plan

### Phase 1 — adopt the staging read surface (small, no schema/UI work)

1. **Extend `ALLOWED_TOOLS`** (`lib/mcp-client.ts:13`) with: `get_guide`, `list_guides`,
   `list_views`, `list_macros`. All read-only. Because `getFilteredTools()` intersects the
   allowlist with what the server actually advertises, this is automatically backward-compatible
   with prod (the names simply don't appear there).
2. **Classify them** in `READONLY_TOOLS` (`lib/mcp-client.ts:30`); nothing to add to
   mutating/destructive sets.
3. **Reconcile the system prompt** (`lib/system-prompt.ts:26-35`):
   - Add the guides-then-context-layer ordering above.
   - Trim the hand-written per-tool recaps that now duplicate/contradict the live MCP
     descriptions (the recap and the live text are two sources of truth that already drift).
   - Make guide mentions conditional on the tool actually being present in this request's
     filtered tool list (prod fallback) — the route already has the filtered list in hand at
     `app/api/chat/route.ts:46`.
4. **Arg defaults / failure detection**: no changes needed — `applyToolArgDefaults()` and
   `SUCCESS_FIELD_TOOLS` (`lib/tool-invocation.ts`) don't apply to these read tools.
5. **Verify with the demo flow**: ask a data question against staging; confirm the transcript
   shows `get_guide("guides.md")` → catalog discovery → `query`, and that pointing
   `MOTHERDUCK_API_URL` at prod still works with the guide tools silently absent.

### Phase 2 — exploit the new metadata

- Surface `relatedGuides` from `list_tables`/`search_catalog` results (they arrive in the tool
  result text already; optionally parse in `lib/mcp-parsers.ts` and show in the schema sidebar).
- Use `list_databases`' new `url` field (`md:` names) anywhere we key on database identity.
- Consider seeding the conversation with `get_guide("guides.md")` server-side (fetch once in the
  chat route, inject into the system prompt) instead of burning an agent turn on it — trade-off:
  prompt tokens every turn vs. one tool round-trip per conversation.

### Phase 3 (optional, product decision) — guides as the persistent context layer

- Replace the IndexedDB interception (`lib/context-tools.ts`, `isContextTool()` in
  `lib/agentic-loop.ts:307`) with staging's real guide write tools scoped to
  `users/<username>/…` personal guides.
- Requires: `update_guide`/`create_guide`/`edit_guide_content` in the allowlist, classified as
  `MUTATING_TOOLS`, added to `SUCCESS_FIELD_TOOLS` if they return `{success:false}`-style
  payloads, plus the `requiresConfirmation()` UX for writes.
- Blocked on: staging-only availability (prod has no guides yet) and whether per-user guide
  writes fit the read-scaling-token auth model (`MOTHERDUCK_TOKEN` is a read-scaling token —
  guide writes may need a different token scope; verify with `get_short_lived_token`/docs).

## Open questions

1. **Which server is the target deployment?** If prod, phase 1 is inert-but-safe today and
   activates when guides ship to prod; if staging, phase 1 also fixes the dangling `get_guide`
   reference the app is currently exposed to.
2. **Keep or drop `ask_docs_question`'s recap** and the other system-prompt tool summaries —
   recommend dropping all recaps and letting live MCP descriptions be the single source of truth.
3. ~~Does the org have guides authored in staging yet?~~ **Checked 2026-07-08: `list_guides`
   returns 0 guides** in this staging org. Phase 1 wiring still stands (and `get_guide("guides.md")`
   still serves the built-in query-guidance scaffold), but a demo needs a couple of guides authored
   first — e.g. one per demo database with metric definitions and join rules.
