# Reproducing the 419-question test run (2026-08-21 → 2026-08-23)

Result: **413/419 = 98.57%**, $0.00 cost, 40.7h wall-clock (146,621.7s), avg 9.4 turns/question, `hit_limit: 0/419`.

All values below are pulled from the run's own recorded provenance
(`results/controllog/events.jsonl`, `kind=run_metadata`, `run_label=test_20260822T053304Z`)
and from MotherDuck (`dabstep_logs_alex.main.events`), not from memory — this is what
actually ran, not what was intended.

## 1. Code

- **Repo**: `https://github.com/motherduckdb/labs.git`
- **Base commit**: `cfa98578416da7a4c746815e129dad2260e8cf72`
  ("agentic-sql-context-mcp: let guides-load use a per-principal uuid lockfile")
- **Dirty at runtime**: `true` — one uncommitted change was live: `MAX_OUTPUT_TOKENS`
  in `src/agent.py` was `40000` (not the file's committed value of `16384` at that
  commit). This is now committed as part of `6d783b3` on branch `lmstudio-local-eval`.
- **To reproduce the exact code state**: check out branch `lmstudio-local-eval` at
  commit `6d783b3` or later. That commit's diff also bundles `scripts/doe_decode_speed.py`
  and `scripts/progress_snapshot.sh` — both are unrelated follow-on work written *after*
  this run finished and have no bearing on reproducing it; ignore them.
- **`config_hash`** (fingerprint of the resolved run config): `b4326bca6a5bfe4d555386e7d11e9d8540b7803b0a9039c1cb55304c1f372081`

## 2. Model

- **Served as**: `qwen3.8-27b-mlx` (LM Studio identifier)
- **Source**: `lmstudio-community/Qwen3.8-27B-MLX-4bit` on Hugging Face (1.6M downloads,
  25 likes at time of writing — the standard MLX quant for this model)
- **Format**: MLX, 4-bit
- **Backend**: LM Studio's bundled `mlx-llm` engine (`mlx-llm-mac-arm64-apple-metal-advsimd`,
  version `1.11.0` at time of writing — LM Studio may have silently updated this backend
  since the run; no version pin was captured at runtime, so treat this as best-available
  rather than exact)
- **Context length loaded**: **42,496 tokens**. Reconstructed from the last `lms ps --json`
  check before the run started — the same LM Studio server process ran continuously from
  before this run through its entire duration, with no reload in between, so this value
  held for all 419 questions. LM Studio's resource-guardrail auto-fit computes this value
  from available memory; the harness's `-c`/context-length request is **silently
  overridden and ignored for MLX** regardless of what's asked (confirmed later in a
  separate investigation) — so this number is not directly settable, only observable
  after the fact via `lms ps --json`.
