# P5 marts: inputs

P5 has no external API. It reads the tables written by P1-P4 in the same data database:

| input | written by | notes |
|---|---|---|
| `p1_wiki.pageviews` | P1 | (article, day) PK, daily views |
| `p2_nws.forecast_periods` | P2 | latest forecast snapshot; `temperature` DOUBLE + `temperature_unit` 'F'/'C' |
| `p3_github.orders`, `p3_github.products` | P3 | orders incremental on `updated_at`; products full refresh |
| `p4_usgs.earthquakes` | P4 | id PK |

A P5 test failure whose upstream table is broken is a *symptom*; fix the upstream pipeline, not P5.
