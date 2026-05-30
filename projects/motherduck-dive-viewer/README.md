# motherduck-dive-viewer

A minimal **BI-style app** on top of MotherDuck: sign in with your MotherDuck
account, browse the Dives you can access, and view any of them rendered inline —
a tiny "classic BI tool" loop.

Built on Next.js 16 (App Router). **No MotherDuck token ever reaches the
browser** — Dives render in a sandboxed iframe whose queries run through a
server-side proxy.

> ## ⚠️ This is a *generic* sample with intentional tradeoffs — not a production blueprint
>
> To stay **generic** (any MotherDuck user, any org, signs in and sees their own
> Dives) and **easy to run**, this app deliberately trades away fidelity and some
> strictness. Don't copy these choices verbatim into production:
>
> - **Reimplemented renderer.** Dives render against our own port of the dive SDK
>   + Tailwind, not MotherDuck's hosted renderer — so theming/components won't
>   match exactly, and libraries are loaded ad-hoc (we patch them in as Dives
>   need them). It's whack-a-mole by nature.
> - **Looser CSP for fidelity.** The Dive iframe allows web fonts / remote styles
>   / images (`https:`) so Dives look right. A shared Dive could therefore leak
>   read-only query results through an image/font URL — accepted here.
> - **Capability + read-scaling token** instead of a managed session.
>
> **For production, prefer the single-org path:** MotherDuck's hosted embed
> (`embed-motherduck.com` + a service-account embed session) gives you the real
> renderer, perfect fidelity, and the token + execution fully managed by
> MotherDuck — no proxy, no reimplemented runtime. See *If you're deploying for a
> single organization* below. This sample exists to demonstrate the generic
> OAuth + query-proxy pattern, not to be a hardened production deployment.

## What it does

```
/login → MotherDuck OAuth (PKCE) → callback sets httpOnly cookie → /
  /              actual SQL (MD_LIST_DIVES via the pg endpoint) → sortable/searchable grid
  My / All       toggle between your own dives and org-shared dives
  click a Dive   → /dives/[id]
                 → /api/dives/view (sandboxed renderer + short-lived capability)
                 → Dive's useSQLQuery → POST /api/dives/query (server runs the SQL)
  trash icon     → MD_DELETE_DIVE (My dives only, with confirm)
```

## Architecture

- **Auth** — OAuth 2.1 + PKCE (production default). Tokens in httpOnly cookies;
  CSRF `state` + timing-safe compare; auto-refresh via a cookie-writable route
  (`lib/require-auth.ts` + `app/api/auth/motherduck/refresh`).
- **Data (list/sort/search/delete)** — actual SQL (`MD_LIST_DIVES()`,
  `MD_DELETE_DIVE()`) run **server-side** over MotherDuck's Postgres endpoint
  with the pure-JS `pg` client (`lib/motherduck-sql.ts`). The user's token is
  minted and used server-side only.
- **Dive viewing — server-side query proxy.** The Dive renders against a
  faithful port of `@motherduck/react-sql-query` (real `useSQLQuery`,
  `useConnection`, `useDiveState`, `useExport`, `MotherDuckSDKProvider`) in a
  **sandboxed, opaque-origin** iframe (`/api/dives/view`). Its one swapped seam:
  the SDK's connection POSTs each query to `/api/dives/query` instead of using
  an in-browser WASM connection. The proxy runs each query server-side on a
  per-user **read-scaling (read-only)** token — so writes are rejected by the
  engine, not just a SQL check — and returns rows as JSON. The MotherDuck token
  is only ever used server-side, so the Dive never touches a token, our app's
  cookies, or other APIs.
  - The sandboxed iframe (no `allow-same-origin`) can't send our session
    cookie, so it authenticates to the proxy with a short-lived **AES-256-GCM
    capability** minted by the view route (`lib/dive-query-capability.ts`,
    key derived from `DIVE_QUERY_SECRET`).

| Piece | File(s) |
|---|---|
| OAuth 2.1 + PKCE | `lib/motherduck-oauth.ts`, `app/api/auth/motherduck/*`, `app/login/page.tsx` |
| Page-load token refresh | `app/api/auth/motherduck/refresh/route.ts`, `lib/require-auth.ts` |
| List / sort / search / delete | `lib/dives.ts`, `lib/motherduck-sql.ts`, `app/api/dives/{route,delete}`, `app/page.tsx`, `app/dive-controls.tsx`, `app/delete-dive-button.tsx` |
| Dive viewer (renderer) | `lib/dive-viewer.ts`, `app/dives/[id]/page.tsx`, `app/dives/[id]/dive-frame.tsx` |
| Query proxy + capability | `app/api/dives/view/route.ts`, `app/api/dives/query/route.ts`, `lib/dive-query-capability.ts` |

