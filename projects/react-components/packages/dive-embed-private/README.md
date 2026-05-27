# dive-embed-private

Embed a **private** MotherDuck Dive in a React app via an authenticated session your backend mints.

For public snippets (no auth), see [`dive-embed-public`](../dive-embed-public/).

## How it works

1. Your backend exposes a session endpoint (e.g. `POST /api/dive-embed-session`) that authenticates the user, calls MotherDuck's dive-session API for the given `diveId`, and returns `{ session: string }`.
2. The component `POST`s `{ diveId }` to that endpoint and renders an iframe pointing at `https://embed-motherduck.com/sandbox/#session=<session>`.

Lazy-loads via `IntersectionObserver` by default; click **Expand** for a modal full-view.

## Install

Not published to npm. Vendor the source into your app:

```sh
# from your app root
mkdir -p src/vendor/dive-embed-private
curl -L https://github.com/motherduckdb/labs/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=6 -C src/vendor/dive-embed-private \
    labs-main/projects/react-components/packages/dive-embed-private/src
```

Then `import { DiveEmbedPrivate } from './vendor/dive-embed-private';` and let your bundler handle `.tsx` + `.module.css`.

Peer deps your app must provide: `react >= 18 <20`, `react-dom >= 18 <20`.

## Usage

```tsx
import { DiveEmbedPrivate } from './vendor/dive-embed-private';

export default function Page() {
  return (
    <DiveEmbedPrivate
      diveId='abc123'
      title='Q4 Revenue'
      sessionEndpoint='/api/dive-embed-session'
      height='720px'
      fallbackUrl='https://app.motherduck.com/dives/abc123'
    />
  );
}
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `diveId` | `string` | — | Required. ID of the dive to embed. |
| `sessionEndpoint` | `string` | — | Required. URL your backend exposes to mint a session. |
| `title` | `string` | `'Embedded Dive'` | Shown in the header. |
| `height` | `string` | `'720px'` | CSS height. |
| `chrome` | `boolean` | `true` | Render the bordered header + expand button. |
| `lazy` | `boolean` | `true` | Defer loading until in-view. |
| `embedHost` | `string` | `https://embed-motherduck.com` | Override for staging. |
| `fallbackUrl` | `string` | — | Shown in error message as a fallback link. |

## Session endpoint contract

```http
POST /your-endpoint
Content-Type: application/json

{ "diveId": "abc123" }
```

Response:

```json
{ "session": "<opaque session string from MotherDuck>" }
```

The component does **not** ship a server implementation. Reference: `packages/mkt/pages/api/dive-embed-session.ts` in the website repo.

## Origin

Ported from `src/components/EmbeddedDive/` in the MotherDuck docs site. Removed Docusaurus dependencies (`BrowserOnly`, `useBaseUrl`) — the component now self-hydrates via `useEffect`, and `sessionEndpoint` is a plain URL.
