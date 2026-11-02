# Editable slide-deck Dives

A Claude Code skill for building slide decks as MotherDuck Dives. The deck is a single Dive:
viewers get a present mode (arrow keys, build steps, speaker notes), and the owner gets a
Google-Slides-like editor (filmstrip, layouts, layers, inspector) that saves edits back into the
Dive through a MotherDuck Flight. Slides can hold live SQL charts and tables, images, shapes,
copyable code snippets and links.

The skill also builds single-canvas editable Dives (`template.jsx`), for reports that scroll.

## What's here

| Path | What it is |
|---|---|
| `skill/` | The complete `editable-dive` skill. Copy it to `~/.claude/skills/editable-dive/` to install it. |
| `skill/SKILL.md` | Workflow and rules. Workflow A-DECK is the slide deck. |
| `skill/reference.md`, `skill/reference-deck.md` | The scene schema: elements, slides, builds, lists, code snippets, links, caps |
| `skill/template-slides.jsx` | The deck framework. Copy it verbatim and patch only its three sentinel regions. |
| `skill/template.jsx` | The canvas framework |
| `skill/merge-core.mjs`, `skill/scripts/sync-merge-core.mjs` | Merge/bake core shared by both templates, and the script that keeps their inline copies in sync |
| `skill/scripts/check-deck.mjs` | Validates a deck scene before you assemble it |
| `skill/flight/` | The save Flight (`save_deck.py`) a deck calls to write edits back. Set `MOTHERDUCK_HOST` and `ALLOWED_DIVE_IDS` before creating it. |
| `skill/examples/` | A worked 8-slide deck on `sample_data` and a worked canvas scene |
| `tools/assemble.mjs` | Builds `dive.jsx` from a scene and the template (the "assemble" step in `SKILL.md`) |
| `tools/push.sh` | Pulls the live Dive, applies a patch script, checks, assembles, pushes and verifies (the "push" step) |

`SKILL.md` mentions this project's original harness (`slides/assemble.js`, `slides/push.sh`).
`tools/assemble.mjs` and `tools/push.sh` replace them.

## Make a deck

1. Install the skill: `cp -r skill ~/.claude/skills/editable-dive`.
2. Get a MotherDuck token into `motherduck_token`, and install the DuckDB CLI and Node.js.
3. Ask Claude Code for "a slide deck Dive about …". It follows Workflow A-DECK: write the deck
   scene, check it, assemble it, create the Dive with `MD_CREATE_DIVE`, and set up the save Flight.
4. For later changes, write a small patch script that edits `deck.json` and run:

```bash
DIVE_ID=<dive uuid> FLIGHT_ID=<save flight uuid> \
SHARE_PATH=md:_share/<db>/<uuid> SHARE_ALIAS=<db> \
  path/to/tools/push.sh patches/<change>.py
```

`push.sh` stops if the deck checks fail, and prints `identical=true` once the stored Dive matches.

## Notes

- Images can't be loaded from URLs inside a Dive. Put them in a MotherDuck table as `data:` URLs
  (`name`, `src`) and point the scene's `images.sql` at it. For a public deck, use a database that
  holds only that deck's assets and share it with `ACCESS UNRESTRICTED`.
- Text renders in the template's system font. Lettering in another font has to be an image.
- Saving from the editor needs ownership of the save Flight, or a `RUN` grant on it. Anyone else
  can edit locally and use Copy JSON.
