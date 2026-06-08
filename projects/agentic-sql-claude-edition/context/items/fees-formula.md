---
id: fees-formula
domain: fees
summary: The fee formula and the dedupe-by-fee-id rule when averaging fees.
---
**Fee formula (per matching rule, per transaction):**
```
fee = fixed_amount + (rate / 10000.0) * eur_amount
```
`rate` is in basis points, so divide by 10000. `fixed_amount` and `eur_amount`
are euros.

- **Totals** (e.g. "total fees a merchant paid"): sum `fee_amount` over every
  matching (transaction × rule) pair. A transaction matching 3 rules contributes
  3 fees.
- **Averaging across fee rules** (e.g. "average fee the card scheme would charge
  for a transaction of V eur"): a single fee `ID` always has the same
  `fixed_amount` and `rate`, so **deduplicate by fee `ID` first**, then average
  over the distinct rules. Don't average over duplicated rows.
- For abstract "for a transaction value of V eur" questions there is no real
  transaction — substitute the literal V into the formula:
  `fixed_amount + rate / 10000.0 * V`.

See `sql-avg-fee` and `sql-total-fees-merchant` for worked templates.
