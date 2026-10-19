# Wikimedia REST API: pageviews per article (pinned snapshot, 2026-10-19)

Endpoint:
`GET https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}`

- `article`: title with spaces as underscores, URL-encoded (unicode allowed, e.g. `Z%C3%BCrich`).
- `start`/`end`: `YYYYMMDD` or `YYYYMMDDHH`. Data for a day appears some hours after the day ends; a
  request for a range with nothing published yet returns 404 (`"Not found."`), a partial range returns
  only the days that exist.
- Response: `{"items": [{"project", "article", "granularity", "timestamp": "YYYYMMDD00", "access", "agent", "views"}]}`
- A nonexistent article returns 404.

## Request policy (observed and documented)

Wikimedia's [User-Agent policy](https://meta.wikimedia.org/wiki/User-Agent_policy) and
[robot policy](https://w.wiki/4wJS) require every client to send a descriptive `User-Agent` that
identifies the tool and gives contact information (a URL or email), for example:

    User-Agent: my-tool/1.0 (https://example.org/my-tool; ops@example.org)

- Generic library user agents (e.g. `Python-urllib/3.x`, `python-requests/x`) get
  **HTTP 403** with body `Please set a user-agent and respect our robot policy https://w.wiki/4wJS`.
- Clients that identify themselves without contact information are rate limited much more strictly:
  observed **~10 requests per window, then HTTP 429** with a `Retry-After` header in seconds
  (values 10-16 observed). Clients should honor `Retry-After`, serialize requests, and add contact
  information to the User-Agent.
- With contact information in the User-Agent, 30 sequential requests were not limited.
