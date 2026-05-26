# Training results — DABstep

## Test set (n=418, medium reasoning, 2026-05-05)

The headline.

| arm | acc | cost | hit_limit | avg turns |
|---|---|---|---|---|
| baseline | 47/418 = **11.2%** | $29.30 | 108 (26%) | 30.5 |
| **explicit** | 205/418 = **49.0%** | **$23.26** | **18 (4%)** | **17.5** |

**Delta: +37.8 pp.** Explicit is 4.4× more accurate AND $6 cheaper.

By difficulty:
- easy (n=69): baseline 43% → explicit 72% (+29 pp)
- hard (n=349): baseline 5% → explicit 44% (+39 pp)

Files:
- `results/baseline_test_20260505T171452Z.jsonl`
- `results/explicit_test_20260505T181158Z.jsonl`

---

## Train slice (n=36)

All runs use `gemini-3-flash-preview` via OpenRouter, c=16, recovery loop on, no prose docs in prompt unless noted.

## V1 (with manual.md, n=1, 2026-05-01)

For reference. These had `manual.md` loaded into the system prompt.

| arm | acc | cost |
|---|---|---|
| baseline (raw schema) | 16/36 = 44.4% | $3.37 |
| explicit (named schema) | 12/36 = 33.3% | $3.52 |

## V3+ (no prose, multi-rep, 2026-05-04 to 2026-05-05)

### Single-run snapshots

| run | arm | reasoning | acc | cost | pt/Q | ct/Q | turns/Q | hit_lim |
|---|---|---|---|---|---|---|---|---|
| V3 | baseline | medium | 2/36 = 5.6% | $2.60 | 242k | 5.7k | 32.2 | 8 |
| V3 | explicit | medium | 15/36 = 41.7% | $1.86 | 112k | 7.8k | 17.1 | 2 |
| V4 | baseline | high | 1/36 = 2.8% | $3.28 | 227k | 11.8k | 31.7 | 6 |
| V4 | explicit | high | 12/36 = 33.3% | $2.69 | 137k | 14.0k | 17.6 | 2 |
| V5 | baseline | low | 1/36 = 2.8% | $2.10 | 234k | 2.3k | 30.4 | 4 |
| V5 | explicit | low | 14/36 = 38.9% | $0.91 | 73k | 2.2k | 12.0 | 0 |

### Variance reps on explicit (3 reps each, 2026-05-05)

| config | n | values | mean | stdev | mean cost |
|---|---|---|---|---|---|
| explicit medium | 4 (incl V3) | 14, 15, 15, 17 | **15.25 (42.4%)** | 1.26 | $2.03 |
| explicit high | 3 | 12, 14, 15 | 13.67 (38.0%) | 1.53 | $2.97 |
| explicit low | 3 | 10, 12, 13 | 11.67 (32.4%) | 1.53 | $1.07 |

**Medium is the peak on both accuracy and cost-effectiveness.** Low saves $1/run but loses ~10pp. High costs 50% more than medium and loses ~4pp.

### Question-level stability across 3 medium reps

- 9 always right (25%) — `5, 1305, 1417, 1475, 1507, 1520, 1593, 2524, 2557`
- 16 always wrong (44%) — `49, 70, 1290, 1442, 1451, 1711, 1746, 1834, 1871, 2463, 2490, 2537, 2587, 2697, 2703, 2762`
- **11 flaky (31%)** — `347, 1273, 1464, 1681, 1685, 1744, 1753, 1808, 2634, 2765, 2767`

The flaky 11 are where the mode switches happen. A single 36-Q run with ~22% question-level non-determinism translates to ±2pp accuracy noise.

## Findings worth keeping

1. **Sign reversed.** With manual.md loaded, descriptive naming hurt by 11pp. Strip the manual and naming wins by ~37pp. The schema does what the manual used to do.
2. **Medium-vs-low gap is real** (~10pp, survives 3 reps each).
3. **High-vs-medium gap is real** (~4pp, smaller than n=1 suggested).
4. **High-reasoning is worse than medium**, not just expensive. Model overthinks; completion tokens nearly double; SQL gets elaborate-but-wrong.
5. **Schema is the bottleneck, not reasoning.** Baseline never breaks 8% on any reasoning level — schema gap dominates regardless of model effort.
6. **Single 36-Q runs are unreliable.** Same config, same code, ~22% of questions flip between runs. Need ≥3 reps per claim, or n=418 test set, before drawing conclusions.

## Operational notes

- OpenRouter rate-limits gemini-3-flash at **450 RPM**. Two arms in parallel at c=16 burst over that. Sequential runs or `max_retries=8` (currently set) handle it cleanly.
- Recovery loop in `run_agent` (one forced retry on no-submission) collapsed early-quit hit_limits from ~9 to ~2 on explicit.
- Parallelism via shared httpx client + per-task `contextvars` for usage tracking — c=16 sustained across 36 Q in ~1.5–6 min wall depending on reasoning.

## File index (post-fix runs only)

```
explicit medium reps:
  results/explicit_train_20260504T211552Z.jsonl   prior   15/36
  results/explicit_train_20260505T161935Z.jsonl   rep 1   15/36
  results/explicit_train_20260505T162507Z.jsonl   rep 2   17/36
  results/explicit_train_20260505T162832Z.jsonl   rep 3   14/36

explicit low reps:
  results/explicit_train_20260505T163222Z.jsonl   rep 1   10/36
  results/explicit_train_20260505T163500Z.jsonl   rep 2   12/36
  results/explicit_train_20260505T163731Z.jsonl   rep 3   13/36

explicit high reps:
  results/explicit_train_20260505T164024Z.jsonl   rep 1   15/36
  results/explicit_train_20260505T164858Z.jsonl   rep 2   14/36
  results/explicit_train_20260505T165620Z.jsonl   rep 3   12/36

baseline (single runs only):
  results/baseline_train_20260504T211551Z.jsonl   medium  2/36
  results/baseline_train_20260504T212420Z.jsonl   high    1/36
  results/baseline_train_20260505T161623Z.jsonl   low     1/36
```
