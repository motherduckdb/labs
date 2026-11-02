---
name: editable-dive
description: Create a MotherDuck Dive with a built-in visual editor — either a single-canvas, Figma-like dive (`template.jsx`) or a Google-Slides-like multi-slide DECK (`template-slides.jsx`) with a filmstrip, five layouts, speaker notes, build steps, live-SQL tables and a present mode. Text is editable in place, every element is movable/resizable/reorderable, chart and table SQL is runnable/editable in a right-hand inspector, and viewers get a clean published view. Use when asked for an "editable dive", a "dive with an editor", a "canvas dive", a "slide deck dive", a "presentation dive", "slides", or to "bake back" browser edits into a dive.
---

# Editable Dive

An editable dive is a single JSX dive built from one of this skill's two templates. Both render a
declarative `SCENE` (pure JSON baked into the source) and share one merge/bake core, one override
bag and one Save service.

| | `template.jsx` — **canvas** | `template-slides.jsx` — **deck** |
|---|---|---|
| Scene schema | `v: 1` | `v: 2` — adds `slides[]`, a required `slide` on every element, `build`, `sqltable` |
| Published view | one long scrolling page, scaled to the width | **present mode**: one slide fit-and-letterboxed, arrow keys, build reveals, Esc to the editor |
| Editor | layers tree · canvas · inspector | the same, plus a **filmstrip** (slide CRUD, drag-reorder, layout picker) and a speaker-notes strip |
| Extra authoring | — | five layouts, per-slide background/notes/hidden, lists (`level: "ul"`/`"ol"`), autofit, live-SQL tables |
| Reference | `reference.md` | `reference.md` **and** `reference-deck.md` |
| Workflow below | **A** | **A-DECK** |

Pick the deck when the ask mentions slides, a presentation, or "one idea per screen"; pick the
canvas when it is a report or a dashboard that should scroll. Everything below that is not marked
deck-only applies to both.

In a **canvas** dive, viewers see a
clean **published page** (scaled to 100% of the screen width); a floating **Edit toggle**
(bottom-right, shown in the off position) opens the **editor** — left layers tree, center
canvas, right inspector — where the same toggle, now on, sits in the toolbar to switch back. Edits (move, resize, z-order,
text, colors, chart SQL, full chart reconfiguration) are stored as sparse overrides in
`useDiveState("ov")`. A Save-enabled scene carries its own `diveId`; the editor's **Save** link
hands the in-memory override bag to the trusted Save service in a URL fragment, then MotherDuck
OAuth performs the server-side bake-back. **Copy JSON** remains the manual fallback.

In a **deck** there are exactly TWO surfaces and no third: the published view IS present mode, and
Esc (or the top-left **Exit Presentation** control) lands in the **editor**, seated on the slide that
was on screen. The editor's own **Present** button goes back, from the slide being edited. There is
no floating Edit toggle on a deck, because there is no third surface to toggle to. The override bag
and Copy JSON are identical to the canvas, but **a deck saves through a MotherDuck Flight**, not the
Save service: edits batch in the bag, the top bar's Save button (pinned right, with a count of batched
edits) opens a confirmation, and confirming runs the save Flight (`flight/save_deck.py`) via
`useRunFlight` with the whole bag. The Flight bakes it with the merge core inlined in the live source,
writes a new Dive version, and MotherDuck reloads the Dive onto it. Saving needs ownership of, or a
`RUN` grant on, that Flight; anyone else can edit locally and use Copy JSON. See "Deck Save Flight" in
Workflow A-DECK.

Files in this skill:
- `template.jsx` — the complete **canvas** editor framework (`v: 1`). **Copy it verbatim and patch
  ONLY the two sentinel regions** (`REQUIRED_DATABASES` between `__DBS_START__/__DBS_END__`, and
  the scene between `__SCENE_START__/__SCENE_END__`). Never re-author or reformat the framework.
