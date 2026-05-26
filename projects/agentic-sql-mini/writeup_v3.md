# Schema names did the work the docs used to do

Last time around, I ran an A/B on column naming and lost. Generic placeholders (`column_a`..`column_t`) beat descriptive renames (`applies_to_*`, `transaction_amount_eur`) by 11 points. The descriptive arm wrote elaborate predicate-walking SQL where the placeholder arm wrote three-line aggregates. Naming was making the model worse.

That bothered me, but the diagnosis was off.

The thing I missed: both arms had `manual.md` in the system prompt — ~6.3K tokens of payments-domain prose explaining ACI semantics, fee predicates, fraud bracketing, the whole business. With the manual loaded, the column names didn't have to carry information. They just had to not get in the way. And `applies_to_account_types` reads like an instruction, so the model dutifully filtered on every predicate even when the question wanted a naive average.

The right experiment isn't "do better names beat worse names." It's **"can schema modeling replace prose docs entirely?"**

So I yanked the manual out of the system prompt. Same 4 tools, same DuckDB databases, same 36-question train split. The only difference between arms: column names.

## Same data. Different access.

| run | accuracy | cost | prompt tok/Q |
|---|---|---|---|
| V1 baseline (with manual.md) | 16/36 = 44.4% | $3.37 | 290k |
| V1 explicit (with manual.md) | 12/36 = 33.3% | $3.52 | 326k |
| V3 baseline (no prose) | 2/36 = 5.6% | $2.60 | 242k |
| **V3 explicit (no prose)** | **15/36 = 41.7%** | **$1.86** | **112k** |

Strip the manual and baseline collapses from 44% to 6%. That's expected — the placeholder columns gave the agent nothing to work with, so it spent 32 turns thrashing per question and timed out 8 of 36.

The interesting line is the bottom one. Explicit at 15/36 lands one question behind V1 baseline-with-manual, at 55% the cost, with no prose anywhere. **The schema is doing the work the manual used to do.**

The sign reversed. With manual.md, descriptive naming hurt by 11 points. Without it, descriptive naming wins by 36 points and uses less than half the prompt tokens of placeholder names. Same code. Same agent. The information just had to live somewhere.

## What the names had to encode

The original `applies_to_*` rename worked great when there was a manual telling the agent that NULL in `applies_to_capture_delay` means "applies to all values." Without that prose, the agent treats NULL as a normal SQL NULL and misses every wildcard rule. Question 1475 ("which fee IDs apply to account_type=D and aci=F") wants 150+ matching rules. Without the wildcard semantic, the agent finds 12.

The fix lives entirely in column names:

```
applies_to_account_types  →  account_types_filter_empty_means_any
applies_to_capture_delay  →  capture_delay_bucket_filter_null_means_any
applies_to_monthly_fraud_level  →  monthly_fraud_level_bucket_filter_null_means_any
applies_to_acis  →  acis_filter_empty_means_any
intracountry  →  intracountry_filter_null_means_any
```

The `_filter_empty_means_any` / `_filter_null_means_any` suffixes are ugly but functional. Looking at the SQL the model wrote on q1442 after the rename:

```sql
JOIN fee_rules f ON (
    m.mcc_val = ANY(f.mccs_filter_empty_means_any)
    OR len(f.mccs_filter_empty_means_any) = 0
)
```

It read the column name and figured out the wildcard handling on its own. No prose needed.

The other rename that mattered: `merchants.capture_delay` (raw values like `'1'`, `'2'`, `'7'`, `'immediate'`) goes by the same column name as `fee_rules.applies_to_capture_delay` (bucketed values like `'<3'`, `'3-5'`, `'>5'`). Same semantic concept, different vocabularies. Without manual.md telling you that `'1'` maps to `'<3'`, the agent has no way to bridge them. So I named them differently:

```
merchants.capture_delay  →  capture_delay_days_or_immediate_or_manual
fee_rules.applies_to_capture_delay  →  capture_delay_bucket_filter_null_means_any
```

The `_days_` hint and `_bucket_` hint together cue the agent that these aren't the same vocabulary. It's not a perfect fix — multi-step bucketing is still a hard SQL problem — but the agent now reaches for the conversion instead of joining naively.

## One more change: forced submission

Half the V2 explicit failures weren't wrong-answer failures, they were no-answer failures. The agent would describe what it had found in prose and call it a day, never calling `submit_answer`. Five questions hit the budget at 3-6 turns, all because the agent gave up.

Fix in two parts:

1. Strengthen the prompt: `submit_answer` is mandatory. Returning prose scores zero. If you can't answer, submit `SELECT 'Not Applicable'`.
2. Recovery loop: if `Runner.run` returns without `submit_answer` having been called, send a "you didn't submit, do it now" follow-up with the prior turns in context, and run once more.

Hit-limits collapsed from 9 to 2 on explicit. Hit-limits on baseline barely moved (8 → 8) because baseline was hitting real budget exhaustion, not early-quitting.

## More reasoning, more wrong

Boss asked: what if we just turn up the reasoning effort? Surely that helps.

| run | accuracy | cost | completion tok/Q |
|---|---|---|---|
| V3 baseline (medium) | 2/36 = 5.6% | $2.60 | 5.7k |
| V3 explicit (medium) | 15/36 = 41.7% | $1.86 | 7.8k |
| V4 baseline (high) | 1/36 = 2.8% | $3.28 | — |
| V4 explicit (high) | 12/36 = 33.3% | $2.69 | 14.0k |

High reasoning made both arms **worse**. Explicit dropped 3 questions, completion tokens nearly doubled, cost went up 45%. The model overthinks, writes more elaborate SQL, and hits more edge cases wrong.

This is the cleanest signal in the run: in a no-prose schema-only setup, the bottleneck isn't model thinking. It's whether the schema told the model the answer.

If the schema doesn't have it, more reasoning won't find it.

## Where the ceiling is

Of the 21 questions V3 explicit still gets wrong, almost none are naming-fixable. The patterns:

- **Multi-step bucket arithmetic.** Compute fraud rate per merchant per month from `payments.is_fraudulent_dispute`, bracket into the four `monthly_fraud_level` buckets, join against `fee_rules`. The agent attempts this and errs on edge cases.
- **Counterfactual deltas.** "If fee 384's relative rate changed to 1, what would Belles_cookbook_store's January 2023 bill change by?" Pure reasoning; schema is fine.
- **Steering optimization.** "Which card scheme should this merchant route to to minimize fees?" Requires per-scheme fee modeling.
- **Tie-breaking.** "Most expensive MCC" with multiple valid answers in different orders.

These are SQL craft problems, not schema problems. The schema is telling the agent what's where; it can't tell the agent how to do an 8-step counterfactual.

## What this is evidence for

The publishable finding here isn't "naming improves accuracy." That part was already plausible. The interesting result is that **schema modeling can replace prose documentation as the agent's information source**, and do it at lower cost than including the docs in the prompt.

Same agent. Same model. Same questions. The information just lives in the column names instead of in a 6K-token preamble. And the agent ends up cheaper, faster, and within one question of the prose-included baseline.

If you're investing in production warehouses for AI workloads, this says: spend the time on column naming and structural modeling. The docs don't have to be loaded; the schema can carry the load.

The next move in the experiment is clear: take this to the 418-question test set, with parallelism. At c=16 the train run is ~6 minutes per arm. The test should land in ~1 hour total.

After that, the next axis is materialized fact tables — encoding the bucketing into actual tables instead of relying on the model to derive them. That's where the SQL-craft failures live, and that's a separate experiment.
