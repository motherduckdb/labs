# Editable Dive — Deck Schema Reference (v2, the slides fork)

Normative spec for the **deck** `SCENE` (`v: 2`) baked into a slides dive and the deck half of the
overrides bag the in-browser editor writes to `useDiveState("ov")`. The slides template
(`template-slides.jsx`) interprets both; `merge-core.mjs` validates and bakes both.

**This is a companion to `reference.md`, not a replacement.** Everything in that file about
elements, groups, TextStyle, charts, tables and the annotation pattern still applies unchanged.
So does Save: a deck saves by running the same save Flight (`flight/save_deck.py`, see SKILL.md
"Save Flight"), which bakes the deck bag with the same core and the same 64 KB cap. This file covers only what a DECK adds: the `slides` array, the `slide` and
`build` element keys, the four deck-only bag keys, lists and autofit, present mode, and the slide
design conventions.

It is a separate file rather than a section of `reference.md` for one reason that matters: the
deck-only parts of the schema are **refused** in a v1 scene, and a reader of `reference.md` is
usually authoring for `template.jsx`, which has no renderer for any of them. Interleaving the two
would put keys on the page that an author of a single-canvas dive must never write — and the
containment rule below is exactly the thing that must not read as optional. (`sqltable`'s
per-key spec does live in `reference.md`, with the per-type props of every other element type;
this file gives the deck-side summary and points there.)

---

## 1. The deck-only rule (read this first)

Three things exist only in a deck, and the validator enforces it in **both directions**:

| | v1 scene (`v: 1`, `template.jsx`) | deck (`v: 2`, `template-slides.jsx`) |
|---|---|---|
| element type `sqltable` | **refused** — `INVALID_SCENE` / `INVALID_OVERRIDES` | legal |
| element key `slide` | **refused** | **required on every element** |
| element key `build` | **refused** | optional, leaves only |
| bag keys `slidePatch` / `addedSlides` / `deletedSlides` / `slideOrder` | **refused** | legal |
| scene key `slides` | **refused** (`scene.slides requires scene schema v2`) | **required**, non-empty |

This is not tidiness. The override bag lives in dive state, which travels with the URL, and reaches
the save Flight as run config, so it is attacker-controlled.
`template.jsx` has no present mode, no build control and no `sqltable` renderer or inspector — so a
key or type that were merely "unused" there would still **bake**, and the author of a Figma-style
dive would own an invisible, unconfigurable element in their own source with no UI able to remove
it. Gating on the schema (`editableDiveTypesFor`, `EDITABLE_DIVE_DECK_ONLY_TYPES`,
`EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS`) makes the containment structural, which is why the v1
equivalence gate can be trusted rather than merely green.

The gate is symmetric, so a **half-migrated file cannot bake**: a `v: 1` scene carrying `slides`
fails, and a `v: 2` scene whose elements lack `slide` fails. Bag `v` must equal scene `v`.

---

## 2. Deck scene

```
{
  "v": 2,                       // 2 = deck. `isDeckScene` is exactly `scene.v === 2`
  "version": 1,                 // CONTENT version, as in v1: bake increments it, and a bag whose
                                //   _base != version is ignored entirely (stale-edit guard)
  "diveId": "<uuid>",           // as in v1 — required for Save (the Flight checks it)
  "page": {
    "width": 1280,              // THE SLIDE SIZE. Identical for every slide; there is no
    "height": 720,              //   per-slide size. Present mode fits-and-letterboxes this ratio
    "background": "#ffffff"     //   fallback for a slide with no `background` of its own
  },
  "images": { "sql": "..." },   // unchanged from v1; omit when there are no images
  "slides": [ ... ],            // REQUIRED, non-empty. ARRAY ORDER IS DECK ORDER
  "elements": [ ... ]           // v1 elements, each with a REQUIRED "slide"
}
```

