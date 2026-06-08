---
id: fees-directionality
domain: fees
summary: Which fee dimensions make fees cheaper or costlier (from the manual) — use these stated rules, not computed averages.
---
When a question asks which factors make fees **cheaper** or **more expensive**,
answer from the manual's stated directionality — do NOT compute averages from the
fees table (raw averages are misleading because the dimensions are correlated).

| Factor | Direction | Manual basis |
|---|---|---|
| `is_credit` | **credit (True) is costlier** | "credit transactions are more expensive" |
| `intracountry` | **domestic (True) is cheaper** | "local acquiring … lower fees" |
| `capture_delay` | **faster capture is costlier** (so longer delay / `>5` / `manual` is cheaper) | "the faster the capture to settlement happens, the more expensive it is" |
| `monthly_volume` | **higher volume is cheaper** | "merchants with higher volume … cheaper fees" |
| `monthly_fraud_level` | **higher fraud is costlier** | "more expensive as fraud rate increases" |

Summary — there are TWO distinct question families; do NOT mix them:

**Ordinal factors** (`monthly_volume`, `capture_delay`, `monthly_fraud_level`) — the
ONLY factors that belong in "value is increased / decreased" questions. Booleans are
never part of an increase/decrease answer.
- Cheaper if the value is **increased** → `monthly_volume, capture_delay`
- Cheaper if the value is **decreased** → `monthly_fraud_level`

**Boolean factors** (`is_credit`, `intracountry`) — belong ONLY in "set to True / set
to False" questions; never report them for increase/decrease.
- Cheaper if set to **True** → `intracountry`
- Cheaper if set to **False** → `is_credit`
