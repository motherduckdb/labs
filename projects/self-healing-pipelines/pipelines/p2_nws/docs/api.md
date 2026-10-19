# NWS API (api.weather.gov): gridpoint forecast (pinned snapshot, 2026-10-19)

`GET https://api.weather.gov/gridpoints/{office}/{gridX},{gridY}/forecast`

- Requires a `User-Agent` identifying the application (contact recommended). No API key.
- `Accept: application/geo+json` (default) returns GeoJSON; periods are in `properties.periods[]`.
- Query `units=us` (default) or `units=si` changes the *values* (and `temperatureUnit`), not the shape.

Period object (default format):

| field | type | example |
|---|---|---|
| `number` | int | 1 |
| `name` | string | "Tonight" |
| `startTime`, `endTime` | ISO 8601 with offset | "2026-10-19T18:00:00-07:00" |
| `isDaytime` | bool | false |
| `temperature` | int | 60 |
| `temperatureUnit` | "F" or "C" | "F" |
| `windSpeed` | string | "5 to 10 mph" |
| `shortForecast` | string | "Mostly Cloudy" |

## Feature flags

The API rolls out format changes behind the `Feature-Flags` request header before making them the
default. With `Feature-Flags: forecast_temperature_qv`, `temperature` becomes a WMO quantitative value
and `temperatureUnit` is dropped (null):

```json
"temperature": {"unitCode": "wmoUnit:degC", "value": 15.555555555555555},
"temperatureUnit": null
```

`unitCode` is `wmoUnit:degC` or `wmoUnit:degF`. Clients should accept both shapes during a rollout.
When the server itself starts sending the new shape, no request header is involved.