`page.width`/`page.height` are the whole deck's slide size. `1280 × 720` is what the layouts and
the worked example use; the editor never clamps to it (the canvas is unbounded, exactly as in v1),
but present mode crops to it — an element parked outside the page is invisible when presenting even
though the editor still shows it.

### Slide records

```
{ "id": "slide-3",              // REQUIRED, unique, matches /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
  "name": "Channel mix",        // OPTIONAL — the filmstrip label; blank rows are legal
  "background": "#fbf7f0",      // OPTIONAL — absent falls back to page.background
  "notes": "…",                 // OPTIONAL — speaker notes, plain text, \n allowed
  "hidden": true }              // OPTIONAL boolean — "Skip in present" in the inspector
```

Those five keys and no others: an unknown key on a slide is `INVALID_SCENE`. `name`, `background`
and `notes` must be strings (or absent/null), `hidden` a boolean. `notes` is bounded by the generic
per-string cap (256 KiB) and by the scene's own size, not by a notes-specific limit.

**Slide ids and element ids share ONE namespace.** A slide id that collides with an element id is
`INVALID_SCENE`, and so is the reverse. That is deliberate: every pointer in the bag (`slidePatch`
keys, `slideOrder`, `deletedSlides`, `patch` keys, `deleted`) is just an id, so a mixed-up id is a
loud error instead of a silent no-op. `__proto__`, `prototype` and `constructor` are refused as
slide ids.

`background: null` (or absent) is the canonical way to say "match the page" — the editor writes
`null` rather than the page colour so that a per-slide background stays *removable*.

### The required `slide` key

Every element carries `slide`, **leaves and groups alike**, naming a slide in `scene.slides`:

```
{ "id": "s4-chart", "type": "chart", "name": "Channel mix", "parent": "s4-chartgrp",
  "slide": "slide-4", "x": 96, "y": 184, "w": 1088, "h": 372, "z": 280, "opacity": 1, … }
```

- A missing or unknown `slide` is `INVALID_SCENE`.
- **A group and every descendant must share one `slide`.** Violating it is `INVALID_SCENE` on the
  scene and `INVALID_OVERRIDES` on the merged result — the same class of structural invariant as
  the parent forest. Checking each element against its *direct* parent covers the subtree.
- `slide` sits in the COMMON key set, so it is patchable for every type: moving an element to
  another slide is a one-key patch (measured: **40 B** in an otherwise-empty bag).

`z` is still ONE GLOBAL paint order, not per-slide. Nothing paints two slides at once, so a
collision across slides is harmless; `bakeScene` re-contiguises by `(slide deck position, z)` and
renumbers `10, 20, 30…`, which is what keeps each slide's leaves an unbroken run of the global
order. **Author `z` slide by slide in deck order** and the bake is a no-op on it — the worked
example is checked for exactly that (see `scripts/check-deck.mjs`).

### `build` — one click of a slide

```
{ …, "build": 2 }               // OPTIONAL. Integer 1..999. LEAVES ONLY
```

- A leaf with no `build` (or `build: null`) is **on screen from the moment its slide is**.
- **A slide's steps are its distinct `build` values, ascending and compacted.** `1, 5, 9` is
  three clicks, not nine — an empty step would be a click that changes nothing. Sparse numbering is
  therefore legal and renders correctly, but it does **not survive editing**: the editor's Build
  order panel renumbers the slide to `1..N` on every write, so `1, 5, 9` becomes `1, 2, 3` the first
  time anything touches it. Author contiguously; there is no longer a gap to insert into, because
  inserting is a drag rather than a typed number.
- **Duplicates reveal together.** That is the whole mechanism for "these four things arrive at
  once": give every leaf in the group the same step. In the worked example each KPI's number and
  its label share a step, so the pair appears as one unit.
- `build` on a **group** is refused (`INVALID_SCENE` / `INVALID_OVERRIDES`), on both the element
  and via a patch. A group has no box and no step of its own; a group ROW in the editor's Layers
  panel writes to all of its **descendant leaves**, which is how a group is still built as one step.
