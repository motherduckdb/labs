# Editable Dive — Scene & Overrides Reference (v1)

Normative spec for the `SCENE` JSON baked into an editable dive and the overrides bag the
in-browser editor writes to `useDiveState("ov")`. The template (`template.jsx`) interprets
both; the bake-back workflow merges overrides into `SCENE`.

**Authoring a DECK?** A slides dive (`template-slides.jsx`) uses schema `v: 2` — this schema plus a
`slides` array, a required `slide` key on every element, an optional `build` step, four extra bag
keys and the `sqltable` type. **`reference-deck.md` is the spec for all of that**; read it alongside
this file. Everything below still applies to a deck except where that file says otherwise. The
deck-only keys and the `sqltable` type are *refused* in a `v: 1` scene, so nothing from that file
belongs in a single-canvas dive.

## Scene

```
{
  "v": 1,                    // schema version (this document)
  "version": 1,              // CONTENT version — bump on every bake-back; overrides carry
                             // _base and are IGNORED when _base !== version (stale-edit guard)
  "diveId": "<uuid>",       // required for the in-editor Save link; omitted only before create
  "page": {
    "width": 1440,           // logical coordinate width. The page renders scaled to fill
                             // 100% of the available width; all x/w below are in these units
    "height": 900,           // any height; the page scrolls vertically
    "background": "#f8f8f8"
  },
  "images": { "sql": "SELECT name, src FROM \"db\".\"main\".\"dive_assets\"" },  // OPTIONAL —
                             // ONE query pulling ALL images: columns `name` (key) and `src`
                             // (data-URI text or *.motherduck.com URL). Omit if no images.
  "elements": [ ... ]        // flat list of leaves AND groups; paint order = leaf z ascending
                             // (no CSS z-index is used; groups paint nothing)
}
```

**SCENE must be pure JSON** — parseable by `JSON.parse` after stripping `const SCENE = ` and
the trailing `;`. No expressions, no trailing commas, no comments. Bake-back depends on this.

`diveId` is an untrusted routing value, not proof of ownership. The Save server accepts any valid
UUID route, authenticates and mints a short-lived credential, fetches the current Dive with that
credential, requires the fetched Dive's defensively derived organization in its configured org set,
and compares fetched `owner_id` to that credential's `userId` before writing.

## Elements — common props

| prop | type | notes |
|---|---|---|
| `id` | string | stable human-readable slug (`title-1`, `chart-pm25-trend`). Never reused |
| `type` | `"text" \| "image" \| "shape" \| "line" \| "chart" \| "table" \| "group"` | `"sqltable"` is legal only in a DECK (`v: 2`) — see below |
| `name` | string | display name in the layers tree (renameable) |
| `parent` | string or `null` | OPTIONAL — id of the containing **group**; absent/`null` = top level |
| `x`, `y` | number | px in logical page coordinates |
| `w` | number | px |
| `h` | number or `"auto"` | `"auto"` ONLY for text (recommended for all text in a `v: 1` scene: height follows content; the editor then offers only E/W resize handles). **In a DECK a numeric `h` on text means AUTOFIT** — see `reference-deck.md` § 4 |
| `z` | number | paint order, unique; use gaps of 10 (`10, 20, 30…`) |
| `opacity` | number 0..1 | |

## Groups (hierarchy)

```
{ "id": "group-1", "type": "group", "name": "Section: coverage", "parent": null }
```

A group carries **only** `id`, `type`, `name`, `parent` — never `x/y/w/h/z/opacity`:

- **Geometry is derived**, always: a group's rect is the union of its descendant leaf rects
  (auto-height text measured live). It is never stored and never stale.
- **Membership lives on the child**, as its `parent` pointer. Groups nest arbitrarily deep.
- **Groups paint nothing.** Only leaves render, sorted by `z` ascending as before.
- `z` stays on leaves only. A group's descendants must form a **contiguous block** in the
  global z order. That is an invariant maintained by the operations that touch order
  (grouping, tree drag, arrange, bake-back renumbering) — the runtime never asserts it, so an
  authored scene that violates it simply paints other elements through the group.

