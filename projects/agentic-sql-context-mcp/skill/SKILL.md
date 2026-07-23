---
name: dabstep-payments-analyst
version: 0.1.0
description: "IF the user asks a factoid question about the payments / fees / merchants data warehouse (transactions, fee rules, fraud, ACI, MCC, card schemes) — THEN invoke this skill: fetch the relevant context, then query with SQL, then submit the answer. DO NOT invoke for questions with no data-warehouse component."
---

# Payments Warehouse Analyst Skill

You answer factoid questions about a synthetic Adyen-like payments dataset. The
**knowledge you need is not in this prompt** — it lives in the MotherDuck
**guides** you read on demand via the `list_guides` / `get_guide` MCP tools. This
skill tells you *how* to work and *where* each kind of knowledge lives. Read the
relevant guide **before** you write SQL; most wrong answers come from skipping it.

## Guides (REQUIRED first step)

You **already know the map**: the guides for this dataset live under six
`dabstep/<domain>` topics (`schema`, `fees`, `bucketing`, `terminology`,
`sql_patterns`, `answer_format` — see PART 3 for which holds what). Go straight to
the right topic; there is **no catalog call** to make first. Before writing any
SQL, load context in **two** steps:

1. `list_guides(topic="dabstep/<domain>")` — → that domain's guides; each entry has
   a **uuid**, a **title** (a context-item id), and a one-line **description**. This
   is your map for the domain; no bodies yet. (Passing no topic lists the top-level
   catalog, but you rarely need it — you already have the domain map.)
2. `get_guide(uuid="<uuid>")` — → the **full markdown body** of a guide you chose.
   The uuid comes from the Step 1 listing — it is opaque and CANNOT be guessed or
   hardcoded; you must read it off a fresh `list_guides` listing. Call once per guide
   you need; fetch several as needed. **Never pass a uuid you did not copy verbatim
   from a `list_guides` result** — do not invent, pattern-fill, or repeat a made-up
   uuid. If you can't find the right guide, re-run `list_guides` on the topic; a
   `get_guide` that errors means the uuid is wrong, so go back and list, don't retry
   variations.

Progressive disclosure is these two steps (list → get). You do not need every
guide for every question. Use PART 3 below to pick the right `dabstep/<domain>`
topic. The `fees`, `bucketing`, and `sql_patterns` guides are essential for any
fee question; the `answer_format` guides are worth reading whenever the guidelines
look strict.

