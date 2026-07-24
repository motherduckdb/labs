# Context layer → MCP guides migration

Status as of 2026-07-15, **updated 2026-07-23 for the topic/uuid guide
surface**. The IndexedDB context layer (the placeholder built while the real
context engine was in flight) has been **replaced in the live app** by the
MotherDuck **guide subsystem**. This doc records what shipped and the work
that was deliberately **deferred** to keep the workshop demo green.

> **2026-07-23 — topic/uuid migration.** The MCP guide platform moved from
> path-addressing (`get_guide("guides.md")`, `users/<username>/…` namespaces)
> to **topic/uuid addressing**: `list_guides({topic})` navigates folder-like
> topics, `get_guide({uuid})` reads a guide, `get_query_guide` is the org-wide
> bootstrap, and privacy is the `access` field (`user` = private). data-chat-mini
> migrated accordingly (same change as quackbot PR #81 / agentic-sql-context-mcp
> PR #83): the write guard now forces `access:"user"` and confines model creates
> to the `data-chat-mini/…` topic; uuid-targeted writes are resolved via
> `get_guide` and refused unless the target is private; `/api/guides` and the
> sidebar guide manager are uuid/topic-based (lazy per-topic listing). Note the
> new surface does NOT deduplicate creates — the prompt mandates
> list-before-create. Any path-era references below are historical.

The guide subsystem is now available on the production MCP. data-chat-mini
defaults to `https://api.motherduck.com`; run `npm run mcp:validate` with the
deployment PAT before each production rollout to verify tool discovery and the
two read entry points (`get_query_guide`, `list_guides`).

## What the guide subsystem is

The MCP has no `query_context_layer`/`update_context_layer`. Its context engine
is **guides** — versioned markdown with `path`, `title`, `description`,
structured `references`, and `access` (`user` = private personal, `organization`
= admin-only org truth). Personal guides live at `users/<username>/…` and
overlay-merge onto org guides.

- **Read:** `get_guide`, `list_guides` (already allowlisted; the model reads
  `guides.md` once per conversation, then relevant table/topic guides).
- **Write:** `create_guide`, `update_guide`, `edit_guide_content` — now
  allowlisted and constrained to **personal** guides by
  `assertGuideWriteAllowed` (`lib/mcp-client.ts`): org-wide writes and non-`users/`
  paths are rejected before dispatch.

Verified 2026-07-08 against staging: a user-scoped `MOTHERDUCK_TOKEN` can
create/edit/delete personal guides as `owner_name: matson`. A live chat turn drove
`get_guide("guides.md")` → `list_tables` → `get_guide(nba guide)` →
`create_guide(users/matson/…)` end-to-end with no local round-trip.

## What shipped (live app)

| File | Change |
|---|---|
| `lib/mcp-client.ts` | Allowlisted guide-write tools; `GUIDE_WRITE_TOOLS` + `assertGuideWriteAllowed` personal-guide guard, enforced in `executeToolWithStatus`. `requiresConfirmation` auto-allows personal guide writes. |
| `lib/system-prompt.ts` | Replaced the mandatory local `query_context_layer` Step-0 protocol with the guide protocol (read `guides.md` first; persist durable learnings as small personal guides). Guide sections gate on `get_guide`/`create_guide` presence. |
| `app/api/chat/route.ts` | Stopped advertising `CONTEXT_TOOLS` to the model. Guide tools dispatch like any MCP tool. |
| `app/api/guides/route.ts` | **New.** `GET` → `list_guides()`; `GET ?path=` → `get_guide(path)`. |
| `app/chat/SchemaExplorerSidebar.tsx` | Context panel now renders MCP guides (from `/api/guides`) instead of IndexedDB fragments; db/all scope; lazy content load; access badge. |
| `app/chat/ChatPanel.tsx` | Refreshes the guide panel when a guide-write `tool_end` is observed. |

## Deferred (follow-up) — kept the demo green instead

The workshop demo (`lib/demo-mode.ts`, the recorded gold transcript
`reports/demo-validation/latest.json`, `demo/demo-validation.test.ts`, and the
on-screen step narration) is still built around the **local context layer**.
Because a faithful re-record writes guides to staging and rewrites workshop copy,
that was deferred. As a result the following remain in the tree, **unused by the
live app** but load-bearing for the demo:

- `lib/context-tools.ts`, `lib/context-store.ts` (+ `context-store.test.ts`)
- The context round-trip plumbing: `isContextTool`/`context_pause` in
  `lib/agentic-loop.ts`, the `resolvedContext` resume block in
  `app/api/chat/route.ts`, `serviceContextTool` recursion + `patchHistoryPlaceholders`
  in `app/chat/ChatPanel.tsx`, `sseContextTool`, and the `ResolvedContextTool` /
  `resolvedContext` types.

### Follow-up tasks

1. **Re-record the guide-based demo.** Rewrite the `demo-mode.ts` steps + mock
   script to the guide flow (`get_guide` reads, `create_guide`/`edit_guide_content`
   writes), regenerate `latest.json` (a live run writes a `users/matson/…` guide),
   and update the step narration ("save context" → "save a personal guide").
2. **Then delete the dead round-trip.** Once the demo no longer needs them,
   remove the files/plumbing listed above.
3. **Panel niceties (optional).** Restore table↔guide linking (badge + click-to-
   filter) using `list_guides`' structured `references` / reverse `reference`
   lookup — dropped in this pass because `list_guides` summaries omit references.
4. ~~**Prod fallback.**~~ **Resolved 2026-07-15:** production now advertises the
   guide subsystem and data-chat-mini targets it by default. Production still
   needs a user-scoped PAT so personal guide creation has a username claim.

### Known race (pre-existing)

`demo/demo-validation.test.ts` rewrites `reports/demo-validation/latest.json` at
runtime while `lib/demo-mode.test.ts` imports it. In a parallel `vitest run` a
mid-write read can transiently fail the `latest.json` content assertion. It
resolves on re-run once the file is consistent. Folded into task 1's re-record.