Runtime sanitizing (both `mergeScene` and bake-back should apply it): a `parent` that names a
missing id or names a non-group is treated as `null`. Cycles can only run through groups, so
they are broken at the group level: every group **on** a cycle loses its own `parent`, which
leaves the forest acyclic while descendants of those groups keep theirs. (Walking up from
each element instead would also orphan the innocent children of a cycle, and would make the
repair non-idempotent — re-merging the same overrides bag would keep changing the tree.) A
group whose last child is deleted is deleted too (empty-group cascade).

### Editor behaviour (brief)

- Clicking a grouped element selects its **outermost** ancestor group. Double-clicking a
  selected group **drills** one level in (the drill state is a single "entered group"; Esc
  steps back out one level per press). Cmd/Ctrl+click selects the leaf directly.
- Marquee-dragging the background selects everything it touches, promoted the same way.
- Move/nudge/delete apply to the resolved **leaves** of the selection; the layers tree and the
  inspector act on the unexpanded selection. Groups have no resize handles.
- ⌘G groups the selection (≥2 roots, new group in `added` with id `new-group-N`), ⌘⇧G
  ungroups. Both write per-element `parent` patches plus a `z` renumber as ONE undo step.
- Align (6 edges) and distribute (H/V, ≥3 roots) act on the selection **roots** — a group
  aligns as one unit off its derived rect — and write the resulting delta to that root's
  leaves, one undo step per action.
- ⌘D duplicates and ⌘C/⌘V copy/paste the selection roots' whole subtrees: deep clones with
  fresh `new-<type>-N` ids land in `added` offset +16/+16, each clone block renumbered
  contiguously immediately above its source block. The clipboard is in memory only — it never
  touches the OS clipboard or the URL.
- **Cropping an image** is a mode entered from the inspector's Crop button (disabled while the
  `imageKey` resolves to no source), never by double-click. The section swaps to a zoom slider
  plus Reset/Done, the element gets a dashed accent ring, and dragging inside it pans the
  picture instead of moving the element — moves and resize handles are off for that element
  until Done, Esc (which keeps the selection) or selecting something else. Each pan release,
  zoom release and reset is one undo step; entering and leaving the mode is none.
- **Every text surface** — text elements, chart titles, chart axis labels, chart axis ticks —
  is styled through the SAME inspector control set (size · B/I/U · align · color · highlight);
  surfaces with richer options render those alongside it.
- The edit canvas is **unbounded**. Nothing clamps a move or a nudge to the page, so elements
  may sit outside it — including at negative coordinates — and the surround is painted in the
  page colour with no sheet shadow, so there is no visible page edge. The scrollable plane
  grows to cover wherever content has been left, and the published view renders out-of-page
  elements too: parking content far off-page is the author's choice, not a way to hide it.
  The zoom **fits** (width / height / all) frame the *used* space — the union of the element
  rects, page rect on an empty scene — and centre it; 100% still means "page fills the width".

## TextStyle (shared by every text surface)

One sparse shape describes the styling of any text in a dive. Absent keys mean "use the
surface's own default"; `highlight: null` means "no highlight" (the default everywhere).

```
{
  "fontSize": 13,                          // px
  "bold": true,                            // true => 700, false => 400
  "italic": true,
  "underline": true,
  "align": "left" | "center" | "right",    // block alignment; not offered for axis ticks/labels
  "color": "#231f20",
  "highlight": "#ffe98a" | null            // background band behind the text
}
```

It appears **flattened** onto text elements (`fontSize`, `color`, `align`, `weight`, `italic`,
`underline`, `highlight` as direct element props — `weight` is the numeric ladder rather than a
boolean `bold`) and **nested** on charts as `chart.text.{title,labels,ticks}`.

