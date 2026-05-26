# DABstep Task Data

## Files

| File | Questions | Answer Source | Description |
|------|-----------|---------------|-------------|
| `dev.jsonl` | 10 | `official` | Dev split from Adyen with gold answers |
| `all.jsonl` | 450 | `hf_consensus` | Full benchmark with derived answers |

## Answer Sources

### `official`
Gold answers provided directly by the DABstep benchmark authors (Adyen) in the
HuggingFace dataset `adyen/DABstep`, `tasks` split, `dev` subset. These are
ground truth.

### `hf_consensus`
The DABstep full benchmark (default split, 450 questions) ships **without gold
answers** — the answers are withheld for leaderboard evaluation at
https://huggingface.co/spaces/adyen/DABstep.

To enable local evaluation, we derived answers from the `task_scores` split of
the HuggingFace dataset. This split contains ~715K scored submissions from
leaderboard participants, with a boolean `score` field indicating whether each
`agent_answer` was graded as correct.

**Methodology:**
1. Load `adyen/DABstep` dataset, `task_scores` split (715,500 rows)
2. Filter to rows where `score == True` and `agent_answer` is non-empty
3. For each `task_id`, collect all correct `agent_answer` values
4. Take the most common correct answer as the consensus gold answer
5. Coverage: 450/450 tasks had at least one correct submission

**Validation against dev split:**
- 6/10 dev tasks don't appear in the default split (separate question sets)
- 2/4 overlapping tasks had exact matches
- 2/4 had list answers with different sort order (scorer normalizes order)

**Caveats:**
- These are not official gold answers — they are the most common correct
  submission from leaderboard participants
- If no leaderboard participant answered a question correctly, the answer
  would be missing (did not occur for current dataset)
- List-type answers may have different ordering than the official gold
- The `answer_source` field in each JSONL entry tracks this provenance

**Date derived:** 2026-02-17

## Gold Answer Validation (2026-02-27)

Systematic spot-check of the `hf_consensus` gold answers, focusing on the 24
"always-wrong" questions (0% accuracy across 3+ model attempts). These are the
highest-risk answers — either very hard or potentially wrong.

### Methodology

- Queried 24 always-wrong questions from the `agentic_sql_results` database
- Validated 18 representative questions by writing SQL against `dabstep_c`
- Cross-referenced with `merchant_transaction_fees`, `fraud_aci_costs`, and
  `fee_rules_expanded` views, plus raw `fees` and `payments` tables

### Results

| Category | Checked | Gold Correct | Gold Wrong | Ambiguous |
|----------|---------|-------------|------------|-----------|
| Fee ID lists | 4 | 4 | 0 | 0 |
| Total fees | 3 | 3 | 0 | 0 |
| Average fee calc | 3 | 3 | 0 | 0 |
| Steering / ACI | 3 | 2 | 0 | 1 |
| Fee delta | 1 | 1 | 0 | 0 |
| Fraud rate | 1 | 1 | 0 | 0 |
| Grouped values | 1 | 1 | 0 | 0 |
| NULL eval (infra) | 3 | 3 | 0 | 0 |
| **Total** | **18** | **17** | **0** | **1** |

### Key Findings

1. **No wrong gold answers found.** All 17 non-ambiguous answers validated
   exactly against our SQL computations.

2. **The "always wrong" pattern is model accuracy, not gold quality.** Common
   failure modes:
   - Fee ID over-matching (model ignores `capture_delay`, `monthly_volume`,
     `monthly_fraud_level` constraints) — Q1681, Q1741, Q1753
   - Fee calculation off by 10-30% (incomplete fee rule matching) — Q1712,
     Q1738, Q1748
   - Two-level aggregation missed (model averages over expanded rows instead
     of per-fee-ID first) — Q1273, Q1274, Q1305
   - Incorrect "Not Applicable" responses when data exists — Q1234

3. **One ambiguous answer (Q2697):** Gold says `E:13.57`, model says `E:42.82`,
   our view computes `E:77.68`. All agree ACI E is cheapest, but fee amounts
   differ — likely different fee aggregation methodology (sum all matching rules
   vs. pick most specific). Gold is from `answer_source=official` (Adyen), so
   we trust the ACI choice. The fee amount discrepancy is unresolvable without
   Adyen's exact matching algorithm.

4. **NULL evaluation rows are infrastructure failures, not bugs.** Three
   questions (Q1273, Q1305, Q973) had NULL gold/model from early runs with
   invalid API keys or model IDs. The evaluation code handles this correctly.

5. **Two format-mismatch false negatives found:** Q30 and Q1507 where the
   model produces the correct answer but is scored wrong. These should be
   investigated as potential scorer improvements.

### Confidence Assessment

**High confidence in gold answer quality.** 18/18 spot-checked answers are
correct or from official Adyen ground truth. The consensus methodology is
producing reliable results for the question types we validated. The remaining
6 unchecked always-wrong questions are all in the same categories (steering,
hypothetical MCC changes) and likely follow the same pattern — hard questions
where the model fails, not wrong gold answers.

### Recommended Actions

- No gold answer overrides needed at this time
- Investigate Q30 and Q1507 scorer false negatives (format mismatch)
- Optionally clean up broken run data from results table (runs
  `dabstep_train_1770483000`, `dabstep_train_1770483121`)
- Re-run test split to get proper evaluation of Q973

## Schema

Each line in the JSONL files is a JSON object with:

```json
{
  "task_id": "1712",
  "question": "For the 12th of the year 2023, what is the total fees...",
  "answer": "12.91",
  "answer_source": "hf_consensus",
  "guidelines": "Answer must be just a number rounded to 2 decimals...",
  "level": "hard"
}
```
