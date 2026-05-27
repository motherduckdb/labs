# react-components

Open-source React components extracted from the MotherDuck website and docs site.

Each package is independent — pick whichever you want, copy the source, or install from this repo. No shared build pipeline; each package ships TypeScript source and a `tsconfig.json` so consumers' bundlers handle transpilation.

## Packages

| Package | What it is |
|---|---|
| [`dive-embed-public`](./packages/dive-embed-public/) | Embed a **public** MotherDuck Dive snippet via iframe. No backend needed — pass a snippet ID. |
| [`dive-embed-private`](./packages/dive-embed-private/) | Embed a **private** Dive that requires an authenticated session. Calls a session endpoint your app provides. |
| [`motherduck-sql-editor`](./packages/motherduck-sql-editor/) | Interactive in-browser SQL editor backed by `@motherduck/wasm-client`. Runs queries against MotherDuck from the user's browser. Requires Auth0 for token brokerage. |

## Origins

- `dive-embed-public` ports `packages/mkt/components/common/dive-embed.tsx` from the MotherDuck website.
- `dive-embed-private` ports `src/components/EmbeddedDive/` from the MotherDuck docs site.
- `motherduck-sql-editor` ports `src/components/MotherDuckSQLEditor/` from the MotherDuck docs site.

## Status

Labs. APIs may shift. Issues and PRs welcome.

## License

MIT — see the [repo LICENSE](../../LICENSE).
