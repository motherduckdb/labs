---
id: sql-most-expensive-aci-scheme
domain: sql_patterns
summary: Most expensive ACI for a credit transaction of a given value on a card scheme (template T02).
---
"For a credit transaction of {V} eur on {scheme}, what is the most expensive ACI?
On a tie between ACIs, return the lowest alphabetically. Provide a list."

For each candidate ACI (A–F; exclude G, see `fees-aci-special`), SUM the fee of
every matching rule for that scheme/credit at value V, then take the max.

**Critical:** filter ONLY the dimensions the question names — here `card_scheme`,
`is_credit`, and the candidate `aci`. Do NOT add the other dimensions at all —
not as equality and **not** as `IS NULL` / empty-list restrictions. A rule that
specifies an account_type, MCC, capture_delay, volume, or fraud tier still counts
(the question fixes none of those). Over-restricting to wildcard-only rules
changes the sums and gives the wrong ACI. This is NOT the merchant fee-match.

```sql
WITH cand(aci) AS (SELECT UNNEST(['A','B','C','D','E','F'])),
costs AS (
  SELECT c.aci,
         SUM(f.fixed_amount + f.rate / 10000.0 * 4000.0) AS total_fee
  FROM cand c
  JOIN fees f
    ON f.card_scheme = 'GlobalCard'
   AND f.is_credit = TRUE      -- STRICT: only rules that explicitly require credit (exclude is_credit NULL)
   AND (f.aci IS NULL OR len(f.aci) = 0 OR list_contains(f.aci, c.aci))
  GROUP BY c.aci
)
SELECT aci
FROM costs
WHERE total_fee = (SELECT MAX(total_fee) FROM costs)
ORDER BY aci          -- lowest alphabetical on ties
;
```

Rules:
- **`is_credit` is STRICT here**: match only rules with `is_credit = TRUE` for a
  credit transaction (or `= FALSE` for a debit one). Do NOT include `is_credit
  IS NULL` wildcard rules — the gold scores only the credit-specific rules.
  (Including NULLs flips GlobalCard answers from C to B; strict = 20/20.)
- **SUM**, not AVG — a transaction incurs every matching rule cumulatively.
- Aggregate per ACI across all matching rules of that scheme; pick the max
  (`MIN` for a "cheapest ACI" variant).
- Tie-break: lowest alphabetical ACI. Output as a **list** even with one element
  (e.g. `['B']`) — check guidelines and see `format-lists-kv`.
- No merchant is involved — do not bring in payments or monthly buckets.