- `template-slides.jsx` — the complete **deck** editor framework (`v: 2`): the same framework plus
  slides, a filmstrip, layouts, notes, build steps, `sqltable`, present mode and Flight-based Save.
  THREE sentinels — the two above plus `SAVE_FLIGHT_ID` between
  `__SAVE_FLIGHT_START__/__SAVE_FLIGHT_END__` — same rule: patch those regions and nothing else.
- `flight/save_deck.py`, `flight/requirements.txt` — the deck save Flight (one per owner, shared by
  all of that owner's decks; see "Deck Save Flight").
- `reference.md` — normative `v: 1` scene/overrides schema, per-type element props (including
  `sqltable`), chart config, design rules, and the annotation pattern. Read it before authoring
  any scene.
- `reference-deck.md` — normative **deck** (`v: 2`) schema: `slides[]`, the required `slide` key,
  `build`, the four deck-only bag keys and their byte costs, lists and autofit, the caps, present
  mode's behaviour, and the layouts' own design conventions. Read it *with* `reference.md` before
  authoring a deck.
- `merge-core.mjs` — dependency-free runtime merge plus strict server bake, for **both** schemas.
  It is the canonical source for the generated region in both templates and for the Save service;
  do not copy-edit any output.
- `scripts/sync-merge-core.mjs` — regenerate/check the inline copy in both templates after core
  changes.
- `scripts/check-deck.mjs` — author-side checker for a deck scene: validates it, proves `bakeScene`
  is a fixed point on it, checks group z-contiguity, checks every `sqltable` against its box, and
  prints the present-mode walk, build steps, lists and autofit boxes. Self-contained (bundles the
  template with `npx esbuild`).
- `examples/sample-scene.json` — a worked `v: 1` scene: layout coordinates, two charts, chart
  annotations.
- `examples/sample-deck.json` — a worked **deck**: 8 slides on `sample_data.nyc.service_requests`
  with groups, a chart, two `sqltable` grids, build steps, speaker notes, a per-slide background, a
  hidden backup slide and both list kinds. Crib coordinates from it.

## Workflow A — Create a CANVAS editable dive (`v: 1`)

1. **Explore the data.** Use the MotherDuck MCP tools (`list_databases`, `list_tables`,
   `query`) or the DuckDB CLI to understand the schema and find what is interesting. Note the
   exact database name and, for shares, the share URL from `list_databases` (needed for
   `REQUIRED_DATABASES`). Shares owned by other orgs (e.g. `sample_data`) do NOT appear in
   `LIST SHARES` — the share-update-mode check doesn't apply to them; just take the URL from
   `list_databases`.

2. **Write and TEST every chart SQL.** One query per chart, fully-qualified double-quoted
   names (`"db"."main"."table"`), numerics `CAST(... AS DOUBLE)`, dates pre-formatted and
   pre-sorted with `strftime`, gaps filled with a `generate_series` spine, results aggregated
   small — **≤ ~60 rows per chart, decided BEFORE writing the query** (scatter plots: never
   raw entity-level rows; aggregate to a coarser grain like country/category first). Run each
   query via the MCP `query` tool and confirm the column names — the chart config's `x.key`
   and `series[].key` must match them exactly. Also SANITY-CHECK the values, not just the
   shape: real datasets carry artifacts (bulk-defaulted midnight timestamps, sentinel dates,
   legacy records) that silently corrupt an aggregate — eyeball any bucket that looks
   implausibly large before charting it.

3. **Author the scene.** Read `reference.md` (schema + design rules) and crib coordinates
   from `examples/sample-scene.json`. Plan the page like an editorial report: title + dek +
   accent rule, KPI row, 2–4 charts with h2 section heads, annotation elements calling out
   the specific findings you discovered in step 1. Validate your scene JSON:
   `node -e 'JSON.parse(require("fs").readFileSync("scene.json","utf8"))'`.

   **Organize the scene into NESTED groups as you author it** — a flat element list is a
   defect, and a 2-level tree is the minimum, not the goal. Add
   `{"id": "group-N", "type": "group", "name": "…", "parent": null}` elements and point each
   member (leaves AND other groups) at one with `parent`:
   - Top level: a title block group, the KPI row group, one group per section, a footer
     group.
   - **Pair rule**: an item and its label/caption always form their own small group — each
     KPI's value + label is a pair group nested inside the KPI row group (a group of
     groups), a footer rule + footer text pair inside the footer group, an image + its
     caption, etc. Anything that should move as one unit is one group.
   - Inside each section group: the section heading/dek as direct leaves, plus **one
     sub-group per chart holding that chart together with ALL of its annotations** (note
     texts, pointer lines, tint bands) — name it `"Chart: …"`. Side panels get their own
     sub-group. A bare chart with no companions may stay a direct child.
   - Result: sections that contain charts produce a hierarchy ≥3 levels deep
     (section → chart group → leaves). Groups nest arbitrarily — groups of groups are
     expected, not exceptional.
   Groups carry no geometry — the editor derives their bounds from their members — but a
   group's descendant leaves must stay contiguous in `z`, so number `z` sub-group by
   sub-group. The layers tree orders TOP-LEVEL rows by vertical canvas position (reading
   order), so top-level groups should correspond to vertical bands of the page. See
   "Authoring rules for groups" in `reference.md`.

