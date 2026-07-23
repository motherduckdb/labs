---
id: bucketing-capture-delay
domain: bucketing
summary: How to bucket merchants.capture_delay (VARCHAR) into the fee-rule buckets.
---
`merchants.capture_delay` is VARCHAR: either a number of days, or the literals
`'immediate'` / `'manual'`. Fee rules use bucket strings. Convert:

```sql
CASE WHEN TRY_CAST(capture_delay AS INTEGER) < 3 THEN '<3'
     WHEN TRY_CAST(capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
     WHEN TRY_CAST(capture_delay AS INTEGER) > 5 THEN '>5'
     ELSE capture_delay   -- 'immediate' and 'manual' pass through unchanged
END AS capture_delay_range
```

Then match `fees.capture_delay = capture_delay_range OR fees.capture_delay IS NULL`.

**CRITICAL — do NOT remap `'immediate'` or `'manual'` to a numeric bucket.** They are
their OWN fee buckets and must match fee rules with `capture_delay = 'immediate'` /
`'manual'` exactly. `'immediate'` does NOT mean `'<3'`.
```
RIGHT:  ... ELSE capture_delay END          -- 'immediate' -> 'immediate'
WRONG:  ... WHEN capture_delay='immediate' THEN '<3' ...   -- changes which fee rules match → wrong answer
```
(This silently flips fee/steering answers for merchants like Martinis_Fine_Steakhouse
whose `capture_delay = 'immediate'`.)
