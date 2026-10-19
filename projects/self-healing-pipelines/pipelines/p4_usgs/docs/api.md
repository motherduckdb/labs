# USGS FDSN Event Web Service (pinned snapshot, 2026-10-19)

Base: `https://earthquake.usgs.gov/fdsnws/event/1`

- `GET /query?format=geojson&starttime=...&endtime=...&minmagnitude=...&orderby=time`
  returns a GeoJSON FeatureCollection; `properties.time`/`updated` are epoch milliseconds,
  `geometry.coordinates` = `[lon, lat, depth_km]`.
- `GET /count?format=geojson&...same params...` returns `{"count": N, "maxAllowed": 20000}` quickly.
- **Search limit: 20,000 events per query.** A query matching more returns **HTTP 400** with body
  `"<N> matching events exceeds search limit of 20000. Modify the search to match fewer events."`
  - observed only after ~35-40 s. Use `/count` first and split the time range into windows that each
  match <= 20,000 events.
- Empty windows are normal (200 with 0 features). Many properties (`felt`, `cdi`, `mmi`, `alert`) are
  mostly null.
- The service can return 502/503 during maintenance; retry later.
- No API key and no published rate limit; be polite (serial requests).