- The cap (999) bounds the *label*, not the click count. The renderer honours any integer ≥ 1 that
  is actually in the file, so a hand-edited `build: 1500` reveals last rather than first.
- A hidden slide's builds are simply never walked — present mode cannot seat the cursor there. They
  still work if the slide is opened directly via "Present from this slide".
- Cost in the bag: **32 B** for one step, **35 B** to clear one (`{"build":null}` — `null` is the
  un-build, so `prunePatch` can drop the key).

### Element types in a deck

Everything in `reference.md` § "Per-type props" applies. The full type set and its per-type keys:

| type | keys beyond the common ones (`id type name parent slide x y w h z opacity build`) |
|---|---|
| `text` (`level`: h1 h2 h3 p ul ol code link) | `text` `level` `fontSize` `color` `align` `weight` `lineHeight` `italic` `underline` `highlight` |
| `image` | `imageKey` `fit` `alt` `radius` `crop` |
| `shape` | `fill` `stroke` `strokeWidth` `radius` `shape` `strokeDash` |
| `line` | `orientation` `color` `thickness` `dash` `capStart` `capEnd` |
| `chart` | `sql` `title` `chart` |
| `table` | `cells` `colWidths` `rowHeights` `border` |
| **`sqltable`** | `sql` `title` `columns` `limit` `header` `zebra` `border` `textStyles` — **8 keys, deck only** |
| `group` | none — and never `x y w h z opacity build` |

`sqltable` is the query-backed sibling of `table`: it stores a statement plus presentation and no
data at all. `reference.md` holds its full spec (the two-bounds rule, the `columns` record keyed by
column NAME, the truncation caption, the `format` values). What matters for a deck:

- `limit` bounds the rows **drawn**, 1..200; the statement always runs in full. The element box
  bounds it again, and the grid draws `min(limit, box capacity)`, reporting anything withheld under
  the last row (`Showing 9 of 7,182 rows`).
- **Size the box to the rows you want.** The row capacity is deterministic from `h`, so pick `h`
  and check it rather than guessing: `node scripts/check-deck.mjs your-deck.json` prints
  `limit N <= row capacity M` for every grid in the deck. In the worked example an 8-row grid is
  `h: 312` (capacity 8) and an 11-row grid is `h: 380` (capacity 11). A caption row is reserved
  **unconditionally**, so a snug frame still shows a thin empty band at the bottom.
- Omit `align` on a column and it is derived from the data — numbers right, everything else left.
  A column formatted to a string in SQL (e.g. `printf('%.1f%%', …)`) is text, so set `align`
  explicitly if you want it right. Formatting decimals in SQL is usually better than leaving them
  to `format`: JavaScript renders `6.0` as `6`, and a column of `9.3 / 6 / 5.9` reads as a bug.
- `format: "percent"` **multiplies by 100 and shows no decimals** (`0.093` → `9%`). Feed it a
  fraction, not a percentage.
- Both `chart` and `sqltable` are "live SQL" (`isLiveSQL`), so both join present mode's query pool
  and both are deduplicated by SQL text: one statement shared by a chart and a grid runs once.

---

## 3. The overrides bag — the deck half

The v1 six (`v`, `_base`, `patch`, `deleted`, `added`, `page`) keep their exact meaning. A deck adds
four, and no others are accepted:

```
{
  "v": 2, "_base": 1,
  "patch": { … }, "deleted": [ … ], "added": [ … ], "page": { … },

  "slidePatch":    { "slide-3": { "name": "Q3", "notes": "…", "hidden": true, "background": "#fff" } },
  "addedSlides":   [ { "id": "new-slide-1", "background": "#fbf7f0" } ],
  "deletedSlides": [ "slide-2" ],
  "slideOrder":    [ "slide-1", "new-slide-1", "slide-3" ]
}
```