## This sample is generic by design — which forces the architecture

This app is built to be **generic / multi-tenant**: *any* MotherDuck user, from
*any* organization, signs in with their own account and sees their own Dives.
That single requirement is what drives the query-proxy + capability design,
because MotherDuck's normal embedding path can't do it:

- **MotherDuck's documented embed flow** (`POST /v1/dives/{id}/embed-session` →
  opaque session → iframe at `https://embed-motherduck.com`) **requires a
  service-account (Admin) token**, and a service account belongs to **one
  organization**. There's no delegated/per-user embed-session, and you can't
  provision a service account from a signed-in user's session.
- So a generic app **can't** use it: there's no single service account that
  spans every signed-in user's org. Instead we keep each user's own token
  **server-side**, run their Dive's SQL through a read-only proxy, and render
  with our own (faithful) port of the dive SDK. Trade-off: we maintain that
  renderer rather than using MotherDuck's hosted one.

### If you're deploying for a *single* organization, don't copy this — use the embed flow

For a single-org deployment the simpler, more robust choice is MotherDuck's
**documented embed flow** ([Embedding Dives](https://motherduck.com/docs/key-tasks/ai-and-motherduck/dives/embedding-dives/)):

1. Create a **service account (Admin)** in your org and give your backend its token.
2. Server-side, call `POST /v1/dives/{id}/embed-session` (passing `username =`
   the signed-in user so data scopes to them) to get an opaque `session`.
3. Render it in an iframe pointed at **MotherDuck's own domain**,
   `https://embed-motherduck.com/sandbox/#session=<session>` — i.e. the renderer
   runs on a **different origin that MotherDuck hosts**, not yours.

That gets you **MotherDuck's exact renderer** and **cross-origin isolation for
free** (the token never leaves your backend; the Dive runs on MotherDuck's
domain), with none of this repo's proxy/capability machinery. You only need the
machinery here if you require the generic, across-org behavior.

## Run it

```sh
cd projects/motherduck-dive-viewer
npm install
cp .env.example .env.local
# then edit .env.local and set DIVE_QUERY_SECRET to a random value:
#   openssl rand -base64 32
npm run dev                         # http://localhost:3000
```

Sign in → browse the Dive grid → click a Dive to view it. The Dive list works
without extra config; **viewing** a Dive needs `DIVE_QUERY_SECRET`.

Unit tests (no network — MCP SDK + `next/headers` mocked, capability crypto):

```sh
npm run test
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MOTHERDUCK_API_URL` | `https://api.motherduck.com` | API / MCP / pg base. Set to staging to use staging. |
| `NEXTAUTH_URL` | `http://localhost:3000` | This app's public origin; builds the OAuth callback URL. |
| `DIVE_QUERY_SECRET` | — | Random secret (e.g. `openssl rand -base64 32`) used to sign/encrypt the short-lived Dive-query capability. **Not** a MotherDuck credential; must be stable across instances. Required to view Dives. |

## Security notes

- Tokens live in **httpOnly, SameSite=Lax** cookies (`secure` in production);
  OAuth uses **PKCE** + a cookie-bound `state` verified with a timing-safe compare.
- **No MotherDuck token in the browser** — list/delete run server-side over the
  pg endpoint; Dive queries run server-side via the proxy.
- The Dive iframe is sandboxed to an **opaque origin** (no `allow-same-origin`),
  so it can't reach the app's cookies/DOM/APIs. Its CSP locks **`connect-src`**
  to the app origin (the proxy) + esm.sh — the hard data boundary — but
  intentionally allows `https:` styles/fonts/images for render fidelity (see the
  tradeoffs callout above).
- The query proxy runs on a **read-scaling (read-only) token** minted per-user
  (`POST /v1/users/{username}/tokens`), so writes are rejected by the engine —
  not just by the SQL allowlist. It's also bound to the dive via the capability;
  a leaked capability grants at most brief read-only proxy access.

## Known limitations

- **Read-replica lag.** Read-scaling tokens route to read-only replicas, which
  can briefly lag writes — a Dive querying a *just-created/just-modified* table
  may transiently not see it. Fine for established Dives; relevant if you expect
  to view data seconds after writing it.
- **Render fidelity.** The viewer runs a port of the dive SDK + Tailwind, not
  MotherDuck's hosted renderer. Theming/components won't match exactly, and
  libraries are loaded ad-hoc (react/recharts/lucide/d3 today, more patched in
  as Dives need them). For pixel-perfect fidelity, use the single-org hosted
  embed.
- A shared Dive's code can still exfiltrate **read-only** query results it's
  allowed to read — now including via image/font URLs, since the CSP allows
  `https:` for those (the fidelity tradeoff). `connect-src` is still locked, and
  no MotherDuck token is in the page.

## Status

Labs / experimental. APIs may shift.
