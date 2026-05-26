# Tab 1 — revised framing

The experiment changed shape twice. Worth reflecting that here so the rest of the doc reads coherently.

## What I originally set out to test

Whether descriptive column names beat placeholder names on DABstep. Two arms:
- **baseline**: generic `column_a..column_t` placeholders
- **explicit**: descriptive renames (`transaction_amount_eur`, `applies_to_account_types`, etc.)

System prompt for both arms included `manual.md` (~6.3K tokens of payments-domain prose).

## What I actually tested (V1)

Baseline 16/36 = 44.4%. Explicit 12/36 = 33.3%. **−11.1 points.** The descriptive arm regressed.

Reading the SQL on the regression cases (1273, 1593, 1744, 2767), the pattern was clear: `applies_to_*` prefixes acted as imperatives. The model walked every predicate when the question wanted a naive aggregate. The placeholder arm didn't have that pressure, so it wrote shorter, looser SQL — and matched the gold answers more often.

But the manual was in the prompt for both arms. So naming wasn't carrying any information; it was just creating bridging cost. Of course the simpler arm won.

## What this experiment is actually testing now

> **Can structural data modeling replace prose documentation as the agent's information source?**

That's a meaningful claim about how to invest in production warehouses for AI workloads. If schema modeling beats prose docs at lower cost, that's evidence to put the effort into column naming and structural design rather than maintaining a docs corpus that has to live in the prompt.

So the new V3 setup:
- **No prose docs in the system prompt.** Period. Manual.md is out. Payments-readme.md is out.
- Both arms see only DDL + 50-row query samples through the same 4 tools.
- The only difference between arms is **column names** in the same DuckDB tables.

Two arms:
- **baseline**: original DABstep column names verbatim (`payments`, `fee_rules`, `aci`, `eur_amount`, etc.)
- **explicit**: descriptive renames where possible, including suffixes that encode wildcard semantics (`account_types_filter_empty_means_any`, `capture_delay_bucket_filter_null_means_any`)

If explicit wins by a wide margin, the schema is doing the work. If both arms collapse, prose was load-bearing. Either result is publishable.

## What changed in the agent loop

Two implementation changes that aren't part of the schema axis but matter for cost/accuracy:

1. **Recovery loop.** If the agent finishes a run without calling `submit_answer`, send a follow-up "you didn't submit, do it now" with the prior turns in context and run once more. Cheap, eliminated 5+ early-quit hit_limits.
2. **Parallel evaluation.** `--concurrency 16` with one shared httpx client and per-task usage tracking via `contextvars`. Train run dropped from ~60 minutes serial to ~6 minutes wall. Test run estimate: ~1 hour for 418 questions per arm.

Both apply equally to both arms. They're agent-loop quality, not schema variables.

## Result

V3 explicit (no prose, rename-only): **15/36 = 41.7% at $1.86**.
V3 baseline (no prose): 2/36 = 5.6% at $2.60.

The schema-only arm lands one question behind V1 baseline-with-manual (16/36) and uses less than half the prompt tokens of V3 baseline.

Details on the next page.