- **`slidePatch`** — shallow patch per slide. Patchable keys are `name`, `background`, `notes`,
  `hidden`; **never `id`**, which is the identity every other pointer uses. The target must be a
  *live* slide (a base slide not in `deletedSlides`, or an `addedSlides` id). The merged record goes
  through the same validator the scene's slides do, so a patch cannot type-corrupt a field the
  scene shipped valid.
- **`addedSlides`** — new slide records, ids matching `/^new-slide-\d+$/`, unique, colliding with
  nothing in the one namespace. **Metadata only**: a new slide's elements ride the existing `added`
  array with `slide` pointing at the new-slide id. A layout stamped onto a new slide is therefore
  ONE commit and ONE undo step — the record and its elements are two keys of one bag.
- **`deletedSlides`** — live slide ids, no duplicates. **Deleting a slide deletes its elements
  implicitly**; the bag does not have to list them in `deleted`, and merge/bake drop them. Deleting
  every slide is refused at the Save boundary (a deck keeps ≥ 1 slide); the editor's filmstrip is
  what stops it happening in the first place.
- **`slideOrder`** — a **full permutation** of the live slide id set (base minus `deletedSlides`,
  plus `addedSlides`). Not a prefix, not a subset, no duplicates. A full order makes a reorder cost
  O(bytes) and makes a stale order a loud error instead of a silent drop. This is the one rule
  where runtime and server legitimately disagree: the editor **ignores** an invalid order and keeps
  rendering (`slidesOf`), the Save boundary **fails** on it (`slidesOfStrict`).

### What each deck key costs in bytes

The bag ceiling is **65,536 bytes** (64 KiB) — the dive-state cap, the editor's
`SAVE_OVERRIDE_MAX_BYTES` and the save Flight's `MAX_OVERRIDE_BYTES`, all the same number. Measured additions to an otherwise-empty
bag (`JSON.stringify` byte length):

| edit | bytes |
|---|---|
| `deletedSlides`: delete one slide | **27** |
| `addedSlides`: one bare new slide | **36** |
| `addedSlides`: one with a layout's `background` | **59** |
| `slidePatch`: `hidden: true` | **40** |
| `slidePatch`: rename (`"Q3 review"`) | **45** |
| `slidePatch`: `background` | **49** |
| `slidePatch`: 200 characters of `notes` | **237** |
| `slideOrder`: 8-slide deck | **94** |
| `slideOrder`: 60-slide deck | **665** |
| `patch`: move one element to another slide | **40** |
| `patch`: one `build` step | **32** |
| `patch`: clear a `build` step | **35** |

Two consequences worth planning around. **`slideOrder` is the only deck key whose cost grows with
the deck**, because it is a full permutation — a 500-slide deck spends about 5.5 KiB of the 64 KiB
on a single drag, which is affordable but no longer free. And **`notes` are the one unbounded deck
edit**: prose is charged by the character, so a session that rewrites the notes on twenty slides
can spend more of the bag than every geometry edit in the deck put together. Everything else is a
few dozen bytes, and `prunePatch` drops any patch equal to the base value on commit, so an edit
that is undone by hand costs nothing.

(Incremental cost inside an existing patch entry is smaller still: adding `,"zebra":false` to a
patch that is already there is 14 bytes. The flat `sqltable` keys exist for that reason — a chart
tweak re-emits the whole `chart` object.)

### Effective slide list (`slidesOf`)

One function, shared by runtime and bake, so the editor and the server cannot disagree:

1. start from `scene.slides` **in array order**; drop ids in `deletedSlides`;
2. append `addedSlides` in bag order, same deletion pass;
3. shallow-merge `slidePatch[id]` into each survivor (never `id`);
4. reorder to `slideOrder` when it is a full permutation — otherwise **ignore** it (runtime) or
   **fail** (bake);
5. the result must be non-empty (bake).

A **stale bag** (`_base !== scene.version`) loses its deck edits exactly as it loses its element
edits: `slidesOf` returns `scene.slides` verbatim.

### Bake