4. **Assemble the dive file.** Copy `template.jsx`; replace the scene between the
   `__SCENE_START__`/`__SCENE_END__` sentinels with `const SCENE = <your JSON>;` and set
   `REQUIRED_DATABASES` between `__DBS_START__`/`__DBS_END__`, e.g.:
   ```jsx
   export const REQUIRED_DATABASES = [
     { type: "share", path: "md:_share/sample_data/<uuid>", alias: "sample_data" },
   ];
   ```
   The `alias` must equal the database name used in your SQL.

5. **Images (only if needed).** No external image URLs work in a dive. Load assets into a
   MotherDuck table first (`CREATE TABLE "<db>"."main"."dive_assets"(name VARCHAR, src VARCHAR)`,
   `src` = `data:image/...;base64,...` text), set `scene.images.sql` to select `name, src`
   from it, and reference them by `imageKey`. Skip images entirely when the data doesn't
   need them.

6. **Create the dive.** Either via MCP `save_dive` (pass the full file as `content`), or via
   the DuckDB CLI (get a token with the `get_short_lived_token` MCP tool). IMPORTANT: also
   pass `required_resources` — the platform does NOT lift the in-source `REQUIRED_DATABASES`
   into its resource grants on CLI create/update, and a dive shipped with empty resources may
   fail for viewers who don't already have the database attached:
   ```bash
   export motherduck_token='<token>'
   duckdb md: -c "SET VARIABLE c = (SELECT content FROM read_text('dive.jsx')); SELECT * FROM MD_CREATE_DIVE(title := '<title>', content := getvariable('c'), description := '<desc>', api_version := 1, required_resources := [{'url': 'md:_share/sample_data/<uuid>', 'alias': 'sample_data'}]);"
   ```
   (Same parameter on `MD_UPDATE_DIVE_CONTENT`.) Verify afterwards that
   `version_required_resources` in the result is not `[]`.

   To enable the in-editor Save link, put the returned canonical UUID in top-level
   `SCENE.diveId`, reassemble, and update the new Dive once with the complete fetched
   `version_required_resources`. The public Save service accepts any syntactically valid Dive UUID
   as routing data, then uses the caller's short-lived credential to fetch the Dive, require its
   derived organization in the configured org set, and require fetched `owner_id` to equal the
   credential `userId`. A UUID in source is routing data, not authorization.

