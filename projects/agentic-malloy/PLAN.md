# Plan: `agentic-malloy` — Malloy vs markdown+SQL experiment (Phase 1 MVP, Node/TS)

## Context

We're testing whether a **Malloy semantic layer** is a more token-efficient, more reliable
substrate for a data model than the existing **markdown + SQL context** approach — while
holding accuracy at or above the markdown baseline. The baseline
(`projects/agentic-sql-claude-edition`, Python) already hits 100% on DABstep (26-question
train set, ~419 held-out) using progressive-disclosure markdown context items + a SQL
agent. The experiment reuses the *same data and same eval*, swapping only the knowledge
substrate: a central Malloy model (one source per entity) plus per-query Malloy authored
by the agent. The answer is **submitted as Malloy**; SQL is exploration only. Both ends are
deterministic, so the Malloy→SQL translation is checkable.

The full experiment is three gated phases (Correctness 26/26 → Optimization →
Generalization 90%+). **This plan builds Phase 1 only** — the harness, a de-risking
Malloy-runtime spike, a model-authored layer, and the drive to 26/26 — and documents
phases 2–3 so the structure is ready but their tooling is deferred.

### Locked decisions (from user)
- **Stack: Node / TypeScript.** Malloy is native to Node, so the runtime is an in-process
  library, not a sidecar.
- **References split:** **implementation** reference is `projects/data-chat-mini` (TS:
  the agentic loop, the MotherDuck MCP client, the controllog TS port); **behavior spec**
  is `projects/agentic-sql-claude-edition` (Python: tool semantics, the DABstep scorer,
  the controllog wiring pattern, the SKILL/context approach, the data + splits).
- **Agent loop:** **fork `data-chat-mini/lib/agentic-loop.ts`** (proven OpenRouter
  streaming + multi-turn tool-calling + token/cost tracking + MCP dispatch), extended into
  the two-model author→fixer loop.
- **Data exploration: MotherDuck MCP tools** (`query`, `list_tables`, `list_columns`,
  `search_catalog`, `ask_docs_question`), dispatched via the forked `mcp-client.ts`.
  Exploration is SQL-only.
- **Substrate: all MotherDuck.** Both exploration *and* the scored Malloy answer execute on
  MotherDuck (the answer's compiled SQL runs through the MCP `query` tool — same substrate
  as the baseline, apples-to-apples). Malloy **compiles** against a **local DuckDB** built
  from the same CSVs (schema introspection + the translation-check only); execution never
  happens locally.
- **Scoring: Python sidecar.** A persistent Python process reuses
  `agentic-sql-claude-edition/src/score.py` verbatim (the official `dabstep_benchmark`
  scorer when installed, its self-contained fallback otherwise). The Node harness talks to
  it over stdio. No reimplementation of the scorer in TS.
- **Model tiering:** configurable `--author`/`--fixer`. **Official Phase-1 runs default
  `sonnet` author / `opus` fixer**; **engineering-smoke runs use cheap defaults**
  (`gemini`). Arm recorded as `run_class`.
- **Authoring path:** **Malloy-direct** (agent writes Malloy, iterates via compile+run,
  submits Malloy).
- **Provenance:** the official 26/26 must run on a **model-authored** layer (a `layer-build`
  pass writes `malloy/`); humans only edit the build prompt / SKILL, never the layer files.

## Project layout (new TS project)

`projects/agentic-malloy/` — `PROJECT_ID = "agentic-malloy"`, `AGENT_ID = "asm-malloy"`.