`bakeScene` does everything v1 does, plus: writes the effective `slides` into the baked scene in
deck order; permanentizes `new-slide-N` → `slide-N` (next free suffix) and rewrites every element's
`slide` pointer through the same id-map machinery elements use; drops elements whose slide vanished
before the empty-group cascade, so a group left childless by a slide deletion goes too; renumbers
leaf `z` by `(slide deck position, z)`; and reports `slides`, `slidesAdded`, `slidesDeleted` in
`summary` (both counts are **net**, so adding then deleting the same new slide is 0 and 0). A
separate `slideIdMap` carries slide renames — mixing two namespaces into one map would make it
ambiguous. Failure codes are unchanged: `INVALID_SCENE`, `INVALID_OVERRIDES`, `STALE_BASE`,
`PAYLOAD_TOO_LARGE`.

---

## 4. Two things that are DERIVED, not stored

Both are surprising enough to state plainly, and both add **zero schema keys** — which is why they
exist in this shape at all. The text key set is generated from `merge-core.mjs` and is byte-identical
across both templates and the core inlined in every assembled dive (which the save Flight bakes
with), so a new key would be a lockstep change before a dive using it could save.

### Lists live in `level`

`level` already picks a text element's block type. `"ul"` and `"ol"` are two more values of that one
key, beside `h1`/`h2`/`h3`/`p`:

```
{ "type": "text", "level": "ul", "fontSize": 18, "h": 300,
  "text": "Noise\n\tresidential and street, 12.5% together\nHousing heat and plumbing\n\tthree separate labels, 11.4%" }
```

- **Indent is leading TABS, one tab per level**, up to 8 deep. A leading *space* is content, so a
  line aligned by eye is not silently promoted. While editing, Tab / ⇧Tab indent and outdent every
  line the selection touches.
- **Markers are never in the string.** `ul` cycles `• ◦ ▪` by depth; `ol` cycles
  decimal → lower-alpha → lower-roman by depth, and numbering restarts correctly when you return to
  a shallower level. Stored glyphs would be typeable by accident and, for numbers, stale the moment
  a line moved.
- A list takes **body metrics** unless `fontSize` / `weight` say otherwise — `level` is one key, so
  "an h2 that is also a bulleted list" is unrepresentable by construction. Set `fontSize`
  explicitly on a list you want larger.
- The indent step is `1.6em` and the marker column `1.15em`, so a list **scales with autofit**.

### Code snippets live in `level` too

`level: "code"` makes a text element a **copyable code snippet**: monospaced (JetBrains Mono, then
the platform mono stack), default 18 px at line height 1.5, with a **copy-to-clipboard button in its
top-right corner**. The element keeps a 40 px right gutter so text never runs under the button. It
is a value of the existing key, so it needs no new scene key, no merge-core change and no new save
Flight. The inspector's level control offers it as `</>`.

- The button copies `text` exactly, newlines included. Give each runnable command its own element,
  so one click copies one thing a reader can paste (a macOS and a Windows variant are two snippets).
- It works in the editor, in present mode, and inside the Dive Gallery page and its embed. It tries
  `navigator.clipboard.writeText` first and falls back to `document.execCommand("copy")`, because a
  Dive is always framed and a host need not grant `clipboard-write`. The icon turns into a check
  mark on success.
- In present mode only the button on the slide on screen, with its build step revealed, takes the
  click. The click never advances the slide. Thumbnails draw the button but it is inert.
- The element draws no window of its own. Put it on a `shape` (white fill, 2 px ink stroke) with an
  ink shadow shape behind it, and size the shape at `26 + 27 × lines` px tall for the 18 px default.

### Links live in `level` too

`level: "link"` makes a text element a **clickable link**: its `text` is the URL, drawn underlined
(default 24 px, weight 600) and opened in a new tab. Only `http://` and `https://` URLs become links;
anything else renders as plain text. In present mode, the published view and the gallery, a click
opens it without advancing the slide; on the editor canvas a click selects the element instead. In
the MotherDuck app the host first shows its own "Open external link?" confirmation with the URL.

