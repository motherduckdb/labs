# agentic-malloy — Results

**Date:** 2026-06-24 · **Split:** DABstep held-out (`--split test`, 419 questions) ·
**Verdict: hypothesis rejected.**

The experiment asked whether a **Malloy semantic layer** is a more token-efficient,
more reliable substrate than the **markdown + SQL context** baseline
(`../agentic-sql-claude-edition`) on DABstep — *while holding accuracy at or above the
baseline*. On the 419-question held-out set, with a controlled same-model comparison,
the Malloy substrate is **worse on every axis**: lower accuracy, ~2.5× more prompt
tokens, and far harder to author. The bottleneck is the **substrate**, not the model.

## The matrix (419 held-out, same data / same DB / same DABstep scorer)

| Substrate | Model | Accuracy | Hard (348) | Easy (71) | Prompt tok (median) | Prompt tok (total) | Cost | Escalations | Hit-limit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **markdown+SQL** (baseline) | gemini-3-flash | **418/419 = 99.8%** | 348/348 (100%) | 70/71 | 42,370 | 18.0M | $8.58 | 0 | 0 |
| Malloy layer | sonnet-4.6 + opus-4.7 | 370/419 = 88.3% | 312/348 (89.7%) | 58/71 | 94,747 | 43.3M | $40.06 | 11 | 1 |
| Malloy layer | gemini-3-flash | 295/419 = 70.4% | 243/348 (69.8%) | 52/71 | 106,609 | 65.3M | $11.81 | 135 | 43 |
| Malloy layer · **new harness, reasoning=high** | gemini-3-flash | **362/419 = 86.4%** | 304/348 (87.4%) | 58/71 | 87,857 | 43.3M | $14.56 | 54 | 5 |

The only empty cell (baseline + sonnet/opus) was not run: the baseline already maxes at
99.8% on the *cheap* model, so a premium-model baseline cannot change the verdict.

### Update (2026-06-25) — the gap narrows (PR #71)

A follow-up attacked the **authoring** friction (not the data logic) with three
tool/skill changes — *view-selection* (a one-call `list_views` catalog so the agent reuses
a named view instead of authoring from scratch), a *clean SQL fallback* (`submit_sql`, with
`duckdb.sql(...)`-in-Malloy rejected), and *deterministic linting* of the SQL-habit Malloy
errors (`select`→`group_by`/`aggregate`, `calculate`→`aggregate`, `where`→`having`, casts) —
and re-ran the cheap model at `reasoning=high`. The **layer is unchanged** (`d7a2545e`,
still `model_authored`).

On the same 419 held-out, gemini-3-flash rose **70.4% → 86.4% (+16 pts)**; escalations
135→54, hit-limit 43→5 (11%→1.2%), at roughly flat cost ($11.81→$14.56) and *fewer* tokens
(median 106.6k→87.9k — the one-call catalog trims discovery). The diagnostic: with a view to
select and a SQL exit, the cheap model stops thrashing, and the remaining misses are
reasoning, not failed authoring. It now **nearly matches the premium sonnet/opus arm (88.3%)
at ~1/3 the cost.**

**The verdict holds, narrowed.** markdown+SQL still wins on every axis — accuracy (99.8% vs
86.4%), cost ($8.58 vs $14.56), and prompt tokens (42k vs 88k median); the substrate's
structural token inflation (layer + per-query Malloy + catalog is just more context) persists.
But the accuracy gap shrank from **~29 pts to ~13**, and you no longer need the premium stack
to get there. (Caveat: this arm changes *two* variables vs the gemini row above — harness
*and* reasoning; a low-reasoning new-harness run would separate the two.)

## The controlled result — fix the model, swap only the substrate

Holding the model at **gemini-3-flash** and changing *only* the knowledge substrate:

| | markdown+SQL | Malloy layer | Δ |
|---|---:|---:|---:|
| Accuracy | 99.8% | 70.4% | **−29.4 pts** |
| Prompt tokens (median) | 42,370 | 106,609 | **2.52×** |
| Cost | $8.58 | $11.81 | 1.38× |
| Escalations to fixer | 0 | 135 | — |
| Turn-budget exhausted | 0 | 43 | — |

This removes the model confound entirely. The ~29-point accuracy gap and 2.5× token
inflation are attributable to the substrate.

## Findings

1. **The layer is NOT overfit.** It was authored by reading the 26 train Q/A, so
   held-out was the honest test. Held-out tracks train closely (sonnet/opus: 88.3%
   held-out vs ~92% / 24-of-26 train; gemini: 70.4% held-out vs ~62–69% train). The
   layer generalizes — it is simply less efficient.

2. **The substrate is the bottleneck, not the model.** At a fixed model (gemini-flash)
   the substrate alone costs 29 accuracy points and 2.5× the prompt tokens. Malloy needs
   the premium sonnet/opus stack just to reach 88.3% — and still loses to gemini-flash on
   markdown+SQL.

3. **The layer makes hard questions *harder*.** On the hard fee-calculation questions —
   exactly where a semantic layer should help — the baseline scores **348/348 = 100%**,
   while Malloy manages 89.7% (premium) / 69.8% (gemini). This is the opposite of the
   intended benefit.

4. **The Malloy answer is expensive to *author*.** Escalation to the fixer: 3% (premium)
   → 34% (gemini); turn-budget blow-outs: 0.2% → 11%. A cheap model thrashes trying to
   write correct Malloy. This also explains the long wall-clock of the gemini run (same
   8-wide concurrency, ~2× work per task).

5. **Misses cluster on one template.** Of the 49 sonnet/opus misses, 19 are the single
   T02 template ("most expensive ACI for a credit transaction"). Fixing T02 via its train
   rep (`1451`) recovers ~19 → ~92.8%, still ~7 pts below the baseline's 99.8% — so even
   the biggest lever does not close the gap.

## What is NOT claimed

- This is one benchmark (DABstep), one agent harness, one layer build. It is not a claim
  about Malloy in general — only about *this* agent-authored-Malloy substrate on *this*
  benchmark.
- The baseline (`agentic-sql-claude-edition`) is a heavily tuned markdown+semantic-layer
  skill explicitly designed to let a cheap model excel; that tuning is part of why it wins.
- The token comparison is now clean (same-model, finding #2). The cross-model rows
  (premium Malloy vs cheap baseline) are an accuracy comparison only — but that asymmetry
  *favors* Malloy, which still lost.

## Reproduce

Runs executed 2026-06-24, all on MotherDuck DB `agentic_malloy`, scored with the vendored
DABstep `score.py`:

| Run | Command | Result file |
|---|---|---|
| Baseline (gemini) | `uv run asm evaluate --split test --model gemini --reasoning low` (in `../agentic-sql-claude-edition`) | `agentic-sql-claude-edition/results/test_20260624T203750Z.jsonl` |
| Malloy (sonnet/opus) | `asm-malloy evaluate --split test --author sonnet --fixer opus --run-class official` | `results/test_2026-06-24T2000Z.jsonl` |
| Malloy (gemini) | `asm-malloy evaluate --split test --author gemini --fixer gemini --run-class smoke` | `results/test_2026-06-24T2057Z.jsonl` |

Layer under test: committed model-authored layer `malloy_model_hash: d7a2545e3a8300b0`
(provenance `model_authored`, authored by `claude-opus-4.7`, 2 improve rounds + glossary
reground). Total held-out API spend this session: ~$60.

## Status

Experiment concluded. The Malloy-semantic-layer hypothesis is not supported on DABstep.
The layer generalizes but is structurally less efficient (accuracy, tokens, authoring
reliability) than the markdown+SQL baseline at every model tier tested.
