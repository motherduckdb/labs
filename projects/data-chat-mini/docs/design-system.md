# Data Chat — Design System

Derived from the **MotherDuck app** (the SQL workspace: DB tree, SQL cells,
result grid, column inspector). Source-of-truth visual reference lives in Paper:
**"mini chat UI" → page "inspo" → artboard "Chat App — Design System"**
(`https://app.paper.design/file/01KT1VJEW3NGFCYHCZ40FJZ3WF/1-0`).

## Philosophy

A calm, white workspace where **data carries the color**.

1. **White ground, hairline dividers.** Pure `#FFFFFF` canvas. 1px borders do the
   dividing — not shadows, not fills. Reserve a single soft shadow for floating
   surfaces (menus, the focused composer). Never stack shadows.
2. **Typography carries hierarchy.** Inter for the interface, a monospace for all
   data/SQL/identifiers. Weight and size create rank, not boxes and color.
3. **Color is quarantined to data.** The chrome is neutral grayscale + one brand
   yellow mark. Saturated color appears only in data-viz, mapped to data *type*
   (quantitative / temporal / categorical), never as decoration.
4. **Information lives on surfaces.** Prefer content directly on the white ground
   over boxing everything in cards. The assistant reply is bare text; only the
   user message gets a bubble.

> This is a deliberate reversal of the app's previous warm-lemon / sticker theme
> (offset ink shadows, `#fff4bd` ground). Applying this system means replacing
> that palette wholesale — see "Applying to the app" below.

---

## Color

### Neutrals
| Token | Hex | Role |
|---|---|---|
| `ground` | `#FFFFFF` | app canvas, cell + card surface |
| `subtle` | `#F4F5F7` | hover / active row, inset wells |
| `surface-2` | `#FCFCFD` | cell header/footer, zebra row |
| `hairline` | `#ECEDEF` | default 1px border |
| `hairline-soft` | `#F1F2F4` | inner separators (grid rows, cell sections) |
| `line-strong` | `#D1D5DB` | input border, divider that needs to read |
| `faint` | `#9CA3AF` | placeholder, type-icon glyphs, meta |
| `muted` | `#6B7280` | secondary text |
| `ink` | `#1C1E26` | primary text, user bubble |

### Brand & semantic
| Token | Hex | Role |
|---|---|---|
| `brand` | `#FBBF24` | logo mark, primary button (with **ink** text) |
| `brand-strong` | `#F59E0B` | primary hover / pressed |
| `link` | `#2563EB` | links, focus ring border |
| `success` | `#0E9F6E` | done state, SQL string literals |
| `error` | `#DC2626` | errors, destructive actions |

Primary buttons use **ink text on yellow** (not white) — matches the MotherDuck
brand mark.

### Data-viz palette — the one place color speaks
Each role pairs a soft **fill** with a saturated **stroke**. Match the accent to
the data type; never use these for chrome.

| Role | Fill | Stroke | Use |
|---|---|---|---|
| Quantitative | `#C4B5FD` | `#9F7AEA` | numeric histograms |
| Temporal | `#99F6E4` | `#0D9488` | time series / date columns |
| Categorical | `#BFDBFE` | `#60A5FA` | value distributions |
| Count badge | `#DBEAFE` bg | `#1D4ED8` text | distinct / row counts |

### Syntax highlighting (SQL cells)
- keyword → `#8B5CF6` (violet)
- string / numeric literal → `#0E9F6E` (teal-green)
- everything else → `ink` `#1C1E26`

---

## Typography

- **UI:** `Inter` — weights 400 / 500 / 600 / 700.
- **Data / SQL / identifiers:** `JetBrains Mono` (fallback `Roboto Mono`,
  `ui-monospace`) — weights 400 / 500.

| Role | Size | Weight | Tracking | Line-height |
|---|---|---|---|---|
| Display (empty-state hero) | 30px | 700 | -0.02em | 1.05 |
| Heading (section H2) | 16px | 600 | — | 1.3 |
| Body | 14px | 400 | — | 1.55 |
| Label / UI | 13px | 500 | — | 1.4 |
| Caption / meta | 12px | 400 | — | 1.4 (muted color) |
| Eyebrow | 11px | 600 | 0.12em | UPPERCASE |
| Mono / data | 13px | 400 | — | 1.5 |

Note: the previous theme forced `letter-spacing: 0 !important` globally — drop
that so the eyebrow tracking and tightened display tracking can apply.

---

## Spacing, radius, elevation

- **Spacing:** 4px base → `4 · 8 · 12 · 16 · 20 · 24 · 32 · 48`.
- **Radius:** `6px` controls (buttons, inputs, chips) · `10px` cards & cells ·
  `12px` larger panels / the composer · `14px` chat bubbles · `999px` pills.
- **Row height:** 34–38px for list/tree/grid rows.
- **Elevation:** borders first. The only shadow:
  `shadow-sm = 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)`.
  Focus ring: `0 0 0 3px rgba(37,99,235,.15)` + `link` border.

---

## Component recipes

**Buttons** (h 36, radius 8)
- Primary: `bg brand` / `text ink` / weight 600; hover → `brand-strong`.
- Secondary: `bg ground` / `1px line-strong` / `text ink` / weight 500.
- Ghost: transparent / `text muted`; hover → `bg subtle`.
- Icon button: 36×36, `1px line-strong`, ink SVG.
- Disabled: `opacity .4`.

