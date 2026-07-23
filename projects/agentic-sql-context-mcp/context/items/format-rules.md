---
id: format-rules
domain: answer_format
summary: General strict-validator rules — exact example format, rounding, single values, casing.
---
The validator compares your answer string to the gold string strictly. Make the
SQL result the exact answer.

- **Return ONLY what is asked — nothing more.** `submit_answer`'s SQL must select
  exactly the answer value(s) and no extra columns, labels, breakdowns, or
  explanation. If the question asks "which ACI", return one ACI letter — not the
  ACI plus a per-scheme fee breakdown. A correct value with extra text appended
  (e.g. `D SwiftCharge:14.90,…` when the gold is `D`) is marked WRONG. When a
  guideline's stated format seems to conflict with what's actually being asked
  (e.g. it shows `{card_scheme}:{fee}` but asks only "which ACI"), answer the
  question literally and keep the output minimal.

- **Replicate any example format** in the guidelines. If they show `eg: A, B, C`,
  use that spacing/separator/order. If they show `X. Y` (e.g. multiple-choice),
  output exactly that shape (`B. BE`).
- **Rounding**: apply exactly the decimals stated ("rounded to N decimals" →
  `ROUND(value, N)` in the SQL). Never return extra precision; never fewer
  decimals than asked (e.g. `0.0`, not `0`, if a decimal is expected).
- **Single value**: return one scalar; don't wrap it unless asked.
- **Country codes / single words**: return the bare code (`NL`), correct case.
- **Yes/No** questions: return `yes` or `no` (the scorer is case-insensitive but
  match the guideline's wording when shown).
- Apply any **ordering** the guidelines specify; otherwise list order is
  normalized by the scorer.
