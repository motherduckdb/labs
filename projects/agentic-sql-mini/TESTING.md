# Testing plan — end-to-end walkthrough

Step through these in order. Each step is a checkpoint: don't move on until it passes. Total wall time ≈ 10–15 min, with ≈ $0.10 in OpenRouter spend at step 5.

## 0. Prereqs

- `uv` installed.
- `OPENROUTER_API_KEY` available — the harness uses OpenRouter for LLM access.
  `MOTHERDUCK_TOKEN` is **not** required for the eval loop (only needed later if you upload JSONL → MotherDuck for the Dive).

```bash
cd ~/code/agentic-sql-mini
cp .env.example .env
# edit .env, set OPENROUTER_API_KEY=sk-or-v1-...
uv sync
```

**Pass criteria:** `uv sync` finishes clean and `.env` exists with a key.

---

## 1. Build both DuckDB files

```bash
uv run asm load --arm baseline
uv run asm load --arm explicit
```

**Expected output:**
```
Built baseline → /Users/.../agentic-sql-mini/baseline.db
Built explicit → /Users/.../agentic-sql-mini/explicit.db
```

**Pass criteria:** both files exist (`ls *.db`) and table counts match:

```bash
uv run python -c "
import duckdb
for arm in ['baseline','explicit']:
    c = duckdb.connect(f'{arm}.db', read_only=True)
    rows = c.execute(\"SELECT table_name, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name=t.table_name) AS ncols FROM information_schema.tables t WHERE table_schema='main' ORDER BY table_name\").fetchall()
    print(arm, rows)
"
```

You should see 5 tables on each side. Baseline names: `table_1..table_5`. Explicit names: `acquirer_countries, fee_rules, merchant_category_codes, merchants, payments`.

Row counts (both arms): payments=138236, acquirer_countries=8, mcc=769, merchants=30, fee_rules=1000.

---

## 2. Verify the question splits

```bash
uv run python -c "
from src.run import _load_questions
print('train:', len(_load_questions('train')))
print('test:',  len(_load_questions('test')))
"
```

**Pass criteria:** `train: 36`, `test: 418`. (Train is the 26-question template-aware split plus the 10 official DABstep dev questions, merged in so we can iterate against them without contaminating the held-out test set.)

---

## 3. Scorer parity check

The scorer is a verbatim port from `agentic-sql/src/benchmarks/dabstep.py`. Confirm the marquee rules still hold:

```bash
uv run python -c "
from src.score import score, ExecutionError, _fallback_scorer, format_sql_result_as_answer, normalize_to_gold_format

# Fallback scorer: every exception case
assert _fallback_scorer('NL', 'NL') is True                      # case-insensitive direct
assert _fallback_scorer('42.90', '42.9') is True                 # float tolerance
assert _fallback_scorer('B, A, C', 'A, B, C') is True            # order-insensitive lists
assert _fallback_scorer('NexPay:1006.93', 'NexPay') is True      # prefix match (KV)
assert _fallback_scorer(\"['C']\", 'C') is True                  # bracket/quote normalization
assert _fallback_scorer('Not Applicable', '') is True            # N/A equivalence
assert _fallback_scorer('42.89', '42.9') is False                # near-but-not-equal numeric

# format_sql_result_as_answer
assert format_sql_result_as_answer([], None) == 'Not Applicable'
assert format_sql_result_as_answer([(42.9,)], 'rounded to 2 decimal places') == '42.90'

# normalize_to_gold_format (predicted's value is preserved, format coerced)
assert normalize_to_gold_format('42.9', '42.90') == '42.90'

# End-to-end score()
r = score(execution_result=[('NL',)], gold_answer='NL', guidelines=None, predicted_sql='SELECT 1')
assert r.is_correct and r.correctness.value == 'correct'

r = score(execution_result=ExecutionError('X','y'), gold_answer='Not Applicable', guidelines=None, predicted_sql=None)
assert r.is_correct and r.reason == 'no_sql_produced'

print('Scorer parity OK')
"
```

**Pass criteria:** prints `Scorer parity OK` with no AssertionError.

---

## 4. Agent smoke test: one question, explicit arm

This is the first real LLM call. Use `--limit 1` on train so it spends ~$0.001:

```bash
uv run asm evaluate --arm explicit --split train --limit 1 --model google/gemini-3-flash-preview
```

**Expected output (shape, not exact values):**
```
[1/1] ✓ 1507 (correct, 6.3s)

explicit/train: 1/1 = 100.0%
Wrote results/explicit_train_<timestamp>.jsonl
```

**Pass criteria:**
- The line prints with either `✓` (correct) or `✗` (incorrect) — both are fine. The `correctness` value should be one of `correct`, `incorrect`, `error`, `hit_limit`. **NOT crashing** is the test.
- A JSONL file exists in `results/`.
- Inspect the row:

