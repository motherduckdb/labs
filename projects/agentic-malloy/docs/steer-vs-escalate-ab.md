# Steer-instead-of-escalate: A/B result and decision

**Phase 3 (efficiency).** Replaces the opus failover on the sonnet arm with an in-place,
content-bearing steer on repeated compile errors. This doc records the experiment that
justified making the steer the default.

## Question

On the sonnet arm, escalation to opus fired on ~2% of tasks (always "2 consecutive tool
errors") and those tasks ended correct 83–91% of the time. But that figure does **not**
isolate opus: `escalate()` simultaneously (a) switched to opus, (b) injected a fixer prompt,
and (c) granted more turns. Reading the escalated trajectories, every trigger was a Malloy
**compile** error (field-name guessing like `'transaction_date'`; SQL-habit grammar), and
opus's "rescue" was either a clean re-author (it knew the field) or a switch to `submit_sql`
— neither needs opus's intelligence. Hypothesis: **a steer on sonnet matches opus, opus-free.**

## Design — 3 arms × 3 passes × the 27 historically-escalated tasks

Union of the escalated task_ids across the three sonnet held-out runs (2334Z / 1819Z / 2000Z):
`22,48,61,1308,1336,1366,1401,1433,1444,1449,1531,1574,1577,1584,1615,1643,1645,1646,1676,
1679,1747,1763,1775,1826,2713,2728,2755`.

- **A — control:** `--fixer opus` (current opus failover).
- **B — ablation:** `--fixer sonnet` (same escalate structure + generic fixer prompt + extra
  turns, **no model switch**). Isolates the value of opus itself.
- **C — treatment:** the new in-place steer (`stuckAuthorSteer`), opus-free.

## Result (81 task-runs / arm)

| arm | accuracy | cost | $/task | mean elapsed | escalations | steers |
|---|---|---|---|---|---|---|
| A opus | 77/81 (95.1%) | $5.52 | $0.068 | 25.5s | 3 | 0 |
| B sonnet-fixer | 75/81 (92.6%) | $4.79 | $0.059 | 24.9s | 2 | 0 |
| **C steer (opus-free)** | **79/81 (97.5%)** | **$4.70** | **$0.058** | 24.8s | 0 | 1 |

Per-pass: A 26/24/27 · B 26/26/23 · C 27/25/27.

## Verdict

1. **No accuracy regression from dropping opus.** Per-pass swings (23–27 every arm) exceed
   the gap between arm means (25.7 / 25.0 / 26.3) — the arms are statistically
   indistinguishable. Opus-free *tracks* opus.
2. **Opus-free is ~15% cheaper** on this subset (no opus tokens); **latency is flat** (~25s,
   consistent with escalation being ~2% of wall-clock — there is **no speed win**).
3. On the 4 tasks that actually triggered the stuck path, opus-free solved all; opus itself
   missed one (1643) on one pass.

**Honest caveat:** the escalation/steer mechanism fired only **1–3 times per 81 runs** — most
of the 27 "stuck" tasks authored cleanly this time. So this is primarily evidence of *no harm
from dropping opus* plus *the steer handling every real trigger correctly*, **not** proof the
steer is a large accuracy lever. The numbers are also small (81 runs/arm) and not significant.

## Decision

Make the in-place steer the **default** (opus-free). Restore the opus failover with
`--no-steer`. The **official** baseline is unchanged — it is still sonnet-author / opus-failover,
so an official run must pass `--no-steer` (the official gate enforces this).

## Right-sizing / what's next

This is a modest win: ~15% cheaper on the escalation-prone subset (~5% of fleet cost), no
latency change — mostly it **de-risks** (removes the expensive-model dependency) and slightly
improves accuracy. The real Phase-3 levers remain the **per-task baseline** (≈85% of cost =
turns × re-sent context × cache) and the **SQL-exploration grind tail**.
