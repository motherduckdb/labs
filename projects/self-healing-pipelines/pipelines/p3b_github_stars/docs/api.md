# GitHub REST API (pinned snapshot, 2026-10-19)

Auth: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
A bad, expired or revoked token returns **401** `{"message": "Bad credentials"}` on every endpoint.

## List repository issues
`GET /repos/{owner}/{repo}/issues?state=all&per_page=100`
- `per_page` max is **100**; larger values are silently capped at 100.
- Pagination via the `Link` response header (`rel="next"`). Pull requests are included; filter on `pull_request`.

## Search issues
`GET /search/issues?q=...&per_page=100&page=N`
- Returns `{"total_count", "incomplete_results", "items": [...]}`.
- **Only the first 1,000 results are available** for any query. Requesting beyond that (e.g. page 11
  at per_page=100) returns **422** `{"message": "Only the first 1000 search results are available"}`.
  To read more, split the query into smaller ranges (e.g. by `closed:` date windows) so each window
  has `total_count <= 1000`, and treat `total_count > 1000` in a window as truncation (fail closed).
- Rate limit: 30 requests/minute authenticated (separate from the core 5,000/hour).

## Raw files
`https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` serves file contents (CSV fixtures).
Upstream owners may change columns between versions; check the header.
