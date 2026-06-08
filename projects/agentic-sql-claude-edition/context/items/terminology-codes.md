---
id: terminology-codes
domain: terminology
summary: Authoritative value lists for account_type, ACI, and MCC, plus the glossary.
---
> For **"possible values of field X"** questions, return THIS full list verbatim — NOT
> `SELECT DISTINCT`. These domains include codes with **zero rows** in the data
> (account_type `O` = Other; ACI `G` has no fee rules but is still valid). Authoritative
> answers (order doesn't matter — the scorer sorts):
> - account_type → `R, D, H, F, S, O`
> - aci → `A, B, C, D, E, F, G`

**Account Type** (`merchants.account_type`, `fees.account_type`):
| Code | Meaning |
|---|---|
| R | Enterprise - Retail |
| D | Enterprise - Digital |
| H | Enterprise - Hospitality |
| F | Platform - Franchise |
| S | Platform - SaaS |
| O | Other |

**Authorization Characteristics Indicator (ACI)** (`payments.aci`, `fees.aci`):
| Code | Meaning |
|---|---|
| A | Card present - Non-authenticated |
| B | Card present - Authenticated |
| C | Tokenized card with mobile device |
| D | Card Not Present - Card On File |
| E | Card Not Present - Recurring Bill Payment |
| F | Card Not Present - 3-D Secure |
| G | Card Not Present - Non-3-D Secure |

Note: ACI **G has no explicit fee rules** — see `fees-aci-special`.

**MCC (Merchant Category Code):** four-digit code categorizing the merchant.
Descriptions live in `merchant_category_codes` (`mcc` VARCHAR → description). When
a question gives a category *description*, look up its code there (cast
`mcc::BIGINT` to join `merchants.merchant_category_code`).

**Glossary:** AVS = Address Verification Service; CVV = Card Verification Value;
PCI DSS = Payment Card Industry Data Security Standard; ACI = Authorization
Characteristics Indicator.
