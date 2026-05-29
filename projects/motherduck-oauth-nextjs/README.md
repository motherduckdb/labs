# motherduck-oauth-nextjs

A minimal **BI-style app** on top of MotherDuck: sign in with your MotherDuck
account, browse the Dives you can access, and view any of them rendered
inline — a tiny "classic BI tool" loop.

Built on Next.js 16 (App Router). The OAuth flow and the in-browser Dive
renderer are both ported from MotherDuck's internal `mdw-turbo` app.

## What it does

```
/login → MotherDuck OAuth (PKCE) → callback sets httpOnly cookie → /
  /                GET /api/dives          → list_dives (MCP, your token) → grid of Dives
  click a Dive     → /dives/[id]
  /dives/[id]      iframe → GET /api/dives/view?id=…
                   → view_dive + get_short_lived_token (MCP, your token)
                   → HTML page renders the dive via @motherduck/wasm-client
```

## Why the WASM renderer (and not the iframe embed)

MotherDuck's hosted Dive embed (`embed-motherduck.com` + `/v1/dives/{id}/embed-session`)
is **service-account-only** — a normal signed-in user can't mint an embed
session for their *own* Dives (the API returns `FORBIDDEN: Dive embed sessions
can only be created for service accounts`). To honor the "browse **your** Dives"
premise, this app renders dives the way `mdw-turbo` does: fetch the dive source
+ a short-lived token over MCP, then run the dive's queries in the browser with
`@motherduck/wasm-client`. Both MCP calls work with the user's OAuth token.

The client is pinned to the latest published version (`1.5.2-r.3`). DuckDB-Wasm
under it falls back to a single-threaded, non-`SharedArrayBuffer` bundle when
the page isn't cross-origin-isolated, so this runs **without any COOP/COEP
headers**.

## Architecture

| Piece | File(s) | Notes |
|---|---|---|
| **OAuth 2.1 + PKCE** | `lib/motherduck-oauth.ts` | Discovery, dynamic client registration, code exchange, refresh. Tokens in httpOnly cookies. CSRF `state` + timing-safe compare. |
| **OAuth routes** | `app/api/auth/motherduck/{route,callback,logout}` | Start / callback / logout. |
| **Login screen** | `app/login/page.tsx` | A "Continue" button → the start route. |
| **MCP client** | `lib/mcp-client.ts` | Authenticated MCP client + `executeTool` over Streamable HTTP. |
| **List Dives** | `lib/dives.ts`, `app/api/dives/route.ts`, `app/page.tsx` | `list_dives` → home grid. |
| **View a Dive** | `app/dives/[id]/page.tsx` | Iframes the same-origin viewer route below. |
| **WASM viewer** | `app/api/dives/view/route.ts`, `lib/dive-viewer.ts` | `view_dive` + `get_short_lived_token` → standalone HTML that renders the dive in-browser via `@motherduck/wasm-client`. |

## Run it

```sh
cd projects/motherduck-oauth-nextjs
npm install
cp .env.example .env.local   # defaults target production MotherDuck
npm run dev                  # http://localhost:3000
```

Visit `http://localhost:3000` → you'll be redirected to `/login` → **Continue**
→ authorize on MotherDuck → land back on the Dive grid → click one to view it.

Run the unit tests (no network — the MCP SDK and `next/headers` are mocked):

```sh
npm run test
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MOTHERDUCK_API_URL` | `https://api.motherduck.com` | API + MCP base. Set to the staging host to use staging. |
| `NEXTAUTH_URL` | `http://localhost:3000` | This app's public origin; builds the OAuth callback URL. |

## Security notes

- Tokens live in **httpOnly, SameSite=Lax** cookies (`secure` in production).
- The OAuth flow uses **PKCE** and a cookie-bound **`state`** verified with a
  timing-safe comparison before any code exchange.
- The dive viewer compiles dive source **in the browser** (Babel standalone),
  never server-side — `lib/dive-viewer.ts` only parses a dive's
  `REQUIRED_DATABASES` declaration with a restricted, non-evaluating literal
  parser, so hostile dive source can't execute Node code while the HTML is
  built. The short-lived token is sanitized to the JWT charset before it's
  inlined, and the viewer iframe is `sandbox`ed.

## Status

Labs / experimental. Ported from `mdw-turbo`; APIs may shift.