### Autofit is what a fixed height MEANS

For a `text` element, `h` carries the whole decision in the two states one key can hold:

| `h` | behaviour |
|---|---|
| `"auto"` | the BOX grows to the text. Text's default, and what v1 recommends everywhere. |
| a number | the TEXT shrinks to the box. **Shrink-only** — text that already fits keeps its authored size. |

There is no third state: "fixed height, let it overflow" is not expressible, and that is the trade
the feature makes. The scale comes from a fixed eleven-step ladder
(`1, 0.94, 0.88 … 0.46, 0.40`), measured all at once and picked by index — the largest step that
fits wins, and hitting the 40% floor is a **reported** state, not a quiet success (the inspector
says `Shrunk to 40% — 7.2px (minimum)`). The settled step is **ephemeral**: it is a measurement of
the current viewport, never an edit, so it never enters the override bag.

Authoring consequence: give a text box a numeric `h` when you want a region that will not reflow the
slide under it (a body column, a list beside a chart), and `"auto"` for a title or a caption whose
size must not change. `scripts/check-deck.mjs` lists every autofitting box and its base size; the
step itself can only be read in the browser.

---

## 5. Caps that actually bite

| cap | value | where |
|---|---|---|
| slides per deck | **500** | `scene.slides`, and `scene.slides + addedSlides` after merge |
| elements per scene | **5,000** | `scene.elements`, and `+ added` after merge |
| build step | **1..999** | scene, `added` and patched elements alike |
| `sqltable` / `table` rows drawn | **1..200** | `limit`; also the manual table's row count |
| `sqltable` columns configured, `table` columns | **40** | `columns` key count / `cells` width |
| group nesting depth | **24** | `assertSafeJson`, and the empty-group walk |
| any single string | **256 KiB** | `assertSafeJson` — the real guard against a structure attack |
| override bag | **65,536 B** | dive state, the editor's Save check, and the save Flight, all the same number |
| assembled `.jsx` | **warn 768 KB, hard 896 KB** | `slides/assemble.js`; see below |

The two that bite first in practice are the **64 KiB bag** (see the byte table above) and the
**assembly size bands**. The bands are `1024 KB` (the save Flight's `MAX_SOURCE_BYTES`, checked
twice — on the source it fetches and again on the bake it is about to write) minus `128 KB` of bake
headroom. That headroom is a **documented heuristic for the ordinary case, not a bound**:
the save Flight's scene serialization rewrites `<`, `>` and `&` as their six-character `\uXXXX` escapes, so a
legal 64 KiB bag of `<` inflates SIXFOLD and can cross the ceiling from under the band. What makes that acceptable is
that the real guarantee is elsewhere and fails closed — the Flight exits 5 (too large) with
no write attempted, and the author loses that one bag of edits, not the dive.

For scale: the slides framework alone is ~520 KB, and the worked example deck (8 slides, 64
elements, 27 KB of scene JSON) assembles to **598 KB** — comfortably inside the warning tier. A
deck large enough to threaten 768 KB is a deck of several hundred slides.

---

## 6. Present mode — what an author needs to predict

Present mode **is** the published view of a deck: one slide, fit-and-letterboxed to the host
viewport, with a counter and nav chrome that dim until the pointer is on them. A deck has exactly
TWO surfaces — present mode and the editor — so Esc (or the top-left **Exit Presentation** control)
lands in the **editor**, seated on the slide that was on screen. Keys, in present mode:
`→ ↓ PageDown Space` advance, `← ↑ PageUp` retreat, `Home`/`End` jump to the first/last presentable
slide, `Esc` leaves for the editor.

Advance and retreat walk **build steps first, then slides**. Retreating into a slide seats the
cursor at its *last* step, so backing up shows the slide as the audience last saw it.