**Composer / input** — radius 12, `1px line-strong` at rest; on focus swap border
to `link` and add the focus ring. Send button = 36×36 `brand` square with ink
arrow.

**Chat messages**
- User: right-aligned bubble, `bg ink` / `text #FFFFFF`, radius `14 14 4 14`,
  max-width ~78%.
- Assistant: no bubble — `Assistant` eyebrow + body text on the white surface.
  Inline identifiers get `bg subtle` + mono in a 4px-radius chip.

**Tool timeline** — row: `1px hairline`, radius 10, leading 9px status dot
(`brand-strong` running / `success` done / `error` failed), title (13/500) over
mono subtitle (11, muted, truncated), trailing uppercase status label. Error rows
border `#F3C2C2`.

**Column type icons** — muted-gray glyphs reused in the schema tree and grid
headers: `T` (text), `123` (integer), `.00` (decimal), clock (timestamp). Use
fixed-width slots so they form a vertical lane.

**SQL cell** — radius 10, `1px #E2E3E6`. Header bar (`surface-2`): run triangle
left, database pill right (`999px`, hairline). Body: mono query with syntax
colors. Footer (`surface-2`): "N rows returned in Xms" in muted.

**Result grid** — header row `surface-2`, each header = type-icon + name (12/600);
numeric columns right-aligned. Data cells mono 13/ink. Zebra: white / `surface-2`.
Separators `hairline-soft`. Left index column muted, right-aligned, 48px.

**Numeric column profile** — histogram bars `fill #C4B5FD`, mode bar `#9F7AEA`,
baseline `1px hairline`; stat grid (median/mean/min/max) in mono.

**Categorical distribution** — label chip in `categorical fill`, track `#EFF4F9`
with `stroke` fill, trailing mono count + muted percent. Rank by frequency; always
pair count with percent.

**Schema explorer** — DB tree rows h34, radius 7; fixed 14–16px icon slots
(caret, cylinder=database, schema, table); indent via left padding (8 / 24 / 44).
Selected row `bg subtle`. Trailing mono row-count (e.g. `50K`).

---

## Applying to the app (Tailwind v4 + `app/globals.css`)

Replace the `:root` block in `app/globals.css` with the tokens below and drop the
global `letter-spacing: 0 !important` rule. Load Inter + JetBrains Mono (e.g. via
`next/font/google` in `app/layout.tsx`).

```css
:root {
  /* neutrals */
  --background: #FFFFFF;
  --surface-2: #FCFCFD;
  --panel: #FFFFFF;
  --subtle: #F4F5F7;        /* hover / active row */
  --foreground: #1C1E26;    /* ink */
  --muted: #6B7280;
  --faint: #9CA3AF;
  --border: #ECEDEF;        /* hairline */
  --border-soft: #F1F2F4;
  --border-strong: #D1D5DB;

  /* brand & semantic */
  --accent: #FBBF24;        /* brand — use with ink text */
  --accent-strong: #F59E0B;
  --link: #2563EB;
  --green: #0E9F6E;
  --red: #DC2626;

  /* data-viz */
  --viz-quant: #C4B5FD;     --viz-quant-stroke: #9F7AEA;
  --viz-temporal: #99F6E4;  --viz-temporal-stroke: #0D9488;
  --viz-categorical: #BFDBFE; --viz-categorical-stroke: #60A5FA;
  --viz-count-bg: #DBEAFE;  --viz-count-fg: #1D4ED8;

  /* syntax */
  --syntax-keyword: #8B5CF6;
  --syntax-string: #0E9F6E;

  /* shape */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-bubble: 14px;

  /* space — 4px base */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px;

  /* elevation & focus */
  --shadow-sm: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04);
  --focus: 0 0 0 3px rgba(37,99,235,.15);

  --font-ui: "Inter", system-ui, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "JetBrains Mono", "Roboto Mono", ui-monospace, "SFMono-Regular",
    Consolas, monospace;
}
```

Optional Tailwind v4 `@theme` exposure (so utilities like `bg-brand`,
`text-ink`, `border-hairline` work):

```css
@theme {
  --color-ground: #FFFFFF;
  --color-subtle: #F4F5F7;
  --color-ink: #1C1E26;
  --color-muted: #6B7280;
  --color-faint: #9CA3AF;
  --color-hairline: #ECEDEF;
  --color-line-strong: #D1D5DB;
  --color-brand: #FBBF24;
  --color-brand-strong: #F59E0B;
  --color-link: #2563EB;
  --color-success: #0E9F6E;
  --color-error: #DC2626;
  --color-viz-quant: #9F7AEA;
  --color-viz-temporal: #0D9488;
  --color-viz-categorical: #60A5FA;
  --font-sans: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Roboto Mono", ui-monospace, monospace;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
}
```

### Migration checklist
- [ ] Swap the `:root` tokens; remove `letter-spacing: 0 !important`.
- [ ] Drop the `.app-shell` / `.picker-screen` lemon gradient + dot-grid; use flat
      `#FFFFFF`.
- [ ] Replace offset ink shadows (`0 2px 0 var(--ink-border)`) with `--shadow-sm`
      or borders.
- [ ] User bubble `#153f3b` → `--foreground` (ink); assistant stays bubble-less.
- [ ] Primary buttons: yellow `--accent` + **ink** text (not white).
- [ ] Composer focus → `--link` border + `--focus` ring.
- [ ] Schema tree + result grid: adopt the type-icon glyph slots.
- [ ] Route all chart/profile color through the `--viz-*` tokens by data type.
