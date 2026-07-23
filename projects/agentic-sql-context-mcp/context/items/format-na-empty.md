---
id: format-na-empty
domain: answer_format
summary: When to answer "Not Applicable" versus the empty string "".
---
Two distinct cases that are easy to confuse:

- **`Not Applicable`** — use ONLY when the question asks about a concept that is
  **not defined** in the manual or schema. The classic trigger: the question names a
  specific **fine / penalty / fee / threshold** (e.g. "high-fraud-rate fine",
  "excessive retry fee", "excessive fraud threshold") that the documentation never
  defines — no named fee, no numeric cutoff, no formula. Decision: identify the exact
  named concept → does the manual/schema define THAT thing (not a cousin)? If not,
  it's `Not Applicable`.
  - Do NOT rescue it by mapping to an adjacent concept and computing a number: fee
    bucket boundaries (`monthly_volume`, `monthly_fraud_level`) are pricing tiers,
    NOT regulatory thresholds; "excessive retrying → downgrade" is not a "retry fee";
    PCI-DSS penalties (EUR5k–100k/mo) are not a "fraud fine".
  - Contrast — these ARE answerable, do NOT mark NA: fraud RATE (fraud volume / total
    volume), fraud COUNT, and total FEES from the `fees` table are all defined. Only a
    named, undefined CHARGE/THRESHOLD is `Not Applicable`.
  - **"% of the dataset that is missing" / "% null" / "data completeness"** is a real
    metric — compute it, do NOT answer `Not Applicable`:
    `(sum of NULL cells across all columns) / (row_count * column_count) * 100`.

- **Empty string `""`** — use when a correct query simply returns **no rows**
  (e.g. the merchant had no transactions that day). An empty result is `""`, NOT
  `Not Applicable`.

Never return `Not Applicable` because a query errored or returned 0 rows — fix
the query, or return `""` if genuinely empty.
