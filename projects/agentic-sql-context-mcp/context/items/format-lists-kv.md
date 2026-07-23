---
id: format-lists-kv
domain: answer_format
summary: How to format list answers and key:value (scheme:fee) answers.
---
**List answers.** When the guidelines say "provide a list" or show
`[a, b, c]`/`eg: A, B, C`:
- Return one column, one row per element (the scorer assembles the list), OR a
  single pre-joined string matching the shown format.
- If the example is bracketed (`['F']`, `[1, 2]`), wrap accordingly — even for a
  single element ("provide a list even if one value").
- Separator: match the example — `, ` (comma-space) if shown as `A, B`; bare
  comma if shown as `A,B`.
- Order: apply the requested order (e.g. "lowest alphabetical first"); otherwise
  the scorer is order-insensitive for comma lists.

**Key:value answers** (e.g. "which card scheme and the fee" →
`{card_scheme}:{fee}`):
- Join with a **colon**, fee rounded as specified: `GlobalCard:1234.56`.
- Produce two columns `(key, value)` or a single `key || ':' || value` string —
  match the exact delimiter/spacing the guideline shows.

When unsure, mirror the guideline's literal example character-for-character.
