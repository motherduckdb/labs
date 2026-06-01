# Demo validation harness

The demo harness validates the canonical `nba_box_scores_v2` flow end to end
with deterministic mocked MCP and LLM behavior by default. It exercises the same
agent loop, SSE encoder, local context store, chat persistence, schema parsers,
and mviz rendering path used by the app.

## Run

```bash
npm run demo:validate
```

Each run writes:

- `reports/demo-validation/latest.md` — concise human report.
- `reports/demo-validation/latest.json` — full transcript, tool calls, SSE
  events, assertions, and issue records.
- `reports/demo-validation/<run-id>.md/json` — timestamped copies ignored by
  git.

The default run is deterministic and requires no tokens. It validates:

- Database selection includes `nba_box_scores_v2`.
- Schema browsing finds `main.schedule`, `main.box_scores`, and join columns.
- Context `query_context_layer` and `update_context_layer` create, read, update,
  and delete local fragments.
- Adversarial NBA questions verify the assistant filters mixed-grain box-score
  rows before team aggregation, persists durable grain rules, and refuses to
  invent unsupported injury analysis.
- Conversation persistence strips transient state and reopens with structured
  tool history, not context placeholders.
- Database switching keeps conversation and schema state scoped to the selected
  database.
- Tool request and response SSE events are visible.
- mviz `table` and `bar` fenced blocks render as inline HTML instead of raw
  JSON.

## Optional live mode

```bash
MOTHERDUCK_TOKEN=... OPENROUTER_API_KEY=... npm run demo:validate:live
```

Live mode uses the real MotherDuck MCP transport and OpenRouter LLM path when
both tokens are present. It writes the same report shape as the mock run, so
demo-readiness regressions can be compared across deterministic and live runs.

## Gate

A demo-ready run must have `Unresolved P1/P2: 0` in
`reports/demo-validation/latest.md`. P3 findings may remain as known polish or
observability follow-ups.
