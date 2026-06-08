---
id: schema-payments
domain: schema
summary: Column dictionary for the payments fact table (one row per transaction).
---
**`payments`** — the fact table, one row per transaction. Native column names:

- `psp_reference` — unique transaction id.
- `merchant` — merchant name (e.g. `Crossfit_Hanna`). Joins to `merchants.merchant`.
- `card_scheme` — network: MasterCard, Visa, Amex, Other (and synthetic names like NexPay, GlobalCard, TransactPlus in the fee rules).
- `year`, `day_of_year`, `hour_of_day`, `minute_of_hour` — timing. There is NO month column; derive it (see `bucketing-month`).
- `is_credit` — boolean, credit vs debit card.
- `eur_amount` — transaction amount in euros (the value used in the fee formula).
- `ip_country`, `issuing_country`, `acquirer_country` — 2-letter country codes (SE, NL, LU, IT, BE, FR, GR, ES).
- `device_type`, `ip_address`, `email_address`, `card_number`, `card_bin` — shopper/device identifiers (hashed).
- `shopper_interaction` — Ecommerce or POS (POS = in-person).
- `has_fraudulent_dispute` — boolean; the fraud indicator.
- `is_refused_by_adyen` — boolean.
- `aci` — Authorization Characteristics Indicator letter (A–G). See `terminology-aci`.

Key facts:
- **A customer = `email_address`**, not `card_number`.
- **Intracountry (domestic)** = `issuing_country = acquirer_country`.
- "The dataset" / "merchants in the dataset" = this table (see `schema-scope`).