Highlight rendering: HTML surfaces (text elements, chart title) get a real CSS `background` on
the text node — no padding, so an unset highlight changes nothing about layout. SVG surfaces
(axis labels, axis ticks) get a `<rect>` drawn behind the glyphs, sized from **approximate**
metrics — width = `chars × fontSize × 0.62`, height = `fontSize × 1.35`, top edge at
`baseline − 1.05 × fontSize` — so a band can run ~10% wide or narrow depending on the string.

## Per-type props

**text** — `text` (string, `\n` allowed), `level` (`"h1"|"h2"|"h3"|"p"` — drives the HTML tag
and default size/weight: h1 44/700, h2 28/650, h3 20/600, p 15/400), `fontSize` (px, overrides
level default), `color`, `align` (`"left"|"center"|"right"`), optional `weight`, `lineHeight`,
plus the optional flat TextStyle extras `italic` (bool), `underline` (bool) and `highlight`
(color string or `null`). All are optional — an element without them renders exactly as before.

**image** — `imageKey` (joins the images query result by `name`), `fit`
(`"cover"|"contain"|"fill"`), `alt`, optional `radius`, plus optional
`crop: { "ox": 0.5, "oy": 0.5, "zoom": 1 }`.

`crop` is **absent by default** and an image without it renders through exactly the plain
`<img>` path it always used. When present, the image sits in an overflow-hidden frame the size
of the element: `zoom` (1–4) scales it, and `ox`/`oy` ∈ [0,1] say which part of the overscan is
shown (`0.5, 0.5` = centred, `0` = flush left/top, `1` = flush right/bottom). Because ox/oy are
normalized they parametrize exactly the legal pan range at any zoom, so the frame is always
fully covered — there are never blank gutters, and nothing needs re-clamping when the zoom
changes. `fit` still applies inside the frame: for `"cover"` the pan additionally slides the
source within the cover overflow (so a cover image is pannable even at `zoom: 1`); for
`"contain"`/`"fill"` there is no overflow, so only `zoom > 1` opens a pan range and cropping
there behaves like a cover of the zoomed region. **Changing `imageKey` clears `crop` in the
same commit** — a frame chosen for one asset is meaningless on another of a different size.

**shape** — `fill`, `stroke`, `strokeWidth`, `radius`, plus optional `shape`
(`"rect"|"ellipse"|"triangle"|"diamond"|"hexagon"|"star"`, absent = `"rect"`) and optional
`strokeDash` (`"solid"|"dashed"|"dotted"`, absent = solid). A rectangle by default; use for
callout boxes, color panels, backgrounds behind chart regions. `radius` applies to `"rect"`
ONLY — the other kinds are drawn as an SVG geometry stretched to the element box (their stroke
stays an even `strokeWidth` px however non-uniformly the box is scaled).

**line** — `orientation` (`"h"|"v"`), `color`, `thickness` (px), plus optional `dash`
(`"solid"|"dashed"|"dotted"`, absent = solid) and optional end markers `capStart` / `capEnd`
(`"none"|"arrow"|"circle"|"square"`, absent = none; drawn ~3× `thickness`). `w`/`h` define the
hit area (give short accent rules `h: 8` so they stay clickable); the visible bar is
`thickness` thick, centered — a line with no dash and no caps renders exactly as a plain bar.

**table** — `cells` (REQUIRED, rectangular row-major array of cell records), plus optional
`colWidths`, `rowHeights` and `border`. A basic hand-typed grid; it holds no query and no
formulas.

```
"cells": [
  [ { "t": "Region", "bold": true }, { "t": "Q1", "bold": true, "align": "right" } ],
  [ { "t": "North" },                { "t": "118", "align": "right" } ]
],
"colWidths": [0.6, 0.4],            // OPTIONAL relative weights, one per column
"rowHeights": null,                 // OPTIONAL; null/absent = uniform
"border": { "on": true, "color": "#d6d9de", "width": 1 }   // OPTIONAL; absent = on, 1px
```

