# Dive examples

Reference MotherDuck Dives used by `lib/gemini-dive-guide.ts` as worked
visual examples in the `get_dive_guide` response. They're real, shipped
dives from the public gallery — picked for showing the visual target
the model should aim for (typography hierarchy, design tokens, skeleton
patterns, recharts styling, fully wired `useSQLQuery` calls, etc.).

Stored as JSON (not `.tsx`) so the dive source survives any build
pipeline as inert data — no compilation, no JSX parsing, no template-
literal collisions with the `lib/gemini-dive-guide.ts` template string
that embeds them.

## Files

- `galactic-coffee.json` — Galactic Coffee Theme Gallery: 14 visual
  themes (Tufte, FT, Du Bois, neon, vaporwave…) rendered against the
  same dataset. Good reference for design tokens / theme-object style
  and for chart variants.
- `visual-history.json` — A Visual History of Data Visualization
  (Dumky de Wilde): multi-tab slideshow with d3 + recharts. Good
  reference for narrative-style layouts, tab nav, and slideshow shape.

Each file shape:

```json
{
  "title": "...",
  "sourceUrl": "https://motherduck.com/dive-gallery/dives/...",
  "source": "// full dive source as a single string"
}
```

## Adding a new example

1. From the gallery URL, fetch the `embed` page (e.g. `/dive-gallery/embed/<slug>`).
2. Parse the `__NEXT_DATA__` JSON; the dive source is at
   `props.pageProps.snippet.diveContent`.
3. Save as `<slug>.json` here with the three fields above.
4. Import + append in `lib/gemini-dive-guide.ts`.

Keep the catalog small — each example is ~50-100 KB of tokens in every
`get_dive_guide` response.