```
projects/agentic-malloy/
  package.json            # type:module; deps below; bin "asm-malloy"; scripts test=vitest
  tsconfig.json
  README.md               # documents: all-MotherDuck exec, local-DuckDB compile-only, version-skew caveat
  .env.example            # OPENROUTER_API_KEY, MOTHERDUCK_TOKEN, MD_DATABASE
  bin/asm-malloy.ts       # CLI entry (run via tsx)
  src/
    cli.ts                # commands: load · malloy-preflight · layer-build · evaluate · summary
    agentic-loop.ts       # FORK of data-chat-mini lib/agentic-loop.ts → two-model author→fixer
    mcp-client.ts         # FORK of data-chat-mini lib/mcp-client.ts (MotherDuck MCP; exploration + answer exec)
    controllog.ts         # FORK + EXTEND data-chat-mini lib/controllog.ts (see Controllog section)
    malloy-runtime.ts     # NEW — @malloydata/malloy compile (getSQL) + run; local DuckDB for schema
    malloy-store.ts       # NEW — hierarchical retrieval over malloy/models + _meta (replaces context_store)
    linter.ts             # NEW — deterministic Malloy fixes
    tools.ts              # tool defs: MCP exploration tools + Malloy layer tools + submit_answer
    score-client.ts       # NEW — stdio client to the Python scoring sidecar
    skill.md              # FORK of baseline SKILL.md → "how to work with the Malloy layer"
  scoring/
    score_sidecar.py      # persistent stdio server; imports the vendored score.py
    score.py              # VENDORED COPY of agentic-sql-claude-edition/src/score.py (unchanged)
    pyproject.toml        # optional dep: dabstep_benchmark (official scorer)
  malloy/
    models/               # THE SEMANTIC LAYER (the artifact under study) — model-authored
      payments_base.malloy   # source-per-entity, measures+dimensions, NO joins (per Lloyd)
      fees_base.malloy
      merchants_base.malloy
      acquirer_countries_base.malloy
      merchant_category_codes_base.malloy
      dabstep.malloy         # central: imports bases, adds joins (directionality from cardinality) + views
    _meta/<file>.yaml     # per-file metadata sidecars (keeps .malloy compilable)
    tests/                # one test per exported fragment (Phase-1 stub; full harness Phase 2)
  data/                   # COPIED: split.json, bad_golds.json, dabstep/{tasks/all.jsonl, context/}
  data/dabstep.duckdb     # built by `load` for Malloy compile + translation-check (local only)
  results/                # JSONL + controllog events.jsonl/postings.jsonl
```

**Key deps:** `@malloydata/malloy`, `@malloydata/db-duckdb`, `@modelcontextprotocol/sdk`
(MCP, from data-chat-mini), `@duckdb/node-api` (local compile DB + translation check),
`tsx`, `vitest`, `yaml`. Python sidecar: `dabstep_benchmark` (optional).

## Malloy runtime (`malloy-runtime.ts`) — native, in-process

The Node-native Malloy stack runs in-process; **no sidecar, no stdio, no subprocess** (the
biggest risk in the prior Python plan is gone). One `Runtime` over a `@malloydata/db-duckdb`
connection to `data/dabstep.duckdb` (built from the same CSVs as MotherDuck, so schema is
identical), plus an in-memory registry serving `malloy/models/*.malloy`. Per request, wrap
the agent's `run:` statement with `import "dabstep.malloy"`, then:

- **compile:** `loadQuery(src).getSQL()` → the DuckDB SQL string (always returned).
- **run (local, used only for the translation-check):** `loadQuery(src).run()`.

**Execution of the answer/exploration is NOT done by the Malloy runtime** — the compiled SQL
is handed to `mcp-client.ts` and executed on **MotherDuck via the MCP `query` tool**, so the
scored substrate equals the baseline's. Interface (TS):

```ts
compileMalloy(src: string): Promise<{ ok: boolean; sql?: string; diagnostics?: Diagnostic[] }>
runMalloyLocal(src: string, rowLimit=50): Promise<{ sql: string; rows: Row[] }>   // translation-check only
describeModel(): Promise<{ sources: ...; fields: ... }>   // boot-time → linter symbol table
```