7. **Verify.** (`view_dive` returns the full source and can overflow tool-output limits —
   don't rely on it for confirmation.)
   - Round-trip: re-download via `MD_GET_DIVE` and diff against your local file (byte-identical).
   - Re-run every chart SQL via the `query` tool and confirm each result column named in
     `x.key`/`series[].key` is present.
   - Best: run the dive in the local harness (scaffold `.dive-preview/` per the MCP
     `get_dive_guide` "Local Preview Setup"; the shim there may lack `useDiveState` — if so,
     add a minimal one to `src/md-sdk.tsx`: `useState` with a leading key arg, persisting the
     bag to `location.hash` as `#state=base64url(JSON)`), open it in a browser, and check the
     published view, the editor, and the console for errors.

### Pre-save checklist (all must pass)

- Single default-export function component; no new imports beyond the template's.
- SCENE is pure JSON between its sentinels (JSON.parse-able; no expressions/comments).
- Zero Tailwind bracket classes anywhere (`grep -n '\[' dive.jsx | grep className` → nothing).
- Every chart's `x.key`/`series[].key` matches a tested query's column names; numerics cast
  in SQL.
- Treat browser-edited chart `sql` as a normal sparse patch during bake-back. Do not remove or
  reconstruct it; failed drafts never enter the bag, while successful Run/blur edits do.
- `REQUIRED_DATABASES` alias matches the SQL database names; share paths from `list_databases`.
- Element ids unique; `z` values unique across leaves (gaps of 10); text elements use `h: "auto"`.
- Save-enabled scenes have a canonical UUID in top-level `SCENE.diveId`.
- Hierarchy: every `parent` references an existing group element, no parent cycles, no empty
  groups, and each group's descendant leaves are contiguous in the global `z` order.
- File under 896 KB. That is the Save service's `MAX_SOURCE_BYTES` (1 MB, checked on both the
  fetched source and the baked output) minus 128 KB of headroom for the growth baking adds.
  `assemble.js` warns from 768 KB so the growth is visible before it is fatal. The 128 KB is a
  **documented allowance for the ordinary case, not a bound**: scene serialization rewrites `<`,
  `>` and `&` as six-character `\uXXXX` escapes, so a legal 64 KB bag of `<` inflates sixfold and
  can cross the ceiling from under the band. That save fails closed (`SOURCE_TOO_LARGE`, no write
  attempted); nothing is corrupted and the author loses that one bag.
- The Save service **refuses to write an element type the fetched source cannot render**
  (`DIVE_SOURCE_OUTDATED`, HTTP 409, no write attempted). A Dive assembled before `sqltable`
  existed therefore cannot be saved with one in it — re-assemble it from the current template
  first. `https://save-editable-dive.vercel.app/api/health` reports the service's
  `patch_key_allowlist` fingerprint (`patchKeyAllowlistFingerprint()`, currently **`7916132d`**),
  which is the stale-deploy signal: it covers **every** type's patchable key set in
  `merge-core.mjs`, deck-only types and keys included, so it moves whenever either template's
  schema does and must match the local core. Do not confuse it with the same endpoint's
  `organization_allowlist.fingerprint`, which is about the org allowlist and nothing else.

## Workflow A-DECK — Create a SLIDES DECK dive (`v: 2`)

Everything in Workflow A applies; this is what is different. **Read `reference-deck.md` first** —
it is the schema, and the steps below assume it. Crib coordinates from
`examples/sample-deck.json`, which is a real 8-slide deck on `sample_data.nyc.service_requests`.

1. **Explore the data, and find a STORY, not four facts.** A deck is linear: one idea per slide,
   in an order that earns the next slide. Before authoring anything, write the spine as a list of
   slide titles and check that each one is a claim the data supports. The worked example's spine is
   *32 million complaints → it is the city's biggest feed → the channel switched → here is the
   chart → here is what people report → here is how fast it closes → the door moved, the queue did
   not.*

2. **Write and TEST every query** — the same rules as Workflow A step 2, for `chart` **and**
   `sqltable` elements. Extra deck-specific points:
   - Both types are "live SQL" and both join present mode's query pool. The pool **deduplicates by
     SQL text**, so reusing one statement across slides costs one query. Only 4 run at a time
     (`PRESENT_INFLIGHT_MAX`), so a deck of distinct slow queries feels slow no matter what.
   - A `sqltable` is a grid of live rows. Format decimals **in SQL** (`printf('%.1f', x)`) rather
     than leaving them to the `format` key: JavaScript renders `6.0` as `6`, and a column reading
     `9.3 / 6 / 5.9` looks like a bug. Set `align: "right"` explicitly on a column you formatted to
     a string, since the automatic right-alignment is derived from numeric values.
   - `format: "percent"` multiplies by 100 and shows no decimals — feed it a fraction.
   - Shorten a long label in SQL (`CASE complaint_type WHEN … THEN …`) rather than letting the grid
     ellipsize it: `sqltable` columns divide the element width equally and cannot be re-weighted.