```bash
uv run python -c "
import json
from pathlib import Path
p = sorted(Path('results').glob('explicit_train_*.jsonl'))[-1]
row = json.loads(p.read_text().splitlines()[0])
for k in ['task_id','arm','is_correct','correctness','reason','predicted_sql','predicted_answer','gold_answer','hit_limit']:
    print(f'{k}: {row.get(k)}')
print(f'tool_calls: {len(row[\"tool_calls\"])} calls')
"
```

You should see a non-null `predicted_sql`, a `predicted_answer`, and a few `tool_calls` (list_tables, describe_table, query, submit_answer).

**Failure modes to look for:**
- `hit_limit: true` with no `predicted_sql` → agent never figured out how to use the tools. Check the system prompt in `src/agent.py`.
- `error` with `RunFailure` → API/auth issue. Check `OPENROUTER_API_KEY`.
- `predicted_sql` set but `predicted_answer: null` → DuckDB execution failure during `submit_answer`. Look at `tool_calls[-1].error`.

---

## 5. Both arms, 5 train questions each

This is the comparative smoke test — about ~$0.10 total:

```bash
uv run asm evaluate --arm baseline --split train --limit 5
uv run asm evaluate --arm explicit --split train --limit 5
uv run asm compare results/baseline_train_*.jsonl results/explicit_train_*.jsonl
```

**Pass criteria:**
- Both runs complete without crashing.
- Summary prints accuracy + breakdown by category.
- **Directional sanity check:** explicit ≥ baseline. A tie at this size is fine — the train split is only 36 questions, and 5 of them is a noisy sample. If baseline beats explicit, something is off (explicit.sql wasn't reapplied after edits, or a degenerate slice). Try `--limit 10` before debugging deeper.

This isn't the headline number — the test set is. But on 5 train questions the directional check catches gross schema or scorer bugs.

---

## 6. Inspect a row in detail

```bash
uv run python -c "
import json
from pathlib import Path
p = sorted(Path('results').glob('baseline_train_*.jsonl'))[-1]
for line in p.read_text().splitlines():
    r = json.loads(line)
    if not r['is_correct']:
        print('FAILED', r['task_id'], r['correctness'], r['reason'])
        print('  Q:', r['question'][:140])
        print('  gold:', r['gold_answer'])
        print('  pred:', r['predicted_answer'])
        print('  sql: ', (r['predicted_sql'] or '')[:200])
        break
"
```

**Pass criteria:** a failure case (if any) is legible — you can tell from the row whether it failed because of (a) bad SQL, (b) wrong answer format, (c) hit_limit, or (d) scorer rejecting an arguably-correct answer.

If (d) keeps happening on cases that should pass, the scorer port has a bug — go look at `src/score.py` against `~/code/agentic-sql/src/benchmarks/dabstep.py`.

---

## 7. (Optional) Full train run

Once steps 1–6 pass, run the full 36-question train set on each arm to start hand-tuning `schemas/explicit.sql`. Roughly $1–$2 / arm at `--reasoning medium`.

```bash
uv run asm evaluate --arm baseline --split train --model google/gemini-3-flash-preview
uv run asm evaluate --arm explicit --split train --model google/gemini-3-flash-preview
```

This is your iteration loop:
1. Run both arms on train.
2. Look at the explicit-arm failures.
3. Sharpen `schemas/explicit.sql` (rename, denormalize, restructure — comments and views still out of scope).
4. `asm load --arm explicit` and re-run.

---

## 8. Test run (held-out, lock the result)

Don't run this until `explicit.sql` is locked. ~$15–$30 total at Gemini 3 Flash pricing with `--reasoning medium` for 418 × 2 arms.

```bash
uv run asm evaluate --arm baseline --split test --model google/gemini-3-flash-preview
uv run asm evaluate --arm explicit --split test --model google/gemini-3-flash-preview
```

**Headline number:** `(explicit accuracy) − (baseline accuracy)`.

---

## What's not tested here

- **MotherDuck upload + Dive.** That's the visualization layer; not built yet. Once the JSONLs exist, the next step is a small `asm upload` command that creates a results table on MotherDuck and a Dive that queries it.
- **Multi-model robustness.** Single model (Gemini 2.5 Flash) for the V1 result. Add a second model only if Jacob decides it's worth the spend.
- **Official `dabstep_benchmark` package.** The scorer falls back to its own implementation if `dabstep_benchmark` isn't installed (which it isn't in this repo). The fallback is a verbatim port of upstream's fallback, but if you want bit-exact parity with the HF leaderboard, `uv add dabstep-benchmark` and re-run.