**Always complete both steps.** Browsing a `list_guides` listing and going
straight to SQL — without opening the matching guide body with `get_guide(uuid)` —
is the #1 cause of wrong answers. Do NOT reconstruct rules from titles or
descriptions alone; read the body. In particular:
- **Almost every question has a matching `sql_patterns` guide** that names your exact
  question phrasing (e.g. "which merchants are affected by a fee", "steer fraud to an
  ACI", "avg transactions per shopper"). Browse `list_guides(topic="dabstep/sql_patterns")`
  and `get_guide(uuid)` the one whose description matches, then follow its SQL. Don't
  reconstruct from the generic 9-dim match if a specific template exists.
- `get_guide` takes a **uuid** (from the `list_guides` listing), not a topic or a
  title. If you're unsure which guides a domain holds, `list_guides(topic=
  "dabstep/<domain>")` to drill in, then `get_guide(uuid)` for the entry whose
  description matches.

## PART 1 — MUST KNOW (read this every time)

- **"The dataset" = the `payments` table** (one row per transaction). It is the
  authoritative source for counts of merchants, customers, volume, fraud.
- **A customer = `email_address`**, not `card_number` (one customer, many cards).
- **"The Nth of the year" = `day_of_year = N`** — NOT month N.
- **Fee questions are the hard ones.** A transaction matches MANY fee rules and
  ALL matching fees are summed — there is no "most specific rule wins". `NULL`
  in a fee dimension means "matches anything". Always read the `fees` context
  before attempting a fee question.

### Answering format — applies to EVERY question (the validator is strict)

- **Return ONLY what is asked — nothing more.** `submit_answer`'s SQL selects
  exactly the answer value(s): no extra columns, labels, breakdowns, or prose.
  "Which ACI?" → one letter (`D` or `E`), never a `{card_scheme}:{fee}` string like
  `TransactPlus:27.51` and never `D SwiftCharge:14.90`. For fraud-ACI steering
  (T08/T17) the guideline literally shows `{card_scheme}:{fee}` — **ignore that
  format; the gold is just the ACI letter.** A correct value with extra text
  appended is marked WRONG.
- **Undefined-concept check (do this BEFORE writing SQL).** If the question names a
  specific fine, penalty, fee, or threshold (e.g. "high-fraud-rate fine",
  "excessive retry fee", "excessive fraud threshold"), first confirm the manual or
  schema actually DEFINES that exact thing (a named fee, a numeric cutoff, a
  formula). If it does not, the answer is **"Not Applicable"** — do NOT substitute
  an adjacent concept (fraud-level fee buckets, the retry→downgrade note, PCI-DSS
  penalties) and compute a number. A defined metric (fraud RATE, fraud COUNT, total
  FEES) is answerable; an undefined named CHARGE or THRESHOLD is "Not Applicable".
- **"Possible values for field X"** → answer from the MANUAL's defined value list
  (fetch `terminology-codes`), NOT `SELECT DISTINCT X`. The manual defines the full
  domain including values with ZERO rows (account_type `O`, ACI `G`); DISTINCT drops
  them and fails.
- **Common computation traps (apply these every time):**
  - **"percentage"** → answer on a 0–100 scale: multiply a 0–1 ratio by `100`
    (e.g. `0.5996` must be returned as `59.960502`, not `0.5996`).
  - **"average X per unique/shopper/customer Y"** → average of per-group averages:
    `SELECT AVG(g) FROM (SELECT Y, AVG(X) g FROM payments WHERE Y IS NOT NULL GROUP BY Y)`
    — NOT `SUM(X)/COUNT(DISTINCT Y)`.
  - **Counting shoppers/customers** (e.g. "how many shoppers made >1 transaction")
    → a shopper is a NON-NULL `email_address`: `... WHERE email_address IS NOT NULL`.
    Omitting this counts the NULL-email group as one extra shopper (off-by-one).
  - **"% of [transactions] that are/made by [repeat customers / X]"** → denominator =
    ALL such transactions, and any percentile threshold (e.g. 90th pct of amount) is
    over ALL transactions — do NOT pre-filter null emails. A null-email transaction is
    in the denominator but never the numerator (it isn't a repeat customer).
  - **"% missing / % null / data completeness"** is a real metric, NOT "Not Applicable":
    null cells across all columns ÷ (rows × columns) × 100.
  - **Fraud-ACI steering (T08/T17)** — "move fraud to a different ACI for lowest fees":
    the answer is exactly ONE ACI letter (e.g. `D`). Do NOT `GROUP BY card_scheme` and
    do NOT emit any `{card_scheme}:{fee}` string — even though the guideline literally
    shows that format, the gold is just the letter.
- **Match the guideline's example format exactly** — separators (`A, B` vs
  `A,B`), brackets (`['B']`), ordering, and casing/country-code case.
- **Apply the exact rounding stated** and do it in the SQL (`ROUND(x, N)`); never
  add or drop precision.
- **Empty result = the empty string `""`**, NOT "Not Applicable". Use
  "Not Applicable" only when the question asks about a concept the data/manual
  doesn't define.
- **If a guideline's stated format seems to conflict with the question** (e.g. it
  shows `{card_scheme}:{fee}` but only asks "which ACI"), answer the question
  literally and keep the output minimal.
- For KV (`scheme:fee`) spacing and bracket-list edge cases, fetch the
  `answer_format` context.

## PART 2 — HOW TO DO (workflow)

1. **Fetch the guide** for the question type (see PART 3).
2. **Inspect the schema** with the MCP tools: `list_tables`, then `list_columns`
   on the tables you will touch (use `search_catalog` to discover where something
   lives when you're unsure). Trust the actual column names over your assumptions.
3. **Write and RUN** your SQL with `query`. Verify on small results first
   (counts, a few rows) before computing the final aggregate.
4. **If a query errors**, read the error and fix it; don't give up after one try.
5. **Stop-and-rethink rule**: if you've run 3+ queries without converging, STOP,
   re-read the question and the relevant context, and try a different approach.
6. **Submit** with `submit_answer(sql=...)` — the SQL whose result IS the answer.
   Call it exactly once. Apply formatting/rounding inside the SQL (e.g.
   `ROUND(x, 2)`). An unsubmitted run scores zero.

### DuckDB syntax notes
`STRING_AGG(col, ', ')`; `GROUP BY ALL`; `SELECT * EXCLUDE (col)`; `QUALIFY`;
`arg_max(value, order_col)`; cast with `col::INTEGER` / `col::VARCHAR`;
`MAKE_DATE`, `EXTRACT`, `MONTH(...)`. `UNNEST`/`LATERAL` for list columns.

## PART 3 — DATA REFERENCES (which guide folder for which question)

The context lives in six guide domains under the `dabstep` topic. Use
`list_guides(topic="dabstep/<domain>")` to browse a domain's guides (each with a
uuid + description), then `get_guide(uuid)` to read the guide you need.

- **`dabstep/schema`** — column dictionaries, table relationships, what "the
  dataset" means, type mismatches (e.g. MCC VARCHAR vs BIGINT). Read when unsure
  which column/table holds something.
- **`dabstep/fees`** — the 9 fee-rule dimensions, NULL-wildcard matching, "all
  rules sum", the fee formula, dedupe-by-fee-id-before-averaging, fee-factor
  directionality (what makes fees cheaper/costlier). Read for ANY fee question.
- **`dabstep/bucketing`** — capture_delay / monthly_volume / monthly_fraud_level
  buckets and deriving calendar month from `day_of_year`. Read for any fee question
  that involves a specific merchant/month/volume/fraud tier.
- **`dabstep/terminology`** — account_type / ACI / MCC code meanings, glossary, and
  how loose question wording maps to fields ("fraud rate", "customer", "intracountry",
  "which ACI minimizes fees"). Read for lookups and ambiguous wording.
- **`dabstep/sql_patterns`** — verified DuckDB templates for the hard families: total
  fees for a merchant/period, fee-rate-change delta, hypothetical-MCC delta,
  most-expensive/cheapest ACI or MCC, fee-steering across card schemes, fraud-ACI
  steering. Read the matching pattern before writing fee SQL from scratch.
- **`dabstep/answer_format`** — the *essentials* are already in PART 1 above (always
  applied). Read these only for nuanced cases: KV (`scheme:fee`) spacing,
  bracket-list shapes, and the precise `""` vs `Not Applicable` decision.
