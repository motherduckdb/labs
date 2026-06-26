# Layer rebuild outcome — fixed the AVG defect, but net-negative (NOT promoted)

A full `layer-build` regen (opus, 4 rounds, $3.68) was run to fix the c3 AVG-ranking
defect at the source (the always-fail most-expensive-{ACI|MCC|scheme} template). New
hash `a2a8a381` (old `d7a2545e`). **Result: parked on `agentic-malloy-layer-rebuild`,
not merged — `main` keeps the old layer.**

## What the rebuild fixed
- Build gate findings **18 → 1**: the `name_vs_aggregation` views (`most_expensive_aci_on_100`
  et al. ranking by AVG) are gone; the `aci` universe is data-derived; SUM surfaces exist
  (`total_fees_paid is rules.sum(...)`, `sum_fee_at_{50,100,1000,50000}`).
- The c3 file was restructured + renamed (`c3_average_fee_scenarios` → `c3_payments_enriched`).
- Train reps **1442 ✓ / 1451 ✓**.

## Why it's net-negative (train 24/26 → 22/26)
- **No score gain from the fix.** The SQL bypass + skill conventions already passed 1442/1451
  on the old layer, so fixing the AVG view recovered nothing on the score.
- **Two real, structural regressions (not noise):**
  - **2587 / 2634 / 2762 (steering)** — the regen **dropped ALL counterfactual/candidate
    sources** (the old layer had `c5_payments_priced_card_scheme_counterfactual` + ACI/MCC
    siblings; the new layer has zero). With no counterfactual view to reuse, the agent
    hand-rolls wrong SQL. A capability regression.
  - **1834 (total fees)** — the new `fees_by_merchant_month` view exposes BOTH a specific
    and an effective fee column (from the wrong-grain "expose both" coaching); the agent
    returned the whole row (`merchant,month,4573.00,3767.90`) instead of the effective
    total `3767.90` — a shape error the richer view induced.

## Lessons
- **Full `layer-build` regen is lossy** — it fixed the targeted defect but silently dropped
  the counterfactual modeling the prior layer had. The build prompt doesn't know to
  preserve existing capabilities; a from-scratch regen is not a safe "patch."
- **The substrate verdict holds / sharpens** — fixing the layer's structural defect did NOT
  move the score, because the agent routes around the layer via SQL anyway. The layer's
  value isn't being realized; the SQL escape + skill carry the load.
- If the c3 defect is ever worth fixing on the live layer, it needs a **surgical** path
  (targeted `layer-improve` edit that adds a SUM/total-fee ACI surface + fixes meta routing
  WITHOUT dropping the counterfactual sources), not a full regen.
