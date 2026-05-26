# Hydration Errors Analysis

## Status: ALL 151 QUERIES EXECUTED SUCCESSFULLY

All 151 train queries now execute successfully against MotherDuck.

## Automatic Fixes (via sqlglot)

### STRFTIME returns VARCHAR
**Problem**: `strftime('%Y', date) - strftime('%Y', date)` fails because DuckDB strftime returns VARCHAR, not INTEGER.

**Solution**: In `_patch_sqlite_functions`, detect `TimeToStr` nodes with numeric format patterns and wrap in `CAST(... AS INTEGER)`.

## Manual Overrides (10 queries)

These queries required hand-written DuckDB SQL in `QUERY_OVERRIDES`:

| Question | Issue | Fix |
|----------|-------|-----|
| Q1011 | Time format `m:ss.sss` parsing with CTEs | Use `split_part()` for time parsing |
| Q944 | Complex time parsing in CTEs | Preserve CTE structure, fix time parsing |
| Q518 | CTE `MaxBanned` not preserved | Explicitly write CTE with schema qualification |
| Q1032 | `league_id` missing from GROUP BY | Add proper GROUP BY clause |
| Q963 | Time format parsing | Use `split_part()` for `m:ss.sss` format |
| Q988 | AVG on VARCHAR duration | Use `milliseconds` column instead |
| Q880 | CASE with VARCHAR/INTEGER mix | Cast `fastestLapSpeed` to DOUBLE |
| Q1185 | DATE LIKE pattern | Cast Date to VARCHAR |
| Q1192 | DATE LIKE pattern | Cast Date to VARCHAR |
| Q1481 | IIF function + BETWEEN types | Replace IIF with CASE WHEN, cast Date |