3. **Author the deck.** A deck scene is a `v: 1` scene plus `slides[]` and a required `slide` on
   every element (groups included). Per-slide `name`, `background`, `notes` and `hidden` live on the
   slide record, `build` on leaves.
   - **Match the layouts' own geometry** so a hand-authored slide sits beside a stamped one:
     1280x720, 96 px margins, the 1088 column or 520+48+520 halves, an 880 px body measure, h1 54 /
     h2 38 / body 20 (18 in two columns), an accent rule 60 px below its heading, and a 14 px
     right-aligned corner footer at `x: 1096, y: 600, w: 100`. Full table in `reference-deck.md`.
   - **Group per slide, and number `z` slide by slide in deck order** — group-contiguous within each
     slide, `10, 20, 30…` across the whole deck. Get this right and `bakeScene` is a no-op on `z`.
     A group and all its descendants must be on ONE slide.
   - **Speaker notes are where the queries and the numbers go.** Put the statement, the figures you
     are asserting on the slide, and the reason for any window or exclusion into `notes`. That is
     what makes the deck presentable by someone who did not build it — and it is also the only
     unbounded deck edit, charged by the character against the 64 KB bag.
   - **Number the corner footers by PRESENTATION position.** Hidden slides do not count: present
     mode's counter shows only visible slides, so an 8-slide deck with one hidden reads `1 / 7`
     through `7 / 7`.
   - **Build steps**: give leaves that should arrive together the same integer; distinct values are
     distinct clicks, compacted (`1, 5, 9` is three clicks). Never put `build` on a group — a group
     row in the editor's Layers panel writes the step to every leaf under it. The editor's own
     writes renumber the slide to `1..N`, so authored gaps survive only until the first edit.
   - **Size every `sqltable` box to its rows.** The row capacity is deterministic from `h`; check it
     rather than guessing (step 4). A caption row is always reserved, so a snug frame keeps a thin
     empty band at the bottom.

4. **Check the deck before assembling:**

   ```bash
   node scripts/check-deck.mjs my-deck.json
   ```

   It validates the scene, proves `bakeScene` is a **fixed point** on it (so the deck is already in
   the shape a save leaves it in, and the authored `z` survives the renumber), checks every group's
   z-contiguity, checks every `sqltable`'s `limit` against its box's row capacity, and prints the
   presentable-slide walk, the counter, the per-slide build steps, the query want-set, every list's
   parsed markers and every autofitting box. Fix what it reports before going further.

5. **Assemble** exactly as in Workflow A, but from `template-slides.jsx`: copy it verbatim, replace
   the scene between `__SCENE_START__`/`__SCENE_END__` with `const SCENE = <your JSON>;`, and set
   `REQUIRED_DATABASES` between `__DBS_START__`/`__DBS_END__`, and `SAVE_FLIGHT_ID` between
   `__SAVE_FLIGHT_START__`/`__SAVE_FLIGHT_END__`. Nothing else in the file changes. This project
   keeps a harness that does it and checks the result:

   ```bash
   cd slides
   SAVE_FLIGHT_ID=<flight uuid> node assemble.js my-deck.json   # -> slides/dive.jsx
   ```

   `assemble.js` refuses to write unless the scene round-trips through `JSON.parse`, there are zero
   Tailwind bracket classes, `SCENE.diveId` is a syntactically valid UUID, and the file is inside
   the size bands. Expect ~600 KB for a deck of this size (the framework alone is ~520 KB).