- **Speculative decoding**: off (not yet discovered/implemented at the time of this run)
- **KV-cache quantization**: not applicable to this MLX build (no such setting existed
  in the model's LM Studio config at the time)

## 3. LM Studio server

- **App version**: `0.4.21+2`
- **API**: OpenAI-compatible endpoint at `http://localhost:1234/v1`
- **Concurrency**: `1` in-flight request at a time (`LMSTUDIO_CONCURRENCY` in
  `src/agent.py`, and the harness's own `--concurrency 1`)
- **Reasoning effort: `medium` (the chat template's stock fallback) — confirmed, not
  inferred.** `--reasoning low` was passed to the CLI and recorded in
  `resolved_config.reasoning = "low"`, but **this had zero actual effect**.
  `LLMProvider`'s local-mode path stripped all reasoning-related request fields before
  sending (OpenRouter's `reasoning` extension doesn't apply to a local server, and no
  working local equivalent had been wired up yet), so no `reasoning_effort` value ever
  reached the model. The model's Jinja chat template — the one baked into
  `lmstudio-community/Qwen3.8-27B-MLX-4bit`'s LM Studio config
  (`~/.lmstudio/.internal/user-concrete-model-default-config/lmstudio-community/Qwen3.8-27B-MLX-4bit.json`,
  field `operation.fields[key=llm.prediction.promptTemplate]`) — resolves the unset
  value with `reasoning_effort|default('medium')`. That file's `created`/`modified`
  timestamp is **2026-08-21 13:56–13:58**, ~8.5 hours before this run started at
  22:33:03, and it was not touched again until 2026-08-25 (after this run had long
  finished) — so `medium` was in effect for all 419 questions, start to finish.
  Mechanically, `medium` is **not** a "moderate thinking" instruction: the template only
  defines explicit steering text for `xhigh` and `low`; there is no `medium` branch, so
  the `reasoning_instructions` variable is left as `''` and nothing about reasoning
  effort is ever added to the prompt. The model just reasoned however it does with zero
  explicit steering in either direction — not "low," and not a deliberately chosen
  "medium" either, just whatever's left when no directive is given at all.
  Do not expect changing `--reasoning` to reproduce a different result on old runs
  like this one — that flag never reached the model for any local run before the fix
  described in §9.

## 4. Hardware / OS

- **Machine**: MacBook Air, Apple **M5**, 32 GB unified memory
- **macOS**: 26.4.1 (build 25E253)

## 5. Harness configuration (from `resolved_config`, verbatim)

```json
{
  "benchmark": "dabstep",
  "split": "test",
  "database": "agentic_sql_claude",
  "model": "qwen3.8-27b-mlx",
  "reasoning": "low",
  "max_turns": 40,
  "concurrency": 1,
  "question_count": 419,
  "run_label": "test_20260822T053304Z",
  "no_guides": false,
  "local": true
}
```

## 6. MotherDuck / data

- **Data database**: `agentic_sql_claude` (built via `uv run asm load` — 5 tables:
  `payments` 138,236 rows, `fees` 1,000 rows, `merchants` 30, `acquirer_countries` 8,
  `merchant_category_codes` 769)
- **Semantic layer**: 27 guides under the `dabstep/*` topic prefix, published under a
  **per-principal lockfile** (`guides.lock.alex.json`, gitignored — NOT the committed
  `guides.lock.json`, whose UUIDs belong to a different MotherDuck principal and will
  fail to `update_guide` for anyone else). To republish under your own account:
  ```bash
  MOTHERDUCK_TOKEN="<your token>" uv run asm guides-load --lockfile guides.lock.<you>.json
  ```
- **Results database**: `dabstep_logs_alex` (controllog `events`/`postings` schema,
  cloned from the org's shared `dabstep_logs` share)
- **MotherDuck token**: must authenticate against the **MCP HTTP endpoint**
  specifically — a short-lived token minted via `get_short_lived_token` does **not**
  work here (401s); use a long-lived personal access token.

## 7. Environment variables

```bash
export MOTHERDUCK_TOKEN="<your long-lived PAT>"
export MD_DATABASE=agentic_sql_claude
export DABSTEP_GUIDES_PREFIX=dabstep
export DABSTEP_GUIDES_ACCESS=user
```

## 8. Exact launch sequence

```bash
# 1. LM Studio: load the model with the context that was actually observed (42496).
#    Note: MLX ignores an explicit -c request (auto-fit overrides it), so this is
#    informational, not something you can force — whatever LM Studio's guardrail
#    computes for your machine's available memory at load time is what you'll get.
lms unload --all
lms load qwen3.8-27b-mlx -y

# 2. Build the source data (skip if agentic_sql_claude already exists and is current).
cd projects/agentic-sql-context-mcp
uv run asm load

# 3. Publish the semantic layer under your own principal.
MOTHERDUCK_TOKEN="$MOTHERDUCK_TOKEN" uv run asm guides-load --lockfile guides.lock.alex.json

# 4. Launch the full test run, detached (this run took 40.7 hours).
LOG=results/full_test_run.log
date "+=== full test split (419q) start %Y-%m-%d %H:%M:%S" > "$LOG"
MOTHERDUCK_TOKEN="$MOTHERDUCK_TOKEN" nohup caffeinate -is \
  uv run asm evaluate --local --model qwen3.8-27b-mlx --split test >> "$LOG" 2>&1 &
disown
date "+=== full test split done %Y-%m-%d %H:%M:%S" >> "$LOG"
```

## 9. Known non-reproducible elements — read before expecting an identical score

- **Reasoning was effectively uncontrolled** (see §3) — fixed at the template's stock
  `medium` fallback (no explicit steering text), not a deliberately chosen setting.
  As of 2026-08-25, reasoning effort *can* be deliberately controlled for this MLX
  model — by editing the same persisted-config file's `promptTemplate` field directly
  (there is no request-time or dedicated-settings-field mechanism that works; the
  template's own default literals must be patched):
  - Change `reasoning_effort|default('medium')` → `reasoning_effort|default('low')`
    (or `'xhigh'`) to steer the *level* of a still-present reasoning block.
  - To disable thinking outright (verified fastest, ~93% faster than `medium` on a
    single-call test, tool-calling confirmed intact), patch both:
    `enable_thinking is undefined or enable_thinking is true` → `enable_thinking is true`,
    and `enable_thinking is defined and enable_thinking is false` →
    `enable_thinking is undefined or enable_thinking is false`.
  A rerun today, with this fix, will **not** reproduce this run's exact behavior unless
  you deliberately revert the template to its stock defaults (or otherwise force
  `medium`/unset behavior) rather than leaving your own reasoning patch in place.
- **Context length is not settable for MLX** — whatever LM Studio's guardrail computes
  from available memory at load time is what you get; it may differ from 42,496 on a
  different memory-pressure state or a different machine.
- **`temperature=0.0` is hardcoded** in `src/agent.py` — deterministic in principle,
  but MLX/llama.cpp numerics are not guaranteed bit-identical across LM Studio/backend
  versions, so exact per-question wall-clock (not correctness) may drift run to run.
- **5 gold answers are deliberately excluded** from the 424-question held-out set to
  reach 419 — see `data/bad_golds.json` (provably-wrong `hf_consensus` golds, verified
  against the data; this repo's SQL is correct for those 5, not the published gold).

## 10. Where the results live

- Per-question detail: `results/test_20260822T053304Z.jsonl` (local)
- Full trace / controllog: `results/controllog/{events,postings}.jsonl` (local, appended)
- MotherDuck: `dabstep_logs_alex.main.{events,postings}`, `run_label = 'test_20260822T053304Z'`
- Dive: https://app.motherduck.com/dives/966a2126-c21c-469f-b98e-7233bf49bfe8
