# Retheme mviz with first-class theming

## Context

We just built a design system (`docs/design-system.md` + Paper board) derived from
the MotherDuck app: white ground, hairline borders, Inter + JetBrains Mono, and a
data-viz palette (quant lavender `#9F7AEA`, temporal teal `#0D9488`, categorical
blue `#60A5FA`). Charts in the chat are rendered by **mviz 1.7.0** via
`lib/mviz-processor.ts` → `parseMarkdownToDashboard(...)` → an iframe (`MvizFrame`).

Today the mviz output is *forced* to roughly match the design system by a large
`!important` CSS block (`CUSTOM_CSS_OVERRIDES`, `lib/mviz-processor.ts:9-96`)
injected into the generated HTML. This is brittle: it overrides mviz's internal
CSS vars, and crucially flattens **every** chart series to one color via
`svg .bar { fill:#C4B5FD !important }` / `svg .line { stroke:#0D9488 !important }`
— so a 2-series bar chart renders both series the same color.

mviz 1.7.0 ships **first-class theming**, and the integration point is already in
our call — we just pass `undefined` for it. Goal: drive the theme through mviz's
native `customTheme` and shrink the CSS hack to only what theming can't express.

## Key findings (verified in `node_modules/mviz/dist`)

- Signature: `parseMarkdownToDashboard(markdown, baseTheme='light', baseDir, strict, testMode, customTheme?: CustomTheme, lintMode, embedOverride)`. **Arg 6 = `customTheme`**, currently `undefined` (`lib/mviz-processor.ts:280-289`).
- `customTheme` propagates to **both**: page CSS vars (`generateDashboardCss` → `--bg`, `--fg`, `--text`, `--text-muted`, `--red`=accent, `--font-family`, `--font-mono`) **and** charts (`renderOpts.customTheme` → `getPaletteWithCustom` / `getThemeColorsWithCustom` / `getFontsWithCustom`). One object themes chrome + series.
- `CustomTheme = { name?, extends?: 'light'|'dark', colors?: Partial<ThemeColors>, palette?: string[], fonts?: {family?, mono?, import?} }`. `ThemeColors` keys: primary, secondary, tertiary, positive, warning, error, accent, background, paper, text, textSecondary, border.
- **Gotcha:** `getThemeColorsWithCustom(theme, custom)` applies `colors` only when `theme === (custom.extends ?? 'light')`. We already pass `baseTheme='light'`, so set `extends: 'light'`.
- `palette[]` natively cycles per series — strictly better than the forced single-fill SVG rule.
- Only one call site (`lib/agentic-loop.ts:182`). **No test asserts on injected CSS/colors** (`mviz-fence.test.ts`, `demo-mode.test.ts`, `demo-validation.test.ts` are clean) — low blast radius.

## Approach

### 1. New file `lib/mviz-theme.ts` — single source of truth

Export a `MVIZ_CUSTOM_THEME` object (typed structurally; no need to import the
`CustomTheme` type, which isn't re-exported from the package root). Values mirror
`docs/design-system.md`:

```ts
export const MVIZ_CUSTOM_THEME = {
  name: 'data-chat',
  extends: 'light' as const,
  colors: {
    background: '#FFFFFF', paper: '#FFFFFF',
    text: '#1C1E26', textSecondary: '#6B7280', border: '#ECEDEF',
    accent: '#2563EB',                         // alert/blockquote left-border, links
    positive: '#0E9F6E', warning: '#F59E0B', error: '#DC2626',
  },
  // series colors: design-system data-viz strokes first, then in-scene extensions
  palette: ['#9F7AEA', '#0D9488', '#60A5FA', '#F59E0B', '#9CA3AF', '#1D4ED8'],
  fonts: {
    family: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', 'Roboto Mono', ui-monospace, monospace",
    import: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
};
```

(`fonts.import` is an upgrade over today — the sandboxed iframe currently asks for
Inter but never loads it, so it falls back to system-ui. The import makes Inter +
JetBrains Mono actually render inside the frame.)

### 2. `lib/mviz-processor.ts` — pass the theme, trim the hack

- Import `MVIZ_CUSTOM_THEME`; pass it as **arg 6** to `parseMarkdownToDashboard` (replace the `undefined` at `:285`). Keep `embedOverride=true`.
- **Remove** from `CUSTOM_CSS_OVERRIDES` (now handled natively): the `:root` color-var block (`:12-26`), the `font-family` `!important` block (`:45-49`), and the SVG color rules `svg text`, `svg .bar`, `svg .line` (`:92-94`). Also drop the now-redundant `color`/`background` color decls where they duplicate theme values.
- **Keep** (theming has no knob for these): font *sizes* (`section-title` / `chart-title` / `big-value` / `label` / `delta` / table `th`/`td` / markdown headings), `border-radius:10px` on cards & `.data-table`, layout hugging (`body{margin:0}`, `.dashboard` padding, last-child margins, `.row` gap), and the `HEIGHT_REPORTER_SCRIPT` (unrelated).
- Net result: `CUSTOM_CSS_OVERRIDES` becomes a small "sizing/radius/spacing" layer; all color + font-family + series come from `MVIZ_CUSTOM_THEME`.

No change needed in `agentic-loop.ts`, `MvizFrame.tsx`, or `globals.css` (the
`.mviz-shell` host card already matches; this task is independent of the not-yet-
applied `globals.css` migration).

## Files

- **Add** `lib/mviz-theme.ts` (the theme object).
- **Edit** `lib/mviz-processor.ts` (pass arg 6; shrink `CUSTOM_CSS_OVERRIDES`).
- **Add/extend** a unit test (see below), e.g. `lib/mviz-theme.test.ts`.

## Verification

1. `npm run typecheck` && `npm run build` — clean.
2. `npm test` — existing 56 tests still pass (none assert on CSS).
3. New unit test: call `processMvizMarkdown` on a fenced **2-series `bar`**, a
   `line`, and a `table`, and assert the output HTML:
   - contains palette hexes `#9F7AEA` and `#0D9488` (series colored from palette),
   - the two bar series use **different** colors (not a single forced fill),
   - includes the Inter/JetBrains `fonts.googleapis.com` import,
   - sets `--bg:#FFFFFF` / `--text:#1C1E26` in the generated CSS,
   - no longer contains `svg .bar { fill` `!important` overrides.
4. Manual: `npm run dev`, enter demo mode, ask a prompt that yields a multi-series
   chart; screenshot the `MvizFrame` iframe and confirm lavender/teal/blue series,
   Inter type, white chrome, 10px radii, and legible muted axis text.
```
```

## TL;DR

Yes — mviz 1.7.0 supports first-class theming, and the hook is already in our code
path (we just pass `undefined` for it). Replace the brittle `!important` CSS color
hack with a single `customTheme` object that themes both the chrome and the chart
series natively; keep only a small CSS layer for the things theming can't set (font
sizes, radius, spacing).