6. **Create or update the Dive** as in Workflow A step 6 — same `MD_CREATE_DIVE` /
   `MD_UPDATE_DIVE_CONTENT`, same mandatory `required_resources`. This project's re-runnable push,
   which also enforces the two clobber guards below, is:

   ```bash
   export motherduck_token='<short-lived token>'
   cd slides && DECK=my-deck.json ./push.sh
   ```

   **Deck Save Flight.** Saves run a Flight the deck's owner owns, so set it up once per owner and
   reuse it for every deck (look for an existing `editable-deck-save` with `MD_LIST_FLIGHTS()` first):
   - Load the MCP `get_flight_guide` and `get_dive_guide` ("Changing data from a Dive") first.
   - Edit `flight/save_deck.py`: `MOTHERDUCK_HOST` is the deployment (staging or production), and
     `ALLOWED_DIVE_IDS` lists the decks it may write. Both live in source on purpose: a run's config
     is chosen by whoever starts it, and every run writes with the OWNER's token.
   - Create it once with config keys `DIVE_ID`, `BASE_VERSION`, `OVERRIDES` (all `''`) — a run can
     only pass keys the Flight already has — then `max_runtime_sec` ≈ 180. It logs every run to
     `editable_deck_saves.main.save_log` (create that database and table first; see the Flight).
   - Per deck: add the deck's id to `ALLOWED_DIVE_IDS`, push the Flight source
     (`MD_UPDATE_FLIGHT(..., source_code := …)`), and assemble the deck with `SAVE_FLIGHT_ID`.
   - Exit codes the dialog explains: 3 stale (someone saved first), 4 bake rejected, 5 too large,
     6 Dive not allowed. A save takes ~15–20 s, most of it package install.
   - For other people to save, recommend `GRANT RUN ON FLIGHT '<id>' TO …` and grant only on the
     user's confirmation.
   Worked example: `flight/save_deck.py`.

7. **Verify in BOTH tiers. Neither alone is enough** — and this is not optional ceremony, it is
   because each tier is blind to what the other sees.

   **Tier 1 — the local harness** (`http://localhost:5173/`, same-origin Vite). This is the only
   place the editor can be driven: `read_page`, `find` and dispatched DOM events all work. (The
   `slides/` and `.dive-preview/` paths in this step are **this project's** harness, not part of the
   skill. In another repo, scaffold an equivalent same-origin Vite page that renders the assembled
   `dive.jsx` and shims `useSQLQuery` / `useDiveState` — see Workflow A step 7 — or skip to Tier 2
   knowing the editor then goes unverified.)

   ```bash
   printf 'VITE_MOTHERDUCK_TOKEN=%s\n' "$motherduck_token" > .dive-preview/.env
   ./slides/smoke.sh my-deck.json          # assemble + start Vite, idempotent
   ```

   Walk the whole deck with `→`, and confirm **every feature the deck uses actually works**: each
   build step reveals what you meant it to (and elements sharing a step arrive together), the
   per-slide backgrounds paint, hidden slides are skipped and the counter matches your footers,
   every chart and `sqltable` draws live rows, lists show the right markers at the right depths,
   and the filmstrip, layers tree, speaker-notes strip and `sqltable` inspector all populate.
   Zero console errors.

   **Tier 2 — the real Dive.** In the MotherDuck app the dive runs in a **cross-origin iframe**, so
   extension automation cannot read its DOM and the editor cannot be driven there at all —
   screenshots and real key/mouse input only. What Tier 2 proves is that the same bundle survives
   the platform: the published view renders, live MotherDuck data arrives, present mode advances and
   reveals builds, and the stored source is byte-identical to local.

   ```bash
   duckdb md: -noheader -list -c "
   SET VARIABLE local = (SELECT content FROM read_text('dive.jsx'));
   SELECT format('stored={} local={} identical={}', strlen(content), strlen(getvariable('local')),
                 content = getvariable('local'))
   FROM MD_GET_DIVE(id := '<uuid>'::UUID);"
   ```

   Then open the dive URL, step through with `→` (present mode focuses its own root on mount, so
   arrow keys work without clicking first), and **hover over the dive before each screenshot** — the
   iframe often captures blank white for tens of seconds after a state change. Do **not** click
   Save during verification: a Save advances `SCENE.version` and puts live ahead of local.

### Pre-save checklist — the DECK additions

All of Workflow A's checklist still applies, with these changes and additions:

- `SCENE.v` is `2`, `slides` is present and non-empty, and **no** element is missing `slide`.
- Every `slide` names a slide in `slides`; every group's descendants share its `slide`; slide ids
  do not collide with element ids (one namespace).
- `z` unique across leaves, numbered **slide by slide in deck order**, group-contiguous within each
  slide. `node scripts/check-deck.mjs` proves it by showing the bake does not move it.
- **Text `h` is a two-state key here, not a recommendation.** `"auto"` grows the box to the text (as
  in `v: 1`); a **number** shrinks the text to the box (autofit, shrink-only, eleven fixed steps
  down to 40%). Use a number for a region that must not reflow the slide, `"auto"` for a title.
  There is no "fixed height, let it overflow".
- Lists are `level: "ul"` / `"ol"` with **leading tabs** for depth and **no marker glyphs in the
  string** — markers are derived and numbering is recomputed.
- Every `chart` **and** `sqltable` SQL tested; every `x.key`, `series[].key` and `columns` key is a
  real result column; every `sqltable`'s `limit` fits its box's row capacity.
- `build` values are integers 1..999 on **leaves only**; leaves meant to arrive together share one.
- Slide `notes` written for every slide a human will present; `hidden` set on exactly the slides
  meant to be skipped; corner footers numbered by presentation position.
- The deck-only keys (`slide`, `build`, `sqltable`, and the bag's `slidePatch` / `addedSlides` /
  `deletedSlides` / `slideOrder`) must **never** appear in a `v: 1` scene or bag. They are refused
  by the validator, not merely ignored — see `reference-deck.md` § 1 for why that is load-bearing.

## Workflow B — Save or manually bake back browser edits

**Decks** save through their Flight (above). What follows is the canvas (`v: 1`) Save service, and
the manual bake-back that works for both.

Preferred: click **Save** in edit mode, confirm MotherDuck's external-navigation dialog, complete
the MCP OAuth consent screen, review the confirmation page's target Dive and patched/added/deleted
counts, then click **Confirm and save**. The confirmation is a same-origin POST bound to the
encrypted session's CSRF token; the fragment only routes the handoff and is never treated as proof
of intent. `SCENE.version` is the replay nonce because every successful bake advances it. After the
verified result, use its link back. The link reads the
complete in-memory `useDiveState("ov")` value even when the parent URL contains a state reference.
It refuses stale, malformed, >64 KB, or >32,768-character launch payloads. Bags whose raw
base64url link fits take a fully synchronous path. Larger bags are prepared in the background with
`deflate-raw`; if the click's own blur changes the bag before that candidate is current, Save stops
and asks for one more click instead of launching stale edits. In practical terms the 64 KB handoff
cap now supports about **1,000 ordinary element position/size edits**. The Dive can request a new
tab but cannot learn whether the MotherDuck parent actually opened it.

Manual fallback input: the dive id plus overrides — preferably the JSON from **Copy JSON**;
alternatively a shared URL with an inline `#state=` bag.

If the URL holds a server-stored reference, open it and use Copy JSON; never attempt to resolve
the reference outside the Dive.

1. Download current source:
   ```bash
   duckdb md: -c "COPY (SELECT content FROM MD_GET_DIVE(id := '<uuid>'::UUID)) TO 'current.jsx' (FORMAT csv, HEADER false, QUOTE '');"
   ```
2. Import `bakeScene` from `merge-core.mjs`, extract the sentinel scene, and call it with the raw
   bag. Treat any validation or stale `_base` error as a stop; do not hand-reimplement the merge.
   One core handles both schemas: for a deck it also writes the effective `slides` in deck order,
   permanentizes `new-slide-N` -> `slide-N` (rewriting every element's `slide` pointer through a
   separate `slideIdMap`), drops the elements of a deleted slide before the empty-group cascade,
   and renumbers `z` by `(slide deck position, z)`. Its `summary` then also carries `slides`,
   `slidesAdded` and `slidesDeleted`, all net counts.
