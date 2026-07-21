---
id: terminology-term-mapping
domain: terminology
summary: Maps loose wording to fields — customer / shopper / repeat customer / "per unique shopper" = NON-NULL email_address; fraud rate (amount-weighted) vs "% of transactions fraudulent" (count); avg fraud rate per X = pooled ratio; "Nth of year", intracountry, "which ACI minimizes fees".
---
Questions use imprecise language. Map it to the data:

| Wording | Means | Field / computation |
|---|---|---|
| "the Nth of the year" | the Nth **day** | `day_of_year = N` (not month N) |
| "in [Month] [Year]" | a calendar month | `MONTH(MAKE_DATE(year,1,1)+INTERVAL (day_of_year-1) DAY)=M` |
| "customer" / "shopper" / "unique customer" | a NON-NULL `email_address` by default; but honor an explicit basis ("based on IP" → `ip_address`, "based on card" → `card_number`) with NO email filter | email-based: `... WHERE email_address IS NOT NULL`; IP-based: `COUNT(DISTINCT ip_address)` |
| "fraud rate" | amount-weighted ratio (0–1) | `SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)/SUM(eur_amount)` |
| "avg fraud rate per/by/of X" / "...for [period]" | a SINGLE pooled amount-weighted ratio over the whole filtered set, grouped by X — **NOT** a mean of per-month rates | `SELECT X, SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)/SUM(eur_amount)*100 FROM payments WHERE <period> GROUP BY X` then MIN/MAX over X |
| "percentage of fraudulent transactions" | count-based (0–100) | `COUNT(*) FILTER (has_fraudulent_dispute)/COUNT(*)*100` |
| "intracountry" / "domestic" | issuer = acquirer country | `issuing_country = acquirer_country` |
| "which ACI minimizes/maximizes fees" | single best ACI **across all schemes** | aggregate fee per ACI over A–F, pick min/max — NOT a per-scheme breakdown |
| "top / most / highest [country/entity] for fraud" | highest **amount-weighted fraud rate** (NOT highest count) | `... ORDER BY SUM(eur WHERE fraud)/SUM(eur) DESC LIMIT 1` — ranking by fraud COUNT gives the wrong answer |
| "the dataset" / "merchants in the dataset" | the payments table | `COUNT(DISTINCT merchant) FROM payments` |

Gotchas:
- **Fraud rate (amount-weighted ratio)** and **% of fraudulent transactions
  (count-based)** are different measures — read which one is asked.
- "Percentage" answers are on a 0–100 scale; if you compute a 0–1 ratio, ×100.
- **"avg fraud rate" is NOT a mean of monthly rates.** Compute ONE pooled
  amount-weighted ratio over the entire filtered period (all of Q3, all of 2023…),
  then MIN/MAX across the grouping dimension. Averaging per-month rates gives a
  wrong value in the 3rd–4th decimal.
- "Average X per unique Y" (counts/values, not fraud rate) = average of per-group
  averages: `SELECT AVG(g) FROM (SELECT Y, AVG(X) g FROM t GROUP BY Y)`.
- **Shopper basis: honor what the question names.** A shopper/customer defaults to
  a NON-NULL `email_address` — BUT if the question specifies a different basis, use
  THAT field directly with **no email filter**: "based on IP address" →
  `COUNT(DISTINCT ip_address)`; "based on card" → `card_number`. The email rules
  below apply ONLY to email-based shopper metrics.
- **NULL emails (~13.8k transactions)** — for email-based shopper metrics, a NULL
  email is not a shopper. The denominator is whatever noun the question divides by —
  match the pattern:
  - **"... per (unique) shopper/customer"** → denominator = shoppers, numerator =
    transactions that belong to a shopper. BOTH exclude nulls:
    `COUNT(*) FILTER (email_address IS NOT NULL) / COUNT(DISTINCT email_address)`.
  - **"% of customers/shoppers who are repeat"** → over distinct non-null emails:
    `COUNT(*) FILTER (c>1) / COUNT(*)` from `(SELECT COUNT(*) c FROM payments WHERE email_address IS NOT NULL GROUP BY email_address)`.
  - **"% of [transactions] made by repeat customers"** → denominator = ALL such
    transactions (and any percentile threshold is over ALL transactions — do NOT
    pre-filter nulls); numerator = transactions whose email appears >1 time. A
    null-email transaction is in the denominator but never the numerator.
