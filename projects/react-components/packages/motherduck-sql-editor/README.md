# motherduck-sql-editor

Interactive in-browser SQL editor backed by [`@motherduck/wasm-client`](https://www.npmjs.com/package/@motherduck/wasm-client). Renders a code editor with syntax highlighting, runs queries against MotherDuck from the user's browser, and displays results in a sortable table.

Authentication is delegated to [`@auth0/auth0-react`](https://www.npmjs.com/package/@auth0/auth0-react). You wrap your app in `Auth0Provider`, plumb the context to this component once, and the editor handles the rest (login redirect, ID-token bridging, exchanging for a MotherDuck token).

## Install

Not published to npm. Vendor the source into your app:

```sh
# from your app root
mkdir -p src/vendor/motherduck-sql-editor
curl -L https://github.com/motherduckdb/labs/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=6 -C src/vendor/motherduck-sql-editor \
    labs-main/projects/react-components/packages/motherduck-sql-editor/src
```

Then `import { MotherDuckSQLEditor } from './vendor/motherduck-sql-editor';` and let your bundler handle `.tsx` + `.module.css`.

Peer deps your app must provide:

```
react@>=18 <20
react-dom@>=18 <20
@auth0/auth0-react@^2
@auth0/auth0-spa-js@^2
@motherduck/wasm-client@^0.8
@tanstack/react-table@^8
react-syntax-highlighter@^15
sql-formatter@^15
```

## Usage

```tsx
// app.tsx
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { useEffect } from 'react';
import {
  MotherDuckSQLEditor,
  configureAuth,
  setAuth0ReactContext,
} from '@motherduck-labs/motherduck-sql-editor';

// 1. Tell the editor where to exchange Auth0 tokens for MotherDuck tokens.
configureAuth({
  mdTokenLookupUrl: 'https://your-token-exchange.example.com/lookup-user',
  // Optional: share the ID-token bridge cookie across subdomains.
  // cookieDomain: '.example.com',
});

function AuthBridge({ children }: { children: React.ReactNode }) {
  const auth0 = useAuth0();
  useEffect(() => {
    setAuth0ReactContext(auth0);
  }, [auth0]);
  return <>{children}</>;
}

export default function App() {
  return (
    <Auth0Provider
      domain='auth.example.com'
      clientId='your-client-id'
      authorizationParams={{ redirect_uri: window.location.origin }}
    >
      <AuthBridge>
        <MotherDuckSQLEditor
          database='my_database'
          query='SELECT 1 AS hello;'
        />
      </AuthBridge>
    </Auth0Provider>
  );
}
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `database` | `string` | — | Required. Database the editor scopes queries to. |
| `query` | `string` | `'SELECT 1 AS hello;'` | Initial SQL shown in the editor. |
| `formatOnLoad` | `boolean` | `true` | Run `sql-formatter` on the initial query. |
| `colorMode` | `'light' \| 'dark'` | follows `prefers-color-scheme` | Syntax-highlighter theme. |
| `provisioning` | `{ mode: 'create-empty' } \| { mode: 'attach-share'; shareUrls: string[] }` | — | Optional pre-flight: create the database if missing, or attach a shared one. |

### `provisioning` examples

```tsx
// Auto-create an empty database if the user doesn't have one yet
<MotherDuckSQLEditor database='my_playground' provisioning={{ mode: 'create-empty' }} />

// Attach a shared sample database (try each region's URL until one works)
<MotherDuckSQLEditor
  database='sample_data'
  provisioning={{
    mode: 'attach-share',
    shareUrls: [
      'md:_share/sample_data/23b0d623-1361-421d-ae77-62d701d471e6',
      'md:_share/sample_data/6b2babf0-bd16-465e-9243-f137a2e5b763',
    ],
  }}
/>
```

## Security model

`validation.ts` blocks queries that would escape the configured `database` — `USE`, `ATTACH`, `DETACH`, cross-database references, and destructive ops on other databases. Strip or relax this in `validation.ts` for trusted contexts.

The Auth0 ID token is bridged across page loads via a cookie (base64-encoded, `samesite=strict`, `secure` over HTTPS). The MotherDuck token itself is **never stored** — it lives in component state for the session only.

## What was changed during the port

Ported from `src/components/MotherDuckSQLEditor/` in the MotherDuck docs site. Changes:

- **Removed Docusaurus deps**: `ExecutionEnvironment`, `useColorMode`, `useBaseUrl`, `@site/*` SVG imports. Replaced with vanilla equivalents (`typeof window !== 'undefined'`, a `prefers-color-scheme` hook, inline SVGs).
- **Removed `Docusaurus` CSS variables**: all `var(--ifm-*)` and `var(--md-color-*)` replaced with concrete hex colors. Restyle via component-level CSS overrides if you need theming.
- **Slimmed `auth.ts`**: dropped the legacy `@auth0/auth0-spa-js` direct-client path. Only the React-context-bridge path remains. Configuration (`mdTokenLookupUrl`, cookie domain) now injected via `configureAuth()` instead of read from `siteConfig.customFields`.
- **Made provisioning configurable**: the original hardcoded `docs_playground` / `sample_data` provisioning is now opt-in via the `provisioning` prop.
- **Inlined `SortableTable`** and replaced the `Button` component with plain `<button>` elements.

## Status

Labs. The original is battle-tested inside the docs site; this fork has had targeted surgery to remove host-app coupling but has not been re-validated end-to-end against MotherDuck. Treat as a starting point.
