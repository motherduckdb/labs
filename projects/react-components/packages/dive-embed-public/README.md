# dive-embed-public

Embed a **public** [MotherDuck Dive](https://motherduck.com/dive-gallery) snippet in a React app via iframe. No backend, no auth — pass a snippet ID and you're done.

For private dives that require an authenticated session, see [`dive-embed-private`](../dive-embed-private/).

## Install

This package ships TypeScript source. Easiest paths:

- Copy `src/` into your project.
- Or add via git: `npm install github:motherduckdb/labs#main --workspace=projects/react-components/packages/dive-embed-public` (your bundler handles `.tsx`).

Peer deps: `react >= 18`.

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
