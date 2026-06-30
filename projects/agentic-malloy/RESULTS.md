# agentic-malloy — Results

**Date:** 2026-06-29 (held-out runs executed 2026-06-24/25). **Split:** DABstep held-out
(419) + train (26). **Verdict: the hypothesis is not supported.**

The experiment asked whether a **Malloy semantic layer** is a more token-efficient, more
reliable substrate for an analytics agent than the **markdown + SQL context** baseline
(`../agentic-sql-claude-edition`) on DABstep — *while holding accuracy at or above the
baseline*. The hypothesis is a conjunction (more efficient **and** ≥ accuracy); both clauses
fail. As the agent's **primary answering substrate**, Malloy is more token-heavy, no more
accurate, and — most tellingly — **mostly bypassed**: the agent routes around the layer to SQL.

> **Scope.** One benchmark, one harness, one model-authored layer build — a finding about
> Malloy *as an LLM answering substrate*. It says nothing about a semantic layer's value as a
> deterministic, governed interface for non-agent systems (provenance, permissions, lineage,
> metric contracts, interoperability), which this experiment did not test.

## The matrix (419 held-out · same data / DB / DABstep scorer)

| Substrate / run | Accuracy | Hard (348) | Easy (71) | % via SQL | Median prompt tok | Cost |
|---|---:|---:|---:|---:|---:|---:|
| **markdown+SQL** (baseline) · gemini | **418/419 = 99.8%** | 348/348 (100%) | 70/71 | — | 42,370 | $8.58 |
| Malloy · sonnet+opus (best, official) | 382/419 = 91.2% | 324/348 (93.1%) | 58/71 (81.7%) | 56.6% | 84,010 | $29.76 |
| Malloy · sonnet+opus (official, pre-fix) | 370/419 = 88.3% | 89.7% | 81.7% | 0% | 94,747 | $40.06 |
| Malloy · gemini (new harness, high) | 362/419 = 86.4% | 87.4% | 81.7% | 18.9% | 87,857 | $14.56 |
| Malloy · sonnet+opus4.8 (new harness) | 354/419 = 84.5% | 88.2% | 66.2% | 6% | 80,420 | $35.33 |
| Malloy · gemini (controlled, low) | 295/419 = 70.4% | 69.8% | 73.2% | 0% | 106,609 | $11.81 |

The best Malloy arm (**382**, the post-fix official run) supersedes the 88.3% this doc
previously headlined — but it still does not reach the baseline, and it gets there by
answering **56.6% of questions in raw SQL, not Malloy**.

## The controlled result — fix the model, swap only the substrate

Holding the model at **gemini** and changing only the knowledge substrate (the clean,
confound-free comparison):

| | markdown+SQL | Malloy layer | Δ |
|---|---:|---:|---:|
| Accuracy | 99.8% | 70.4% | **−29.4 pts** |
| Prompt tokens (median) | 42,370 | 106,609 | **2.52×** |
| Cost | $8.58 | $11.81 | 1.38× |

The ~29-pt gap and 2.5× token inflation are attributable to the substrate alone.

## Findings

1. **Token inflation is structural.** The layer + per-query Malloy + the view catalog is
   simply more context — 2.5× the prompt tokens at a fixed model, no accuracy gained.

2. **The layer is mostly bypassed — the deepest result.** On the best run the answer-path
   split is **237 SQL / 134 authored-Malloy / 47 view-selection** (56.6% SQL); only **12 of
   83 views** are used by that run, and **52 of 83 are never referenced by any run**. A full
   layer **rebuild** that fixed the central defect (build-gate findings 18→1) **did not move
   the score** (and cost −2 on train) — because the agent wasn't using the layer. SQL + a thin
   skill carry the benchmark.