`translation_match`: run the compiled SQL on the local DuckDB and compare its rows to the
MCP/MotherDuck result — a logged diagnostic, **warning only** (DuckDB version skew between
`@malloydata/db-duckdb` and MotherDuck is possible; score off the MotherDuck result).

**Spike gate (do this before anything else):** confirm `@malloydata/malloy` +
`@malloydata/db-duckdb` compile+`getSQL()` in-process against a local DuckDB built from the
DABstep CSVs, and that the compiled SQL executes cleanly on MotherDuck via MCP. Then
prototype `fees_base.malloy` against the **two hard fee smoke questions (1451, 1711)** — the
9-dimension wildcard fee matching over LIST columns (NULL/`[]` = wildcard, *all* matching
rules sum, no most-specific-wins) plus 1711's bucketing (monthly volume/fraud, capture-delay)
is the hardest thing to model and may need a `duckdb.sql("...")` source block inside the
Malloy. This determines whether Malloy can answer the fee questions at all.

## Deterministic linter (`linter.ts`)

Pure-TS pass run **before** every compile/run/submit; returns `{ fixedSrc, fixes }` so fixes
are logged and shown to the agent. Symbol table comes from `describeModel()` (the model's own
identifiers + canonical casing) + Malloy built-in function names — **never from the train
questions** (keeps it task-general for Phase 2). Safe fix classes only (mechanical, never
changes *what is computed*): identifier casing when exactly one case-insensitive match;
known function-name normalization (small static map); fence/wrapper stripping (```` ```malloy ````,
leading `malloy:`, trailing prose); prefix a bare `source -> {...}` with `run:`. Out of scope:
joins, measures, any semantic rewrite (left to compiler-error feedback).

## Tool surface

Exploration tools come from the **MotherDuck MCP server** (dispatched via `mcp-client.ts`,
read-only allowlist exactly as data-chat-mini enforces); Malloy tools are harness-local. All
wrapped so each tool call is recorded with timing for controllog `tool_call`/`tool_result`.

- **MCP exploration (SQL only):** `query`, `list_tables`, `list_columns`, `search_catalog`,
  `ask_docs_question` — the agent explores the MotherDuck data the same way data-chat-mini
  does. These never produce the final answer.
- `list_malloy_files(domains?)` — no args → files + 1–2 sentence metadata each (from
  `_meta/*.yaml`); `domains=[...]` → per-file summary + its exports. Progressive disclosure.
- `get_file(files)` — full `.malloy` source of named files.
- `malloy_lint(source)` — lint → compile-only (`getSQL`); returns SQL or diagnostics. No exec.
- `run_malloy(source)` — lint → compile (local) → **execute compiled SQL on MotherDuck via
  MCP**; up to 50 rows + the compiled SQL (the iteration tool).
- `submit_answer(source)` — lint → compile → execute on MotherDuck → the rows ARE the answer.
  Latches only on success (mirrors baseline `submit_answer`: execute-first, allow resubmit
  on error). On error, returns compiler/exec diagnostics verbatim (the practical LSP
  substitute). On success stores `final_malloy`, `final_compiled_sql`, `final_rows`, which go
  to the **Python scoring sidecar** (reusing `score.py`) for the verdict.

LSP: compile-error feedback is the substitute; no live language server in the loop.

## Two-model author→fixer loop (`agentic-loop.ts`)

Fork data-chat-mini's `runAgenticLoop` (it already streams OpenRouter, tracks usage/cost, and
dispatches MCP tools). Extend to two models in one task: build tools once; run the loop with
`model = author_model`. Escalate to the fixer when ANY of: (a) `run_malloy`/`submit_answer`
errors `--escalate-after` times consecutively (default 2); (b) `--max-author-turns` reached
without submitting. On escalation, continue the **same conversation/state/MCP connection**
with `model = fixer_model` plus a fixer instruction (full trace + failing Malloy +
diagnostics). Cap `--max-fixer-turns` (default 6); one author→fixer round in Phase 1. Token/
cost accrue across both models automatically since they share the task's usage accumulator;
stamp each tool call + model exchange with the `activeModel`. Loop result gains
`authorModel`, `fixerModel`, `escalated`, `escalationReason`, `fixerTurns`, `finalMalloy`,
`finalCompiledSql`. CLI: `evaluate --author sonnet --fixer opus --escalate-after 2`.

## Scoring sidecar (`scoring/`)

A persistent Python process (`score_sidecar.py`) imports the **vendored, unchanged**
`score.py` and answers stdio JSON requests: `{rows, gold, guidelines, predicted_sql,
hit_limit}` → the `ScoreResult` (`is_correct`, `correctness`, `match_source`, `reason`,
`predicted_answer`). One process per `evaluate` run; `score-client.ts` serializes requests.
This keeps scoring inline (so the per-task reward/utility postings fire at `task_complete`)
and preserves exact parity with the baseline's scorer — including the official
`dabstep_benchmark` scorer when installed. Vendoring (not importing across projects) keeps
`agentic-malloy` self-contained; if `score.py` changes upstream, re-vendor.

## Controllog monitoring (extend the TS port; viz unchanged)

`data-chat-mini/lib/controllog.ts` is emission-only and currently has `modelPrompt`,
`modelCompletion`, `toolEnd`. **Extend the fork** with the builders this experiment needs,
emitting the same `events.jsonl`/`postings.jsonl` schema the Python `controllog-viz` already
consumes (no viz/schema changes): `runMetadata`, `toolCall`/`toolResult` (paired, with
`durationMs` → `truth.time` `kind:"tool"`), `stateMove`, `utility`, and generic `event`/`post`.

**No-double-counting rule (single source of truth per quantity):**
- **model events** (`modelPrompt`/`modelCompletion`) own **token, cost, model-wall** postings;
- **tool events** (`toolCall`/`toolResult`) own **tool-latency** postings only;
- **`task_complete`** owns **state + utility** only (task wall-time is a plain field on
  `evaluation_result.duration_ms`, not a posting).

Emissions per task: `stateMove` NEW→WIP→DONE/FAILED; `modelPrompt`/`modelCompletion` per
exchange with `payload.role` ("author"|"fixer") and the correct `model`; `toolCall`/`toolResult`
per tool with `payload.model = activeModel` and `durationMs`; `task_complete` (state+utility);
`evaluation_result` (the rich trace card). `runMetadata.resolvedConfig` records `run_class`
("smoke"|"official"), `author_model`, `fixer_model`, `escalate_after`, `max_author_turns`,
`max_fixer_turns`, `substrate:"motherduck"`, `malloy_runtime:"node-inprocess"`,
`malloy_model_hash`, `malloy_provenance` ("model_authored"|"human_edited"), `manual_included`
→ `config_hash`. **Only `run_class:"official"` runs back the experimental claim.**

New `evaluation_result.payload` + JSONL fields (additive; viz reads payload generically):
`config_type:"malloy"`, `malloy_source`(+`_chars`), `compiled_sql`(+`_chars`),
`translation_match`, `escalated`, `fixer_turns`, `author_model`/`fixer_model`.
(Conciseness / usage-rate aggregation is Phase 2.)

## Phase 1 build order

0. **Scaffold + spike (gate before investing):** create the TS project; fork
   `agentic-loop.ts` + `mcp-client.ts` + `controllog.ts` from data-chat-mini; `load` builds
   `data/dabstep.duckdb` locally (and reuse the baseline's MotherDuck DB for execution);
   **prove `@malloydata/malloy` compiles+`getSQL()` in-process and the SQL runs on MotherDuck
   via MCP; prototype `fees_base.malloy` against 1451 + 1711.** Surface any fee-modeling
   showstopper here.
1. **Store + tools + scorer (NOT the real layer):** build `malloy-store.ts` + the tool
   surface + `linter.ts`; stand up the Python scoring sidecar (`score_sidecar.py` + vendored
   `score.py`) and `score-client.ts`. For bring-up use only a **throwaway trivial model**
   (one `payments_base` with a `count`) — runs on it are `run_class:"smoke"`. **No human
   writes the real layer.**
1b. **`layer-build` model pass (Phase-0, required for the official 26/26):** a CLI command
   where an expensive-tier model reads `manual.md` + the 26 train Q/A and *writes*
   `malloy/models/*` + `_meta/*.yaml` from scratch, tagged `malloy_provenance:"model_authored"`
   and hashed (`malloy_model_hash`). Runs WITH the manual; the manual *ablation* is deferred.
2. **Two-model loop + controllog wiring:** extend the forked loop with author→fixer
   escalation; extend `controllog.ts` with the missing builders + the no-double-counting
   ownership; emit all events + the new payload fields.
3. **Drive to 26/26 (official):** iterate by re-running `layer-build` and editing the *build
   prompt / SKILL* (never hand-patching `malloy/`, which would flip the run to
   `human_edited`). `evaluate --split templates --run-class official` (sonnet/opus,
   model-authored layer) = **26/26**. Triage misses with `controllog-viz review`.

## Deferred (documented, not built in this plan)

- **Phase 2 (Optimization):** pin 26/26; metrics aggregation + `usage-report` (share-of-logic
  = `malloy_chars/(malloy+sql)`, central-vs-per-query size, context-token breakdown
  manual/markdown/Malloy, usage-rate proxy via `get_file` + reused export names, target 99%);
  per-fragment test harness (`malloy/tests/*`, every `_meta` export needs ≥1 test,
  `layer-test --with-26` gate); `trial_id`/`trial_index` sweeps; task-generality lint (no
  train-id strings in tool code).
- **Phase 3 (Generalization):** `evaluate --split test` (419 held-out), manual ablated, layer
  frozen; compare to the SQL baseline's held-out run as control; predict 90%+. (Substrate is
  already MotherDuck for both, so this is apples-to-apples.)
- **Manual ablation:** the `layer-build` pass is Phase 1 and runs *with* `manual.md`; the
  *ablation* (rebuild/answer WITHOUT it) is deferred — `--include-manual/--no-manual` threads
  into the system prompt; `manual_included` recorded in `run_metadata`.
- **Authoring fork:** SQL-first-then-Malloy as a second path once Malloy-direct works.

## Verification (end-to-end)

1. **Runtime spike:** `asm-malloy malloy-preflight` — compile `run: payments_base -> { aggregate: n is count() }`
   returns runnable SQL; executing it via MCP on MotherDuck returns the count matching
   `SELECT count(*) FROM payments`; local translation-check matches.
2. **Build:** `asm-malloy load` creates `data/dabstep.duckdb` (5 tables, expected rows) and
   confirms the MotherDuck DB is reachable; `asm-malloy layer-build` produces a
   `model_authored` layer.
3. **Single question (watch):** `asm-malloy evaluate --task-id 1711 --watch` (hard fee Q)
   shows MCP exploration → list_malloy_files → get_file → run_malloy → submit_answer, a correct
   answer, and logged `compiled_sql` + `translation_match: true`.
4. **Train gate (official):** `asm-malloy evaluate --split templates --run-class official`
   (sonnet/opus, model-authored layer) → **26/26**, with `results/*.jsonl` +
   `results/controllog/{events,postings}.jsonl` written. Confirm no `task_complete` posting
   carries tokens/cost/wall (no-double-counting).
5. **Monitor:** `controllog-viz review --source results --latest --open` renders the trace
   cards (authored Malloy + compiled SQL) and the tool-timing waterfall; author/fixer model
   attribution and per-model cost appear.
6. **Scorer parity:** the Python sidecar's verdicts on the 26 match the baseline's (both 26/26),
   confirming the vendored `score.py` behaves identically.
