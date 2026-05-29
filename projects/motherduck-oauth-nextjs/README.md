# motherduck-oauth-nextjs

A minimal **BI-style app** on top of MotherDuck: sign in with your MotherDuck
account, browse the Dives you can access, and view any of them embedded inline —
a tiny "classic BI tool" loop.

Built on Next.js 16 (App Router). Dive viewing uses MotherDuck's **documented
embed flow** so a MotherDuck token never reaches the browser.

## What it does

```
/login → MotherDuck OAuth (PKCE) → callback sets httpOnly cookie → /
  /              actual SQL (MD_LIST_DIVES via the pg endpoint) → sortable/searchable grid
  My / All       toggle between your own dives and org-shared dives
  click a Dive   → /dives/[id]
                 → server mints a MotherDuck embed session (service-account token,
                   run as the signed-in user) → iframe to embed-motherduck.com
  trash icon     → MD_DELETE_DIVE (My dives only, with confirm)
```

## Architecture

- **Auth** — OAuth 2.1 + PKCE (production default). Tokens in httpOnly cookies;
  CSRF `state` + timing-safe compare; auto-refresh via a cookie-writable route.
- **Data (list/sort/search/delete)** — actual SQL (`MD_LIST_DIVES()`,
  `MD_DELETE_DIVE()`) run **server-side** over MotherDuck's Postgres endpoint
  with the pure-JS `pg` client (`lib/motherduck-sql.ts`). The user's token is
  minted and used server-side only.
- **Dive viewing** — the **documented embed flow**
  ([Embedding Dives](https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/embedding-dives/)):
  the server calls `POST /v1/dives/{id}/embed-session` with a service-account
  token + `username = <signed-in user>`, and the browser loads only the opaque
  `session` in an `embed-motherduck.com` iframe. **The browser never receives a
  MotherDuck token**, and the Dive runs in MotherDuck's own sandboxed origin —
  not in our app's realm.

| Piece | File(s) |
|---|---|
| OAuth 2.1 + PKCE | `lib/motherduck-oauth.ts`, `app/api/auth/motherduck/*`, `app/login/page.tsx` |
| Page-load token refresh | `app/api/auth/motherduck/refresh/route.ts`, `lib/require-auth.ts` |
| List / sort / search / delete | `lib/dives.ts`, `lib/motherduck-sql.ts`, `app/api/dives/{route,delete}`, `app/page.tsx`, `app/dive-controls.tsx`, `app/delete-dive-button.tsx` |
| Embed a Dive | `lib/dive-embed.ts`, `app/dives/[id]/page.tsx`, `app/dives/[id]/dive-frame.tsx` |

## Why embed sessions (not in-browser execution)

The Dive runs inside `embed-motherduck.com`'s sandboxed iframe using an opaque,
short-lived, read-only `session` — the real token stays on the backend. Earlier
iterations rendered Dives in-browser via `@motherduck/wasm-client`, which
required handing a user-scoped token to arbitrary Dive code in the page; the
embed flow removes that entirely.

**Single-org by design.** `POST /v1/dives/{id}/embed-session` requires a
**service-account (Admin) token** (the endpoint rejects delegated user tokens),
and that account lives in one organization. So this app embeds Dives for users
**within one MotherDuck org**: one admin service account, with `username` set to
the signed-in user so each person sees their own data. A cross-org "any
MotherDuck account" embed isn't possible — that's a platform constraint of embed
sessions, not this app.

## Run it

```sh
cd projects/motherduck-oauth-nextjs
npm install
cp .env.example .env.local          # set MOTHERDUCK_EMBED_TOKEN (see below)
npm run dev                         # http://localhost:3000
```

Sign in → browse the Dive grid → click a Dive to view it embedded. The Dive
list works without any extra config; **opening** a Dive needs
`MOTHERDUCK_EMBED_TOKEN` (otherwise the detail page shows a "not configured"
notice).

Unit tests (no network — MCP SDK + `next/headers` mocked):

```sh
npm run test
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MOTHERDUCK_API_URL` | `https://api.motherduck.com` | API / MCP / pg / embed base. Set to staging to use staging. |
| `NEXTAUTH_URL` | `http://localhost:3000` | This app's public origin; builds the OAuth callback URL. |
| `MOTHERDUCK_EMBED_TOKEN` | — | **Service-account (Admin) token**, server-side only, used to mint Dive embed sessions. Required to view Dives. |
| `DIVE_EMBED_HOST` | `https://embed-motherduck.com` | Override the embed sandbox host (e.g. for staging). |

## Security notes

- Tokens live in **httpOnly, SameSite=Lax** cookies (`secure` in production);
  OAuth uses **PKCE** + a cookie-bound `state` verified with a timing-safe compare.
- **No MotherDuck token in the browser** — list/delete run server-side over the
  pg endpoint; Dive viewing uses an opaque embed session rendered on
  MotherDuck's origin.
- The `MOTHERDUCK_EMBED_TOKEN` service-account token is **server-side only**. The
  app only embeds dive IDs that came from the user's own `MD_LIST_DIVES`, so the
  admin token can't be used to widen what a user sees.

## Status

Labs / experimental. APIs may shift.