**Hidden slides are skipped, and the counter proves it.** `presentCounter` counts only visible
slides, so a deck of 8 with one hidden reads `1 / 7` … `7 / 7`, and the hidden slide reads `–` if
you ever land on it. A hidden slide is still reachable deliberately — "Present from this slide" in
the editor opens on whatever slide the author was editing, flag or not — and its builds work
normally there. Its queries are otherwise never run, because present mode cannot navigate to it.

**Number your own corner footers by presentation position, not array index.** In the worked example
the hidden backup slide is array position 7 of 8 and its footer reads `backup`, while the closing
slide (array position 8) reads `7 / 7` — matching the chrome counter.

### The query admission budget

Three constants govern what runs and what draws:

- **`PRESENT_PREFETCH_MAX = 24`** — the *want set*: unique SQL statements present mode intends to
  run, deduplicated by text, ordered **nearest-first** from the cursor, hidden slides skipped. The
  shell recomputes this from the live cursor on every navigation, so a statement is inside the cap
  whenever its own slide is anywhere near where the presenter is.
- **`PRESENT_INFLIGHT_MAX = 4`** — of those, how many may be in flight at once. The reason is
  measured: firing 24 statements at a connector that serialises one connection puts the chart in
  front of the presenter behind 23 others. The admitted list is append-only and sticky — nothing
  already run is ever re-queued, and a revisit is warm.
- **`PRESENT_MOUNT_RADIUS = 1`** — which slides actually **mount** their charts (active ± 1 over
  the reachable order). A slide outside the window has no DOM at all, so a long deck does not pay
  for a Recharts tree per chart.

**What a viewer sees during a slow query:** the element's own loading state — a pulse in place, at
the element's authored size and position, with navigation never blocked. A statement queued behind
the budget is indistinguishable from one that is running, deliberately: both are honestly
"not here yet". A leaf still waiting for its **build step** is mounted at `opacity: 0` rather than
omitted, precisely so its query has settled by the time the click arrives and the reveal has
something to fade from. An error draws the element's error state; it does not take the slide down.

Practical rule: a deck whose every slide carries a distinct 10-second query will feel slow no matter
what, because 4 run at a time. Aggregate in SQL (as `reference.md` requires anyway) and **reuse the
same statement text** across slides where you can — the pool dedupes by text, so a KPI query
repeated on five slides is one query.

### One transition

Exactly one: a 220 ms crossfade on the **outgoing** layer only (the incoming slide is already at
full opacity underneath, so the fade never dips through the backdrop). A build reveal fades the
revealed elements over the same duration; a navigation commit is instant.

---

## 7. Slide design conventions

A hand-authored deck should sit beside a **stamped** one — a slide the editor's layout picker
produced — without looking pasted in. These are the layouts' own numbers, in the 1280 × 720 logical
space, so matching them is what makes the two indistinguishable. (`reference.md`'s two-colours-plus-
one-accent rule, its no-card-chrome rule and its group/pair rules all still apply.)

**Grid**

- side margins **96**; full-width content column **1088**
- two columns: **520 + 48 gutter + 520** (`96 + 520 + 48 + 520 + 96 = 1280`)
- body measure **880**, not the full column — 1088 px at 20 px is ~88 characters a line
- vertical rhythm in multiples of 8

**Type scale** (the deck's, not v1's — slides are read from further away)

| role | size | colour |
|---|---|---|
| title / section-header h1 | **54** | ink `#231f20` |
| content-slide heading h2 | **38** | ink |
| title-slide subtitle | 22 | muted `#6a6a6a` |
| body, one column | 20 | ink |
| body, two columns | 18 | ink |
| kicker / caption | 13–14 | accent `#0777b3` / faint `#9a9aa3` |
| corner footer | **14**, right-aligned | faint `#9a9aa3` |

Colours: ink `#231f20`, muted `#6a6a6a`, accent `#0777b3`, faint `#9a9aa3` (footers only), and one
tint `#fbf7f0` for a slide that is a different KIND of slide (a section header). Annotation red
`#bd4e35` as in v1.

