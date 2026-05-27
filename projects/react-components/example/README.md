# react-components example

Local playground for the three packages in `../packages/`. Used to verify each component renders correctly end-to-end.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173.

## What works without configuration

- **§1 `dive-embed-public`** — fully functional. Loads a real public Dive snippet from `motherduck.com/dive-gallery`.
- **§2 `dive-embed-private`** — UI is functional; the session endpoint is mocked by a Vite middleware (`vite.config.ts`) that returns a fake session. The iframe will fail to load a real Dive with this fake session, but you can verify the loading skeleton, expand modal, and Escape-to-close.

## What needs configuration

- **§3 `motherduck-sql-editor`** — disabled by default. Requires Auth0 + a MotherDuck account. **Cannot be tested against a brand-new dev Auth0 tenant** — the `mdTokenLookupUrl` endpoint verifies the JWT issuer, so the Auth0 ID token must be issued by MotherDuck's own tenant (`auth.motherduck.com`).

To enable:

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_ENABLE_SQL_EDITOR=true`.
3. **Whitelist required:** the MotherDuck Auth0 SPA client (`E4kUPVD7jbaRsp9bzTEemf38maqrpRma`) needs `http://localhost:5173` added as an allowed callback URL. Without this, the post-sign-in redirect fails. Ask someone with admin on the MD Auth0 tenant.
4. `npm run dev` and click "Run with MotherDuck" — you sign in with your existing `motherduck.com` credentials.

## Notes for consumers

This example imports each component via relative paths into the workspace (`../packages/<pkg>/src`), which is fine in-repo. For real consumers, follow the vendor instructions in each package's README — typically a `curl | tar` into your app's `src/vendor/`.
