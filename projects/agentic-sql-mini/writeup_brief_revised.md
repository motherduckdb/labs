# Catalog Context for Agents — Internal Brief

**Author:** Jacob Matson · **Date:** 2026-05-04 · **Target ship:** ~May 22 (late May)

## TL;DR

A lead-gen ebook and a companion blog. The pitch: if you want AI to work on your data, the highest-leverage thing you can do is fix your table and column names. Semantic layers, RAG-over-docs, multi-agent setups don't beat this. Neither do prose docs in the prompt.

I have the data now. On the 36-question DABstep train slice, descriptive column names with no prose docs in the prompt come within one correct answer of the with-manual baseline, at 55% the cost. Strip the manual, keep the names. The schema does the work.

## Why now

We've got an AEO gap. Gauge has us at **13.4% topic visibility on "Data for Agentic AI"** vs Snowflake at **40%**. Biggest gap in the recent batch. Ryan greenlit me taking it (DM, 2026-04-13).

The audience: people who hooked an LLM up to their warehouse, got bad answers, and are trying to figure out what to do. They're searching right now. I want them landing on MotherDuck content.

We've got the POV and now the receipts. The DABstep work in the SAO paper (Till, me, Jordan) already shows column annotations are the biggest single jump from baseline. This asset takes that finding to a practitioner audience and runs a sharper experiment that isolates names from prose.

## The thesis

The most important context for an LLM answering questions about your data is the table and column names of everything in your catalog. That's the headline. Past that, you're optimizing.

Tagline, lifted from the agent-SQL talk: **"The best semantic layer is a well-named column."**

The new finding sharpens this: well-named columns can replace the docs outright.

## The experiment

Two tiers, one axis. DABstep dataset, no prose docs in the prompt either way.

| Tier | Schema | What it isolates |
| :---- | :---- | :---- |
| **T1 — Raw** | DABstep column names as-shipped | Baseline without naming work |
| **T2 — Naming** | Hand-tuned table + column names | The naming win |

Numbers I'll publish: `T2 − T1` (the naming delta on the test set). Plus a reference column for the old "with manual.md" setup, so the reader can see how close naming alone gets.

I dropped the comments tier. T2 is already within a question of the with-manual ceiling on train. The expected lift from auto-generated column comments is small enough to be noise, and a third tier muddies the story. If comments matter on production schemas, that's a follow-up post.

**Allowed under "naming":** new tables that restructure the raw data so columns make sense. Functionally view-shaped, materialized as tables. Fine.

**Not in scope:** views, macros, semantic layers, RAG, multi-agent, prose docs in the system prompt, column comments. The whole point is you don't need them.

## Train results so far (n=36)

| Run | Accuracy | Cost | Prompt tok/Q |
| :---- | ----: | ----: | ----: |
| With manual.md, raw schema | 16/36 = 44.4% | $3.37 | 290k |
| With manual.md, named schema | 12/36 = 33.3% | $3.52 | 326k |
| **No prose, raw schema (T1)** | **2/36 = 5.6%** | **$2.60** | **242k** |
| **No prose, named schema (T2)** | **15/36 = 41.7%** | **$1.86** | **112k** |

Strip prose and the raw arm collapses to 6%. The named arm holds at 42%. One question shy of the with-manual ceiling, at lower cost, with less than half the prompt tokens. The schema is doing what the manual used to do.

Signal is clean enough. Next: both tiers on the 418-question test set, then start the writeup.

### Sub-finding worth flagging

I also tested high reasoning vs medium reasoning on T2. Higher reasoning made accuracy drop (15 → 12 correct) and cost rise (+45%). The model writes more elaborate SQL and hits more edge cases wrong. In a no-prose schema-only setup, the bottleneck isn't model thinking. It's whether the schema told the model the answer. If it didn't, more reasoning won't find it.

That's a publishable line on its own.

## Format and audience

**Audience:** TOFU. Data engineers, analytics leads, founders/CTOs at data-heavy startups, BI managers shopping for "chat your warehouse" tools. Pain they walk in with: *"I plugged an LLM into my warehouse and the answers are wrong. What am I supposed to do?"*

**Gated asset:** ebook or whitepaper, TBD. Leaning ebook: practitioner tone, ~15–25 pages, doubles as sales enablement. Whitepaper if we want the experiment to dominate.

**Ungated companion blog:** TOFU traffic to the gate. Open: standalone, or paired with `0420-data-for-agentic-ai`?

## Timeline

I'm in New Orleans May 11–14, so the schedule is built around that gap. Train results landed faster than I'd planned (parallelism cut the eval from ~60 min serial to ~6 min wall at c=16), so the test run is no longer a multi-day item.

| Window | Work |
| :---- | :---- |
| ✅ Done | T1/T2 train results locked. Recovery loop + concurrency landed. |
| Now → ~May 11 | T1/T2 on full test set (~1 hr/arm wall at c=16). Lock numbers. Start outline. |
| May 11–14 | New Orleans. Working window paused. |
| ~May 15 → ~May 18 | Draft. Ebook + companion blog. |
| ~May 19 → ~May 22 | Design pass. Ship. |

Plenty of room. Most of the prescriptive content lives in `0128`, `0205`, `0226`, `0324`, `0415`. The new work is the test-set numbers and the writeup. Train already has the headline.

## Seeking Feedback On

1. **Format:** ebook or whitepaper?
2. **Budget + model:** Gemini 3 Flash for SAO parity, single model? Or two for robustness? Train run on 36 Q at c=16 cost ~$2/arm. Test run at 418 Q estimates ~$22/arm. Two arms = ~$45 total per model.
3. **Blog coordination:** standalone, or sequenced with `0420-data-for-agentic-ai`?
4. **Gating:** existing landing page template / HubSpot form, or new?
5. **Anyone else on this:** reviewer, co-author?

## Source material

- **Sibling** `0420-data-for-agentic-ai`: broader "warehouse for agents" angle, anchored on `mdw-turbo`. This is the sharper, single-thesis companion.
- **Parent** `0428-context-layer-paper` (SAO 2026): this asset is the practitioner translation, plus a follow-up that isolates naming from comments, and now from prose.
- **Recyclable:** `0128-preparing-your-dwh-for-ai`, `0205-simple-models-ai-blog`, `0226-agent-sql-talk`, `0324-context-research`, `0415-best-practices-for-dives`.

## Status

**2026-05-04:** T1 + T2 train results in. The naming-replaces-prose finding is sharper than the original "naming improves accuracy" framing. Same data, different access. Test-set runs are next. Open decisions above.

**2026-04-28:** Thesis, experiment, audience, deadline, deliverables locked. Next: kick off hand-tuning + evals.