A cell is `{ "t": "text" }` plus any of the TextStyle keys (`fontSize`, `bold`, `italic`,
`underline`, `align`, `color`, `highlight`) — the SAME vocabulary every other text surface
uses, edited through the same inspector control. Omit a key to inherit the table default
(13px, `#231f20`, left).

`colWidths`/`rowHeights` are relative **weights**, not pixels: each track renders as its share
of the element box, so resizing the table scales the whole grid and `w`/`h` stay the only
source of truth for its size. Absent or `null` means uniform, and the editor writes `null`
back whenever a track becomes uniform, so a plain grid costs nothing in the bag. **Every row
must have the same number of cells, and a present track must have exactly one entry per
column/row** — the bake validates the merged element and rejects a grid whose `cells` and
tracks disagree.

Authoring: prefer a table for small, hand-written reference grids (definitions, a legend, a
short comparison). For anything query-driven use **sqltable** (a grid of live rows) or **chart**
(a picture of them) — a `table` never runs SQL.

**sqltable** — DECK ONLY (`v: 2`; the slides fork's `template-slides.jsx`). The type allowlist is
schema-dependent, so a `sqltable` in a `v: 1` scene — or in a `v: 1` override bag — is rejected as an
invalid type by the validator, not merely unrendered. `template.jsx` has no renderer and no inspector
for it, and an element it cannot draw or configure must not be able to reach an author's source.

It is the query-backed sibling of `table`: `sql` (string, editable and runnable in the
browser inspector, exactly like a chart's), optional `title`, and the presentation keys below.
It stores NO data — the rows are whatever the statement returns at render time.

```
"sql": "SELECT region, revenue, growth FROM ...",
"limit": 9,                         // OPTIONAL cap on rows DRAWN, 1..200. Absent = the DEFAULT
                                    // BOX's capacity (9), a constant — not this box's. The box
                                    // is applied separately: see `limit` below.
"header": true,                     // OPTIONAL; absent = on
"zebra": true,                      // OPTIONAL; absent = on (the ODD body rows stripe)
"border": { "on": true, "color": "#d6d9de", "width": 1 },   // OPTIONAL; the SAME key as `table`
"columns": {                        // OPTIONAL per-column presentation, keyed BY COLUMN NAME
  "revenue": { "label": "Rev", "align": "right", "format": "compact" }
},
"textStyles": {                     // OPTIONAL TextStyle bags, one per target
  "header": { "bold": true }, "cells": { "fontSize": 15 }, "title": { "align": "center" }
}
```

`columns` is keyed by column NAME, not position, so changing the SELECT list cannot apply one
column's formatting to another; a renamed column simply loses its own. `align` takes the same
three values a table cell's does, and `format` takes the same four the chart's tick Format takes
(`"none"|"number"|"compact"|"percent"`). Omit `align` and it is DERIVED from the data — numbers
right, everything else left — so a grid is readable before anything is configured. There are no
`colWidths`/`rowHeights`: the columns come from the query, so a position-keyed weight vector would
hand the wrong width to the wrong column the first time the SELECT list changed. The drawn columns
divide the element equally instead, which is also what makes every column the grid draws a column the
audience can see.

`limit` bounds the rows DRAWN, not the rows fetched: the statement runs in full. Put a `LIMIT` or
an aggregate in the SQL when the transfer, and not the slide, is what needs bounding.

**Two bounds, per axis, and the smaller wins.** `limit` is what the author asked for; the ELEMENT
BOX is what can actually be shown, and the grid draws `min(limit, capacity)`. Vertically the capacity
is how many fixed-height rows fit under the header and above the caption row; horizontally it is how
many columns fit at a readable minimum width, capped at 40. An absent `limit` resolves to a CONSTANT
(the default box's capacity), not to "as many as fit this box" — the box bound does that job, and it
re-applies on every render, so resizing an element changes what it draws with no key to update.

A grid that withheld anything says so under its last row, on both axes and on every surface:
`Showing 9 of 7,182 rows`, `Showing 11 of 20 columns`, or `Showing 9 of 7,182 rows, 11 of 20 columns`.
A value too wide for its column ellipsizes rather than being sheared off at the frame's edge.

Authoring: use `sqltable` when the numbers themselves are the point (a KPI table, a top-N list,
a reference grid off live data) and a `chart` when the SHAPE is. Both participate in present
mode's load-time query pool, and both are deduplicated by SQL text — a statement shared by a
chart and a grid runs once.

**chart** — `sql` (string, editable and runnable in the browser inspector), optional `title`,
and `chart` (ChartConfig, fully editable in the inspector):

```
"chart": {
  "kind": "line" | "bar" | "barH" | "area" | "scatter",
  "stacked": false,                  // with kind => 9 chart types; ignored for scatter
  "stackOffset": "none" | "expand",  // expand = 100%-stacked
  "x": { "key": "<column>", "type": "category"|"number"|"time",
         "label": "", "tickAngle": 0|-30|-45|-90,
         "tickFormat": "none"|"number"|"compact"|"percent" },
  "y": { "label": "", "domain": "auto"|"zero",
         "tickFormat": "none"|"number"|"compact"|"percent" },
  "series": [ { "key": "<numeric column>", "label": "Display name", "color": "#0777b3" } ],
  "style": { "lineType": "linear"|"monotone"|"step", "strokeWidth": 2, "dot": false,
             "fillOpacity": 0.25, "barSize": null, "radius": 4 },
  "scatter": { "sizeKey": null },    // numeric column for bubble sizing
  "grid": { "show": true, "dash": "3 3" },
  "legend": { "show": true, "position": "top"|"bottom" },
  "tooltip": { "show": true },
  "connectNulls": false,
  "text": {                          // OPTIONAL — TextStyle per target, all sparse
    "title":  { ... },               // the chart's `title` prop. Defaults 13px / 600 / #231f20;
                                     // `align` applies (the title is a block)
    "labels": { ... },               // the x/y axis labels. Defaults 11px / #6a6a6a; no align
    "ticks":  { ... }                // the axis indicators on BOTH axes. Defaults 11px /
                                     // #6a6a6a; no align. tickAngle/tickFormat still apply
  }
}
```

`chart.text` is entirely optional and each target is omitted until styled — a chart without it
renders through the exact code path it always used.

Chart SQL rules (from the dive platform):
- Fully-qualified double-quoted table names: `"database"."main"."table"`.
- Coerce numerics in SQL (`CAST(x AS DOUBLE)`); format dates in SQL with `strftime` and use
  `x.type: "category"` with pre-sorted date strings (there is no first-class time scale).
- Fill time-series gaps with a `generate_series` date spine — Recharts does not interpolate.
- **Multi-series charts need WIDE data**: one numeric column per series, one row per x value
  (pivot long data with `SUM(CASE WHEN category = '…' THEN v ELSE 0 END) AS <col>`); every
  `series[].key` must be a real result column.
- One query per chart. Keep results small (aggregate in SQL).

The inspector's Dracula SQL editor patches `sql` only after the edited query runs successfully;
Run is one undo entry, and leaving a changed editor also runs it. A failed draft stays local, shows
an inline error, and leaves the prior chart query/render intact. Successful results refresh the
column menus. If the result no longer contains `x.key`, a `series[].key`, or
`scatter.sizeKey`, the config is deliberately preserved: its menu entry reads
`<key> (missing)` and the chart shows its needs-a-column state until the author chooses a valid
column. SQL is ordinary override data and counts against the same 64 KB budget.

## Overrides bag (`useDiveState("ov")`)

```
{
  "v": 1,
  "_base": 1,                          // SCENE.version the edits were made against
  "patch": { "<id>": { ...changed props, absolute values... } },   // sparse
  "deleted": ["<id>"],
  "added": [ { full element objects, ids "new-text-1"… } ],
  "page": { "height": 1200 }           // optional page patch
}
```

Merge semantics (both the runtime `mergeScene` and bake-back):
1. If `_base !== SCENE.version` → overrides are ignored entirely (editor shows a
   "clear stale edits" notice).
2. Drop `deleted` ids; shallow-merge `patch[id]` into each element (`id`/`type` can never be
   patched; chart `sql` is patchable, and `chart` is patched as a whole object); append `added` (also patchable —
   `added` holds browser-created groups too, ids `new-group-N`); merge `page`; sanitize
   `parent` pointers (missing/non-group/cyclic → `null`); sort leaves by `z`.
3. Patches equal to the base value are pruned on commit, so bags stay small (typical heavy
   session: 1–5 KB against the 64 KB dive-state ceiling; the editor's byte meter and 64 KB
   Save/handoff guards protect the limit).

## Bake-back merge (performed by the shared core)

`merge-core.mjs` is normative. Its generated inline copy supplies runtime `mergeScene`; the Save
server imports a byte-identical generated module and calls strict `bakeScene`. Regenerate with
`scripts/sync-merge-core.mjs` so the two paths cannot drift.

1. Download current source; extract the JSON between `// __SCENE_START__` and
   `// __SCENE_END__` (strip `const SCENE = ` and trailing `;`), `JSON.parse` it.
2. Verify `ov._base === scene.version` (else warn and stop).
3. Apply merge semantics above; rewrite `new-*` ids to permanent slugs (`new-group-1` →
   `group-N`, updating every `parent` that points at it); renumber `z` to `10, 20, 30…` in the
   merged order — which keeps each group's leaves contiguous because the editor already left
   them so; drop groups that ended up empty; **increment `scene.version`**.
4. Re-serialize with `JSON.stringify(scene, null, 2)` between the sentinels; validate the
   whole file (JSON parses, ids unique, and inside the assembly size bands — **warn at
   768 KB, hard limit 896 KB**, which is the Save service's 1 MB `MAX_SOURCE_BYTES` minus
   128 KB of bake headroom; see the pre-save checklist in `SKILL.md`); update the dive.
5. Old edited URLs now carry stale `_base` values and render the freshly baked scene.

## In-editor Save handoff

- Save reads the latest full override bag through the single marked MotherDuck-state owner in
  `template.jsx`; never parse the browser URL or a `ref:` value.
- New launch fragments use `v=2`, tag their payload as `z=raw` or `z=dfl`, and carry `ov` as
  base64url bytes. The destination still accepts legacy `v=1` uncompressed JSON links. Raw links
  remain synchronous; only a raw candidate beyond 32,768 characters is debounced and compressed
  with `CompressionStream("deflate-raw")`. A click whose live bag does not match the prepared
  candidate is prevented with an explicit retry message. The override bag is non-secret, but it
  must stay in the fragment and under the URL guard. Credentials, OAuth codes, and tokens never
  belong in this URL.
- Use the rendered `<a target="_blank" rel="noopener noreferrer">` Save control. MotherDuck
  mediates it through an external-navigation dialog and sends no opened/blocked acknowledgement;
  UI copy must say only that a tab was requested.
- The destination clears the fragment and forwards the tagged bytes. The server caps encoded and
  compressed input before inflating `dfl`, stops inflation just beyond 65,536 output bytes, and
  returns `PAYLOAD_TOO_LARGE` without writing a session when the cap is crossed. It compresses only
  the override bag inside the encrypted HttpOnly session (never OAuth credentials in the same
  compression context), then runs MCP OAuth, fetches the target with the caller's minted credential,
  gates its derived organization before matching `owner_id` to credential `userId`, preserves all
  `version_required_resources`, bakes, writes, and verifies a matching re-read.

## Authoring rules for groups (REQUIRED for generated scenes)

A generated scene must arrive **organized and NESTED**, not as a flat pile — the layers tree
is the first thing a user opens, and it should read like an outline of the page. Groups
contain leaves AND other groups; a 2-level tree is the minimum, and sections with charts must
be ≥3 levels deep:

- **Title block** — h1, dek, accent rule.
- **KPI row** — a group of groups: each KPI's value + its label form their own pair group
  (`"KPI: total revenue"`), and those pair groups nest inside the row group. This is the
  general **pair rule**: an item and the label/caption that belongs to it always group
  together (KPI value+label, a footer rule+text, an image+its caption) so they move as one.
- **One group per section** — direct children: the h2 heading and dek leaves, plus:
  - **One `"Chart: …"` sub-group PER CHART** holding that chart together with ALL of its
    annotations (note texts, pointer lines, tint bands). This is the default, always —
    chart and its annotations move as one unit. A bare chart with no companions may stay a
    direct child of the section.
  - **A `"Side panel: …"` sub-group** for side commentary (panel shape + its texts).
- Leave one-off furniture (footer rule + footer text as a small "Footer" group, or single
  elements at top level; a group of one is noise).

Rules:
- Ids `group-1`, `group-2`, … in document order. Names describe the unit:
  `"Title block"`, `"KPI row"`, `"Section: coverage"`, `"Chart: median PM2.5"`,
  `"Side panel: what moved"`.
- Every `parent` names an existing group (groups-of-groups expected); no cycles; no empty
  groups.
- **Keep each group's descendant leaves contiguous in `z`** — assign z sub-group by
  sub-group (`10, 20, 30…`) so every group's members occupy one unbroken run.
- Groups carry no geometry. Never give a group `x/y/w/h/z/opacity`.
- The layers tree orders **every sibling list** in canvas reading order — top-to-bottom,
  ties broken left-to-right — re-sorted live as elements move (z is only a final tiebreak).
  Author groups as spatial bands of the page so the tree mirrors the layout.

## Layout & design rules for authored scenes

The published page must look deliberately designed, not defaulted:

- **Canvas**: 1440 logical width; 96px side margins for content; vertical rhythm in multiples
  of 8; section gaps ≥ 48px. Page height: whatever the content needs (1000–2600 typical).
- **Type**: one h1 (44px) at top; a one-line muted dek under it (16px `#6a6a6a`); h2 (28px)
  section headings; body 15–16px. Max two text colors (`#231f20` ink, `#6a6a6a` muted) plus
  one accent (`#0777b3`).
- **No card chrome**: content floats on the page background (`#f8f8f8`); no white boxes with
  borders around charts. A `shape` element behind a chart is allowed only as a subtle tint
  panel (e.g. `#eef3f7`, radius 12, no border).
- **Charts**: min 360×260; default series color `#0777b3`; palette for multi-series:
  `["#0777b3", "#bd4e35", "#2d7a00", "#e18727", "#638CAD", "#adadad"]`. `lineType: "linear"`.
  Y domain `"zero"` for bar charts.
- **KPIs**: big number as an h1/h2 text element with a small muted label text element under
  it; row of 3–4, evenly spaced.
- **Accent rules**: short `line` elements (64×3, accent color) under the title or section
  heads give the page structure.

## Annotation pattern (highlighting findings on charts)

Annotations are ordinary elements layered ON TOP of a chart (higher `z`):
- A short `text` element (13–14px, `#bd4e35` or ink, weight 600) stating the finding in
  matter-of-fact terms ("PM2.5 in Delhi peaked at 225 µg/m³ in 2016").
- Optionally a `line` element (1–2px, same color) pointing from the label toward the data
  region, and/or a `shape` element (`fill` a 10–15% tint like `#bd4e3522` is NOT possible —
  use a light solid like `#f6e3de` with `opacity: 0.5`, `strokeWidth: 0`) to band a region.
  Give tint bands a **lower `z` than the chart** — Recharts SVG is transparent, so the band
  shows through without greying the marks; a band above the chart washes it out.
- Give annotations `z` above the chart's `z` and names like "Note: Delhi peak" so they read
  clearly in the layers tree. Position them inside the chart's box using the chart's x/y/w/h
  as the frame of reference (plot area starts ≈56px in from the chart's left edge and ≈8px
  from the top; eyeball placement, then nudge in the editor).