3. Serialize `result.scene` with `JSON.stringify(scene, null, 2)` between the sentinels, run the
   pre-save checklist, and update with the complete `{url, alias}` mapping fetched from
   `version_required_resources`:
   ```bash
   duckdb md: -c "SET VARIABLE c = (SELECT content FROM read_text('current.jsx')); SELECT * FROM MD_UPDATE_DIVE_CONTENT(id := '<uuid>'::UUID, content := getvariable('c'), required_resources := <fetched_resources>);"
   ```
4. Verify with `view_dive` (bare state) and tell the user to share the clean URL; old edited
   URLs are ignored automatically (stale `_base`) and the editor offers "Clear stale edits".

### Redeploying an existing dive on an upgraded framework

Pushing a locally-rebuilt file (e.g. after a template change) is NOT the same as the bake-back
above, and it is the one path that can silently destroy work: browser Saves advance the dive's
`SCENE.version`, so a local scene copied before those saves is BEHIND the live one, and pushing
it reverts every edit made since — with no error, because the write is a fresh version.

**Always compare scene versions before such a push:**

```bash
duckdb md: -c "COPY (SELECT content FROM MD_GET_DIVE(id := '<uuid>'::UUID)) TO 'live.jsx' (FORMAT csv, HEADER false, QUOTE '');"
# read SCENE.version out of live.jsx and compare with the local scene.json
```

- Live > local → **stop.** The live dive holds saved edits you do not have. Take the LIVE scene
  as the base, drop it into the local scene file unchanged, reassemble on the new framework, and
  push that. Never resolve the gap by hand-merging or by pushing the older scene.
- Live `SCENE.version` == local → **the version tells you nothing; you must compare the scenes.**
  A browser Save advances `SCENE.version`, but rebuilding a *different* local scene does not —
  two unrelated scenes (a seed fixture and a real deck) can both sit at version 1. Equality is
  not evidence of sameness; it happened twice on this project, pushing "versions match" over a
  completely different deck each time. Fingerprint both scenes (slide-id set, element-id set,
  counts, a hash of canonicalized JSON) before trusting a version match — `slides/scene-guard.js`
  does this and `slides/push.sh` calls it automatically whenever versions are equal. Identical
  content pushes with no ceremony; differing content **refuses (`push.sh` exit 3)** and prints
  the actual id diff; a parse failure is treated as a refusal too (fail closed), never silently
  passed as a match. If you truly intend to replace the live scene's content at the same
  version, the override `PUSH_I_KNOW_THIS_REPLACES_A_DIFFERENT_SCENE=1` still prints the full
  diff before proceeding — reach for it rarely, and only after reading that diff.
- Verify after the push that the deployed `SCENE` still equals the live scene you started from.

`MD_GET_DIVE_VERSION(id := ..., version := N)` and `MD_LIST_DIVE_VERSIONS(id := ...)` retrieve
any earlier version, so a clobbered dive is recoverable — but only if you notice.

After changing `merge-core.mjs`, run `node scripts/sync-merge-core.mjs` and then
`node scripts/sync-merge-core.mjs --check` before assembly.

## Hard platform constraints (do not violate)

- Allowed imports ONLY: `react`, `@motherduck/react-sql-query`, `recharts`, `d3`,
  `lucide-react`. No other libraries, no dynamic `import()`, no `eval`.
- No `fetch()` to non-MotherDuck hosts; no external images/fonts/scripts.
- No Tailwind arbitrary values (`w-[300px]`) or dynamically-built class names — all dynamic
  styling is inline `style={{}}` (the template already follows this).
- Tables (`type: "table"`) are hand-typed grids, not query results: use them for small
  reference material. Every row must carry the same number of cells, and `colWidths`/`rowHeights`
  (relative weights) must match the grid or the bake rejects the scene. For query-driven data use
  a `chart` when the SHAPE is the point, or — **in a deck only** — a `sqltable` when the numbers
  themselves are (a top-N list, a KPI grid off live data). `sqltable` is refused in a `v: 1` scene.
- BigInt/DECIMAL/DATE crash JSX — the template coerces chart rows, but your SQL should cast
  numerics and strftime dates anyway.
- Dive-state bags are capped at 64 KB (the editor meters and guards this).