**The rule drop.** An accent rule under a heading sits **60 px below the heading's `y`** — an h2 at
`y: 72` puts its rule at `y: 132`. That gap, not the 8 px grid, is what puts a stamped slide in
register beside an authored one, so the rule is deliberately *not* snapped to the rhythm. Rules are
`x: 96, w: 96, h: 8, thickness: 3` in the accent colour (`h: 8` is hit area, so the 3 px bar stays
clickable).

**The corner footer.** `x: 1096, y: 600, w: 100, h: "auto"`, `fontSize: 14`, `align: "right"`,
colour `#9a9aa3`. Right-aligned in its slot so it reads as a page number however long the text is.
Every layout except Blank stamps one; a slide without one is the odd slide out.

**The five layouts, exactly** (`SLIDE_LAYOUTS`, in picker order) — crib these `y` values:

| layout | elements |
|---|---|
| **Blank** | nothing (byte-for-byte the pre-layouts "new slide") |
| **Title slide** | h1 54 @ y 248 (w 1088, auto) · subtitle p 22 @ y 336 (w 880, auto) · rule @ y 408 · footer |
| **Title and content** | h2 38 @ y 72 · rule @ y 132 · body p 20 @ y 176 (w 880, **h 472** — a fixed box, so it autofits) · footer |
| **Two content** | h2 38 @ y 72 · rule @ y 132 · left p 18 @ y 176 (w 520, h 472) · right p 18 @ x 664, y 176 (w 520, h 472) · footer |
| **Section header** | h1 54 @ y 296 (w 1088, auto) · rule @ y 376 · footer — **and the slide record carries `background: "#fbf7f0"`** |

A layout is a **stamp, not a live link**: it emits ordinary elements into a new slide and is then
forgotten. Nothing records which layout a slide came from, and every element it produced is
selected, moved, restyled and deleted like any other. Layouts stamp **flat, never grouped** — a
grouped placeholder would select the group on click and the one-click-to-type caret could never
fire — so a hand-authored slide is the place to use the nesting `reference.md` asks for.

**Grouping, for a deck.** `reference.md`'s rules hold, with two additions: a group and all its
descendants must be on **one slide**, and `z` should be numbered **slide by slide in deck order**,
group-contiguous within each slide. A good slide's layers tree reads as an outline of that one
slide — heading, rule, `Table: …` or `Chart: …` sub-group with its caption, `List: …` sub-group with
its lead, footer.

---

## 8. Authoring checklist for a deck

Beyond `reference.md`'s pre-save checklist:

- `SCENE.v` is `2`; `slides` is present and non-empty; **no** element is missing `slide`.
- Every `slide` names a slide in `slides`; every group's descendants share its `slide`.
- Slide ids do not collide with element ids (one namespace).
- `z` is unique across leaves, numbered slide by slide in deck order, group-contiguous.
- Text: `"auto"` where the box should grow, a **number** where the text should shrink. Lists use
  `level: "ul"` / `"ol"` with tab indents and no marker glyphs in the string.
- Every `chart` and `sqltable` SQL has been **run**, and every `x.key`, `series[].key` and
  `columns` key is a real result column.
- Every `sqltable`'s `limit` is within its box's row capacity, and its columns fit.
- Build steps are integers ≥ 1 on **leaves only**; steps that should arrive together share a value.
- Every slide has `notes` if a human will present it, and the hidden slides are the ones you meant.
- Footer text matches the **presentation** position (hidden slides do not count).

Run it:

```bash
node scripts/check-deck.mjs path/to/deck.json
```

which validates the scene, proves `bakeScene` is a fixed point on it (so the deck is already in the
shape a save would leave it in, and the authored `z` survives the renumber), checks group
z-contiguity, checks every `sqltable` against its box, prints the visible-slide walk, the counter,
the build steps per slide and the query want-set, parses every list, and lists the autofitting
boxes.