3. **A compiled view freezes one interpretation; prose adapts.** On the always-fail
   "most-expensive fee" template the layer ranks by an AVERAGE where the gold is a SUM: the
   layer's view scores **0/19**, bailing to SQL recovers only **11/19**, the baseline gets
   **19/19**. The wrong computational model the layer instills survives even the escape to
   SQL. Documented patterns can be re-read and adapted per question; a compiled view can't.

4. **Models write accurate Malloy — the failure is in using it, not authoring it.** The layer
   was authored procedurally by a model (`claude-opus-4.7`: read the manual + 26 train Q/A +
   schema → write the layer → compile-and-execute gate → repair loop → provenance-lock), never
   hand-edited. It compiles, runs, and **generalizes**: train (sonnet+opus) ~94.7% vs held-out
   91.2% — held-out tracks train, so the layer is not overfit. It is simply a less efficient
   substrate.

## What is NOT claimed

- This is one benchmark, one harness, one layer build — about Malloy *as an LLM substrate*.
  Not a claim about Malloy or semantic layers in general, and explicitly nothing about their
  governance / interoperability value (untested by design).
- The baseline is a heavily tuned markdown+skill setup designed to let a cheap model excel;
  that tuning is part of why it wins. The **easy-question gap is largely answer-convention /
  skill-tuning parity, not a substrate property** — the Malloy arm's answering skill is far
  thinner.
- The token comparison is clean (same-model). Cross-model rows (premium Malloy vs cheap
  baseline) are accuracy-only — and that asymmetry favors Malloy, which still lost.

## What the surviving value implies (forward-looking — not measured here)

The layer's differentiated value isn't helping the model reason — it's making chosen
definitions **executable, governed, testable, and reusable outside the LLM loop**. That points
at a product shape (a hypothesis, not a result): **context-first authoring** (the substrate the
agent actually uses) + **SQL as the execution language** + **semantic-layer objects as
promoted, test-gated artifacts**, with a **governed lookup tried first but a clear off-ramp**
to using the layer as *context* for a SQL answer, logging promotion candidates. The strongest
proxy we ran (the 382 hybrid: 47 view-selection / 134 authored / 237 SQL) validates the
*direction* (an off-ramp helps) but not the exact protocol — the lookup couldn't carry most
questions.

## The story Dive

A data-backed MotherDuck Dive presents all of the above with live queries and drill-down
off-ramps (the matrix, the always-fail template, the harness/prompts, view-utilization, agent
traces): **https://app.motherduck.com/dives/malloy-vs-context-e1093927-da06-4bf1-85df-73dd476ea8b1**
(org-shared). It is built from `dive/` — `dive/story-load.ts` curates the `agentic_malloy_story`
MotherDuck database; `dive/bundle.mjs` produces the single-file dive.

## Reproduce

Runs on MotherDuck DB `agentic_malloy`, scored with the vendored DABstep `score.py`. Layer
under test: committed model-authored layer `malloy_model_hash: d7a2545e3a8300b0` (provenance
`model_authored`, authored by `claude-opus-4.7`, 2 improve rounds + glossary reground).

| Run | Result file |
|---|---|
| Baseline (gemini, 418/419) | `../agentic-sql-claude-edition/results/test_20260624T203750Z.jsonl` |
| Malloy official (best, 382) | `results/test_2026-06-25T2334Z.jsonl` |
| Malloy official (pre-fix, 370) | `results/test_2026-06-24T2000Z.jsonl` |
| Malloy gemini (controlled, 295) | `results/test_2026-06-24T2057Z.jsonl` |

Every number above is also queryable: `npx tsx dive/story-load.ts` rebuilds
`agentic_malloy_story`, which reproduces the matrix, the answer-path split, and the
view-utilization figures.

## Status

Experiment concluded. The Malloy-as-LLM-substrate hypothesis is not supported on DABstep:
more tokens, no accuracy gain, and the layer is mostly bypassed — while the model-authored
Malloy itself is accurate and generalizes. The substrate's distinctive value, if any, is
governance / interoperability, which this experiment did not test.
