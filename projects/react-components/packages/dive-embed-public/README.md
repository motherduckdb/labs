# dive-embed-public

Embed a **public** [MotherDuck Dive](https://motherduck.com/dive-gallery) snippet in a React app via iframe. No backend, no auth — pass a snippet ID and you're done.

For private dives that require an authenticated session, see [`dive-embed-private`](../dive-embed-private/).

## Install

Not published to npm. The package ships TypeScript source; the recommended path is to vendor it into your app:

```sh
# from your app root
mkdir -p src/vendor/dive-embed-public
curl -L https://github.com/motherduckdb/labs/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=6 -C src/vendor/dive-embed-public \
    labs-main/projects/react-components/packages/dive-embed-public/src
```

Then `import { DiveEmbedPublic } from './vendor/dive-embed-public';` and let your bundler handle `.tsx` + `.module.css`.

Peer deps your app must provide: `react >= 18 <20`, `react-dom >= 18 <20`.

## Usage

```tsx
import { DiveEmbedPublic } from '@motherduck-labs/dive-embed-public';

export default function Page() {
  return (
    <DiveEmbedPublic
      snippetId='galactic-coffee-theme-gallery'
      title='Galactic Coffee'
      height={720}
    />
  );
}
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `snippetId` | `string` | — | Required. Snippet ID from the dive gallery. |
| `height` | `number` | `600` | Iframe height in pixels. |
| `title` | `string` | — | Optional. Shown in header and links to the snippet's gallery page. |
| `baseUrl` | `string` | `https://motherduck.com/dive-gallery` | Override for staging or self-hosted gallery. |
| `skeletonDelayMs` | `number` | `2000` | How long to show the skeleton loader before revealing the iframe. |

## Origin

Ported from `packages/mkt/components/common/dive-embed.tsx` in the MotherDuck website. Replaced `styled-components` + `@motherduck/ui` with a single CSS module so the component is dependency-free.
