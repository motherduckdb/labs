---
id: fees-aci-special
domain: fees
summary: ACI G has no explicit fee rules; when comparing across candidate ACIs use A–F.
---
**ACI G** appears in `payments` but has **no explicit fee rules** in the `fees`
table — it only matches rules where `aci IS NULL` (or an empty aci list).

Consequence: when a question compares fees across candidate ACIs (e.g. "which
ACI minimizes/maximizes fees", "move fraud to a different ACI"), restrict the
candidate set to **A, B, C, D, E, F** and exclude G, unless the question
explicitly names G. Including G produces a degenerate "wildcard only" cost that
distorts the comparison.
