// Dependency-free merge and bake core for editable Dives.
//
// The Dive runtime cannot import repository-local modules, so the code between the inline
// sentinels is generated verbatim (minus ESM `export` keywords) into template.jsx. The Vercel
// service imports this module directly during development and ships a byte-identical generated
// copy. Run scripts/sync-merge-core.mjs after changing this file.

// __INLINE_CORE_START__
// The element types, SPLIT BY SCHEMA. A type is not merely "known": it is legal in a v1 scene, or
// only in a deck (v2). The split exists because "invisible to v1 by construction" was claimed once
// for `sqltable` and was true only BY CORPUS — the v1 equivalence gate reported zero differences
// because no v1 fixture named the type, and one added fixture row turned it red. A
// schema-independent type set lets an attacker-controlled bag add a deck-only element to a v1
// Figma-style dive, where template.jsx has no renderer and no inspector for it: it bakes, and the
// author owns an invisible, unconfigurable box in their own source forever. Gating the type on the
// schema makes the containment claim structural, so the guard cannot be green for the wrong reason.
const EDITABLE_DIVE_V1_TYPES = new Set(["text", "image", "shape", "line", "chart", "table", "group"]);
// Types a DECK may use and a v1 scene may not. A type added here is refused in a v1 scene AND in a
// v1 bag by the validator itself, which is what shrinks a new type's blast radius to the fork that
// can actually draw it.
const EDITABLE_DIVE_DECK_ONLY_TYPES = new Set(["sqltable"]);
const EDITABLE_DIVE_TYPES = new Set([...EDITABLE_DIVE_V1_TYPES, ...EDITABLE_DIVE_DECK_ONLY_TYPES]);
const editableDiveTypesFor = (deck) => (deck ? EDITABLE_DIVE_TYPES : EDITABLE_DIVE_V1_TYPES);
const EDITABLE_DIVE_FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// The COMMON keys that belong to a DECK (schema v2) and to no v1 scene, DECLARED rather than
// deleted one at a time. `slide` names the slide an element lives on; `build` is its build step.
// Both sit in the COMMON set so they are patchable for every element type — moving an element to
// another slide, or into another build step, is a one-key patch — and both are removed again for a
// v1 scene, where neither is legal.
//
// The set exists because the gate used to be a lone `allowed.delete("slide")` in two functions, and
// the second key would have been two more easy-to-miss lines. It is the same containment argument
// EDITABLE_DIVE_DECK_ONLY_TYPES makes for types: template.jsx has no present mode, no build control
// and no renderer that consults `build`, so a key legal there is a key an attacker-controlled bag
// can bake into a v1 author's own source, invisible and unremovable, forever. Gating on the SCHEMA
// makes that structural, so the v1 equivalence gate cannot be green for the wrong reason.
const EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS = new Set(["slide", "build"]);
const EDITABLE_DIVE_COMMON_KEYS = new Set(["id", "type", "name", "parent", "x", "y", "w", "h", "z", "opacity",
  ...EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS]);
// A group has no box of its own and no build step of its own: it is a selection and transform unit,
// so every key here is one only a LEAF may carry. `build` is in the list for the same reason `x` is
// — present mode draws leaves, so a build on a group would have to mean "all my descendants", which
// is a second, conflicting way to say what a leaf's own `build` already says. The editor's build
// control writes to the selection's LEAVES, which is how a group is still built as one step.
const EDITABLE_DIVE_LEAF_ONLY_KEYS = ["x", "y", "w", "h", "z", "opacity", "build"];
// The build-step ceiling. Author-facing, so it is a number an author could plausibly type: sparse
// sequences are compacted at present time (see the fork's buildStepsOf), so the cap bounds the
// LABEL, not the click count, and three digits is what a badge can show.
const EDITABLE_DIVE_MAX_BUILD = 999;
const EDITABLE_DIVE_TYPE_KEYS = {
  text: new Set(["text", "level", "fontSize", "color", "align", "weight", "lineHeight", "italic", "underline", "highlight"]),
  image: new Set(["imageKey", "fit", "alt", "radius", "crop"]),
  shape: new Set(["fill", "stroke", "strokeWidth", "radius", "shape", "strokeDash"]),
  line: new Set(["orientation", "color", "thickness", "dash", "capStart", "capEnd"]),
  chart: new Set(["sql", "title", "chart"]),
  // A table is a rectangular grid of cell records. `colWidths`/`rowHeights` are relative
  // WEIGHTS, not pixels: each track renders as its share of the element box, so resizing the
  // element scales the whole grid and no width/height bookkeeping can drift out of sync.
  table: new Set(["cells", "colWidths", "rowHeights", "border"]),
  // A SQL table is the manual `table`'s query-backed sibling: the cells come from a statement
  // instead of from the author's keyboard, so it stores a QUERY plus PRESENTATION and stores no
  // data at all. It is a separate type — not a mode of `table`, not a `chart` whose renderer draws
  // a grid — because it shares no defining key with either: `table` IS its `cells`, which a SQL
  // table must never have, and `chart` IS its axis/series config, which a grid cannot use. Every
  // key below is a permanent part of the allowlist that protects the write, so each is justified:
  //   sql        the statement. Same name and meaning as `chart.sql`, and the same patchability:
  //              the SQL editor's Run writes exactly this key.
  //   title      an optional caption above the grid, drawn by the same code the chart title uses.
  //   columns    per-column PRESENTATION keyed BY COLUMN NAME: { revenue: { label, align, format } }.
  //              A record and not an array because the column set is decided by the query at run
  //              time, so a positional list would apply one column's format to its neighbour the
  //              first time the SELECT list changed. The schema cannot enumerate these keys — they
  //              are the author's column names — so what is bounded is their COUNT, against the
  //              same ceiling the manual table's columns have.
  //   limit      the drawn-row cap: the control that stops a 10,000-row result taking the slide
  //              down with it. Author-visible, and bounded by the manual table's row cap.
  //   header     draw the header row.
  //   zebra      stripe alternate body rows.
  //   border     { on, color, width } — identical in name, shape and defaults to the manual table's
  //              `border`. This is the plan's "name the same settings the same".
  //   textStyles the sparse TextStyle bags (the shape `chart.text` already carries) for the
  //              `header`, `cells` and `title` targets, so ONE TextStyleControls styles both tables.
  //              Named `textStyles` rather than `text` only because `text` already means "the string
  //              content" on the text type, and one key must not mean two things across types.
  // FLAT keys, not one free-form config object like `chart` — deliberately. The override bag is
  // 64 KB and prunePatch works per key, so toggling zebra adds FOURTEEN BYTES to the bag (measured,
  // and pinned by the unit suite) instead of re-emitting the whole config the way every chart tweak
  // does. And a flat key is one the validator below can check per key: `limit` gets a real RANGE
  // check and `columns` a bounded COUNT; the other six get type checks, which is all a boolean or a
  // free-form string admits. "Range-check each key" overstated it.
  sqltable: new Set(["sql", "title", "columns", "limit", "header", "zebra", "border", "textStyles"]),
  group: new Set([]),
};
const EDITABLE_DIVE_MAX_TABLE_ROWS = 200;
const EDITABLE_DIVE_MAX_TABLE_COLS = 40;
// The keys validateSqlTable CHECKS, as a list, so the patch path can ask "did this patch touch any of
// them?" without restating the set. "Checks" and not "range-checks": only `limit` gets a real range
// and `columns` a bounded count; the other six get type checks, which is all a boolean or a free-form
// string admits.
const EDITABLE_DIVE_SQLTABLE_CHECKED_KEYS = ["sql", "title", "columns", "limit", "header", "zebra", "border", "textStyles"];
const EDITABLE_DIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EDITABLE_DIVE_TEMP_ID_RE = /^new-[a-z][a-z0-9-]*-\d+$/;
const EDITABLE_DIVE_MAX_ELEMENTS = 5000;
const EDITABLE_DIVE_MAX_DEPTH = 24;
const EDITABLE_DIVE_MAX_STRING = 262144;

// ── Deck (schema v2) ────────────────────────────────────────────────────────
// A deck scene is a v1 scene plus a `slides` array whose ARRAY ORDER IS THE DECK ORDER, and one
// required `slide` key per element (leaves and groups alike). Slide ids share the element id
// namespace, so a mixed-up id is a hard error instead of a silent no-op.
const EDITABLE_DIVE_MAX_SLIDES = 500;
const EDITABLE_DIVE_SLIDE_KEYS = new Set(["id", "name", "background", "notes", "hidden"]);
// What a slidePatch may touch — never `id`, which is the identity every pointer in the bag uses.
const EDITABLE_DIVE_SLIDE_PATCH_KEYS = new Set(["name", "background", "notes", "hidden"]);
const EDITABLE_DIVE_TEMP_SLIDE_ID_RE = /^new-slide-\d+$/;

// ── The ONE id namespace, declared ──────────────────────────────────────────
// Element ids and slide ids share a SINGLE namespace (spec S2), so every id a bag NAMES is spent
// until the next bake and nothing may be minted onto it. This namespace has bitten the codebase
// four times, and the fourth is why the table lives HERE and not in the editor: an earlier pass
// built a declared table on the EDITOR side and reported the class closed, while
// permanentizeAddedIds kept a reservation of its own — live merged ids and live slide ids only, so
// the same bag's `deleted`, patch keys, `deletedSlides`, `slidePatch` keys and `slideOrder` entries
// were all re-mintable, and a new element could be handed the id the bag had just tombstoned. Two
// tables meant two answers. There is one now and every side reads it: validateBakeInput takes its
// key allowlist from it, the two permanentizers take their reservation from it, and the editor's
// single mint entry point calls reservedNamespaceIds. A future bag key has to declare whether it
// names an id, because there is nowhere else to add it.
const EDITABLE_DIVE_BAG_KEYS = {
  v: { deckOnly: false, ids: null },
  _base: { deckOnly: false, ids: null },
  page: { deckOnly: false, ids: null },
  patch: { deckOnly: false, ids: (value) => (isPlainRecord(value) ? Object.keys(value) : []) },
  deleted: { deckOnly: false, ids: (value) => (Array.isArray(value) ? value : []) },
  added: { deckOnly: false, ids: (value) => (Array.isArray(value) ? value : []).map((el) => el && el.id) },
  slidePatch: { deckOnly: true, ids: (value) => (isPlainRecord(value) ? Object.keys(value) : []) },
  addedSlides: { deckOnly: true, ids: (value) => (Array.isArray(value) ? value : []).map((slide) => slide && slide.id) },
  deletedSlides: { deckOnly: true, ids: (value) => (Array.isArray(value) ? value : []) },
  slideOrder: { deckOnly: true, ids: (value) => (Array.isArray(value) ? value : []) },
};

// Which bag keys a scene of this schema may carry. The four deck keys exist only for a deck scene,
// so a v2 bag aimed at a v1 scene is refused by its own contents as well as by the `v` gate.
export function allowedBagKeys(deck) {
  const keys = new Set();
  for (const key of Object.keys(EDITABLE_DIVE_BAG_KEYS)) {
    if (deck || !EDITABLE_DIVE_BAG_KEYS[key].deckOnly) keys.add(key);
  }
  return keys;
}

// Every id the bag NAMES, read through the table above. The bag arrives from a URL, so it is
// attacker-controlled and un-normalized: each reader degrades a malformed value to "no ids" rather
// than throwing, because this runs on raw input in the editor as well as at the Save boundary.
export function bagNamedIds(rawOverrides) {
  const raw = isPlainRecord(rawOverrides) ? rawOverrides : {};
  const out = [];
  for (const key of Object.keys(EDITABLE_DIVE_BAG_KEYS)) {
    const read = EDITABLE_DIVE_BAG_KEYS[key].ids;
    if (!read || raw[key] === undefined) continue;
    // Every reader in the table returns an array unconditionally, so there is no `|| []` here: a
    // guard no input can reach is an assertion that never runs.
    for (const id of read(raw[key])) if (typeof id === "string" && id) out.push(id);
  }
  return out;
}

// THE reservation. Everything already spoken for in the one namespace: the BASE scene's elements and
// slides (whether or not the bag has since deleted them), plus every id the bag names, plus `extra`
// — ids that exist only in the caller's world, such as the permanent id a temporary slide is about
// to claim or the editor's live projection of the deck.
export function reservedNamespaceIds(scene, rawOverrides, extra) {
  const taken = new Set();
  const add = (id) => { if (typeof id === "string" && id) taken.add(id); };
  if (scene && Array.isArray(scene.elements)) for (const el of scene.elements) add(el && el.id);
  if (scene && Array.isArray(scene.slides)) for (const slide of scene.slides) add(slide && slide.id);
  for (const id of bagNamedIds(rawOverrides)) add(id);
  if (extra) for (const id of extra) add(id);
  return taken;
}

export class EditableDiveBakeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EditableDiveBakeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function editableDiveFail(code, message, details) {
  throw new EditableDiveBakeError(code, message, details);
}

export function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeJson(value, path = "value", depth = 0) {
  if (depth > EDITABLE_DIVE_MAX_DEPTH) editableDiveFail("INVALID_INPUT", `${path} is nested too deeply`);
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) editableDiveFail("INVALID_INPUT", `${path} must contain only finite numbers`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > EDITABLE_DIVE_MAX_STRING) editableDiveFail("INVALID_INPUT", `${path} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJson(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) editableDiveFail("INVALID_INPUT", `${path} must be JSON data`);
  for (const key of Object.keys(value)) {
    if (EDITABLE_DIVE_FORBIDDEN_KEYS.has(key)) editableDiveFail("INVALID_INPUT", `${path} contains forbidden key ${key}`);
    assertSafeJson(value[key], `${path}.${key}`, depth + 1);
  }
}

export function normOv(raw, fallbackVersion = 1) {
  const o = isPlainRecord(raw) ? raw : {};
  return {
    v: 1,
    _base: typeof o._base === "number" ? o._base : fallbackVersion,
    patch: isPlainRecord(o.patch) ? o.patch : {},
    deleted: Array.isArray(o.deleted) ? o.deleted : [],
    added: Array.isArray(o.added) ? o.added : [],
    page: isPlainRecord(o.page) ? o.page : undefined,
  };
}

// Which schema a scene speaks. `v` is the contract (the version gate in validateBakeInput is
// strict in both directions), so every helper keys off it rather than sniffing for `slides`.
export function isDeckScene(scene) {
  return !!scene && scene.v === 2;
}

// The deck half of the override bag, normalized the same way normOv normalizes the v1 half:
// every malformed field degrades to "no opinion" instead of throwing. The v1 six keep their
// exact semantics; nothing here touches them.
export function normSlideOv(raw) {
  const o = isPlainRecord(raw) ? raw : {};
  return {
    slidePatch: isPlainRecord(o.slidePatch) ? o.slidePatch : {},
    addedSlides: Array.isArray(o.addedSlides) ? o.addedSlides : [],
    deletedSlides: Array.isArray(o.deletedSlides) ? o.deletedSlides : [],
    // Normalized for editor consumers. effectiveSlides deliberately reads the raw order instead,
    // so a present-but-malformed order can still fail the strict path.
    slideOrder: Array.isArray(o.slideOrder) ? o.slideOrder : undefined,
  };
}

// `order` must be a full permutation of `ids` — not a prefix, not a subset, no duplicates. A
// full order makes a reorder cost O(bytes) and makes a stale order a loud error instead of a
// silent drop.
function isSameIdSet(order, ids) {
  if (!Array.isArray(order) || order.length !== ids.length) return false;
  const wanted = new Set(ids);
  const seen = new Set();
  for (const id of order) {
    if (typeof id !== "string" || !wanted.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

// slideOrder is the one rule where the runtime and the server must legitimately disagree: the
// editor keeps rendering a deck whose order array went stale, while SAVING that same bag has to
// fail rather than quietly bake a different deck order. The two named entry points below carry
// that difference in their names — it is never decided by a defaulted argument.
const EDITABLE_DIVE_ORDER_STRICT = "strict";
const EDITABLE_DIVE_ORDER_TOLERANT = "tolerant";

function effectiveSlides(scene, rawOverrides, orderMode) {
  const strict = orderMode === EDITABLE_DIVE_ORDER_STRICT;
  const baseSlides = Array.isArray(scene.slides) ? scene.slides.filter(isPlainRecord) : [];
  const overrides = normOv(rawOverrides, scene.version);
  const slideOv = normSlideOv(rawOverrides);
  // A stale bag loses its deck edits exactly as it loses its element edits in mergeScene.
  if (overrides._base !== scene.version) return baseSlides.map((slide) => ({ ...slide }));
  const dropped = new Set(slideOv.deletedSlides.filter((id) => typeof id === "string"));
  const survivors = [];
  const seen = new Set();
  // 1 base order, minus deletedSlides; 2 addedSlides appended in bag order, same deletion pass;
  // 3 slidePatch shallow-merged into each survivor, never `id`.
  for (const slide of [...baseSlides, ...slideOv.addedSlides]) {
    if (!isPlainRecord(slide) || typeof slide.id !== "string") continue;
    if (dropped.has(slide.id) || seen.has(slide.id)) continue;
    seen.add(slide.id);
    const merged = { ...slide };
    const patch = Object.hasOwn(slideOv.slidePatch, slide.id) ? slideOv.slidePatch[slide.id] : undefined;
    if (isPlainRecord(patch)) {
      for (const key of Object.keys(patch)) {
        if (EDITABLE_DIVE_SLIDE_PATCH_KEYS.has(key)) merged[key] = patch[key];
      }
    }
    survivors.push(merged);
  }
  // 4 the tolerant path is bounded by the SAME cap as the strict one. Strict never arrives here
  // over-cap — validateBakeInput rejects `scene.slides + addedSlides > EDITABLE_DIVE_MAX_SLIDES`
  // before it calls slidesOfStrict — but the tolerant path had no bound at all, so one 64 KB bag
  // of `new-slide-N` records could make the editor render thousands of slides that can never be
  // saved. Policy: keep the first MAX in resolution order (base slides, then addedSlides in bag
  // order) and drop the overflow, so the bag can never displace a slide the author already saved.
  const capped = !strict && survivors.length > EDITABLE_DIVE_MAX_SLIDES
    ? survivors.slice(0, EDITABLE_DIVE_MAX_SLIDES)
    : survivors;
  // 5 reorder to slideOrder when it is a full permutation of the survivors. The order is read
  // from the RAW bag rather than the normalized one so that the strict path still SEES a
  // malformed-but-present order (normSlideOv drops it, which is the right tolerant answer). An
  // order that lists slides the cap above dropped is not a permutation, so it is simply ignored.
  const rawOrder = isPlainRecord(rawOverrides) ? rawOverrides.slideOrder : undefined;
  let ordered = capped;
  if (rawOrder !== undefined) {
    if (isSameIdSet(rawOrder, capped.map((slide) => slide.id))) {
      const byId = new Map(capped.map((slide) => [slide.id, slide]));
      ordered = rawOrder.map((id) => byId.get(id));
    } else if (strict) {
      editableDiveFail("INVALID_OVERRIDES", "overrides.slideOrder must be a permutation of the live slide ids");
    }
  }
  // 6 a deck keeps at least one slide. The tolerant path reports the empty deck instead of
  // resurrecting deleted slides: reviving them would also revive their elements, so the two
  // paths would then disagree about ELEMENTS, which is worse than an empty editor canvas.
  // UI DEPENDENCY: because an empty effective deck renders as a blank canvas (mergeScene keeps no
  // element whose slide is gone), the filmstrip must never let the user delete the LAST slide —
  // the core deliberately does not paper over it here. Any UI work on slide deletion owns that.
  if (strict && ordered.length === 0) editableDiveFail("INVALID_OVERRIDES", "a deck must keep at least one slide");
  return ordered;
}

// Runtime/editor entry point: tolerant, the same posture as normOv and sanitizeParents.
export function slidesOf(scene, rawOverrides) {
  return effectiveSlides(scene, rawOverrides, EDITABLE_DIVE_ORDER_TOLERANT);
}

// Server/bake entry point: every deviation from the contract is a hard error.
export function slidesOfStrict(scene, rawOverrides) {
  return effectiveSlides(scene, rawOverrides, EDITABLE_DIVE_ORDER_STRICT);
}

// Returning the INPUT OBJECT for an unpatched element is load-bearing, not an optimization detail:
// the slides fork's filmstrip memoizes one thumbnail per slide on its leaf ARRAY identity, so a
// normalizing `.map()` here (or in sanitizeParents, which likewise returns its element untouched
// when the parent needs no repair) would hand every slide fresh objects and re-render all ~200
// thumbnails on every keystroke. The unit suite asserts the identity through a real commit.
export function applyElPatch(el, patch) {
  if (!patch) return el;
  return { ...el, ...patch, id: el.id, type: el.type };
}

export const parentOf = (el) => (el && el.parent != null ? el.parent : null);

export function sanitizeParents(elements) {
  const byId = new Map();
  for (const element of elements) byId.set(element.id, element);
  const groupParent = (id) => {
    const element = byId.get(id);
    if (!element || element.type !== "group") return null;
    const parent = byId.get(parentOf(element));
    return parent && parent.type === "group" ? parent.id : null;
  };
  const onCycle = new Set();
  const settled = new Set();
  for (const element of elements) {
    if (element.type !== "group" || settled.has(element.id)) continue;
    const path = [];
    const seenAt = new Map();
    let current = element.id;
    while (current != null && !settled.has(current) && !seenAt.has(current)) {
      seenAt.set(current, path.length);
      path.push(current);
      current = groupParent(current);
    }
    if (current != null && seenAt.has(current)) {
      for (let i = seenAt.get(current); i < path.length; i += 1) onCycle.add(path[i]);
    }
    for (const id of path) settled.add(id);
  }
  return elements.map((element) => {
    const currentParent = parentOf(element);
    if (currentParent == null) return element;
    const parent = byId.get(currentParent);
    // A parent on a DIFFERENT slide gets the same repair a missing parent gets — nulled. Without
    // it the editor renders a group whose members span slides (spec S4), which bakeScene rejects,
    // so the canvas would show a shape the deck can never save. The slides are compared only when
    // BOTH sides declare one: that keeps v1 (where nothing carries `slide`, including an element a
    // stray v1 patch put one on) byte-identical, and costs the deck nothing, because mergeScene
    // has already dropped every element — group or leaf — whose `slide` names no live slide.
    const sameSlide = !!parent
      && (element.slide === undefined || parent.slide === undefined || parent.slide === element.slide);
    const valid = !!parent && parent.type === "group" && sameSlide
      && !(element.type === "group" && onCycle.has(element.id));
    return valid ? element : { ...element, parent: null };
  });
}

export function finalizeScene(page, elements, stale, slides) {
  const all = sanitizeParents(elements);
  const result = {
    page,
    all,
    elements: all.filter((element) => element.type !== "group").sort((a, b) => a.z - b.z),
    stale,
  };
  // A v1 scene has no deck, so its merge result keeps exactly the v1 shape — the key appears
  // only for a deck scene.
  if (slides !== undefined) result.slides = slides;
  return result;
}

export function mergeScene(scene, rawOverrides) {
  const overrides = normOv(rawOverrides, scene.version);
  const stale = overrides._base !== scene.version;
  const deck = isDeckScene(scene);
  // The deck is resolved by the SAME function the server uses, in its tolerant mode, so the
  // editor and the bake can never disagree about which slides exist. slidesOf handles the
  // stale case itself (base slides verbatim).
  const slides = deck ? slidesOf(scene, rawOverrides) : undefined;
  if (stale) return finalizeScene({ ...scene.page }, [...scene.elements], true, slides);
  const deleted = new Set(overrides.deleted);
  // OWN-property lookups. An element may legitimately be called `constructor` or `toString` (the id
  // grammar allows both, and only assertSafeJson's forbidden-KEY rule keeps a patch from naming
  // them), and `patch["constructor"]` would otherwise resolve up the prototype chain to a function.
  // applyElPatch would then spread it — harmless in content, but it returns a FRESH object, which
  // silently breaks the identity contract the filmstrip's thumbnail memo depends on.
  const patchFor = (element) => (Object.hasOwn(overrides.patch, element.id) ? overrides.patch[element.id] : undefined);
  const base = scene.elements
    .filter((element) => !deleted.has(element.id))
    .map((element) => applyElPatch(element, patchFor(element)));
  const added = overrides.added
    .filter((element) => !deleted.has(element.id))
    .map((element) => applyElPatch(element, patchFor(element)));
  let all = [...base, ...added];
  if (deck) {
    // Deleting a slide deletes its elements implicitly: the bag never has to list them in
    // `deleted`. Patches are applied ABOVE this filter, so an element explicitly moved to a
    // surviving slide escapes the deletion of the slide it came from.
    const live = new Set(slides.map((slide) => slide.id));
    all = all.filter((element) => live.has(element.slide));
  }
  return finalizeScene({ ...scene.page, ...(overrides.page || {}) }, all, false, slides);
}

export function valEq(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === "object" || typeof b === "object") {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return a === b;
}

export function prunePatch(baseElement, patch) {
  const out = {};
  for (const key of Object.keys(patch)) {
    if (key === "id" || key === "type") continue;
    if (!valEq(patch[key], baseElement[key])) out[key] = patch[key];
  }
  return out;
}

function validateElement(element, path, { added = false, deck = false } = {}) {
  if (!isPlainRecord(element)) editableDiveFail("INVALID_SCENE", `${path} must be an object`);
  assertSafeJson(element, path);
  if (typeof element.id !== "string" || !EDITABLE_DIVE_ID_RE.test(element.id)) {
    editableDiveFail("INVALID_SCENE", `${path}.id is invalid`);
  }
  if (added && !EDITABLE_DIVE_TEMP_ID_RE.test(element.id)) {
    editableDiveFail("INVALID_OVERRIDES", `${path}.id must be an editor-generated new-* id`);
  }
  if (!editableDiveTypesFor(deck).has(element.type)) editableDiveFail("INVALID_SCENE", `${path}.type is invalid`);
  const allowed = new Set([...EDITABLE_DIVE_COMMON_KEYS, ...EDITABLE_DIVE_TYPE_KEYS[element.type]]);
  // Half of the two-way version gate: on a v1 scene neither `slide` nor `build` is a key at all, so
  // a migrated element that slipped into an unmigrated scene fails here instead of baking a pointer
  // the scene cannot resolve. (The other half — a v2 element MISSING its slide — needs the live
  // slide set, so validateBakeInput checks it.)
  if (!deck) for (const key of EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS) allowed.delete(key);
  for (const key of Object.keys(element)) {
    if (!allowed.has(key)) editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.${key} is not allowed for ${element.type}`);
  }
  if (element.parent != null && (typeof element.parent !== "string" || !EDITABLE_DIVE_ID_RE.test(element.parent))) {
    editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.parent is invalid`);
  }
  if (element.type === "group") {
    for (const key of EDITABLE_DIVE_LEAF_ONLY_KEYS) {
      if (Object.hasOwn(element, key)) editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.${key} is not allowed on a group`);
    }
    return;
  }
  for (const key of ["x", "y", "w", "z"]) {
    if (!Number.isFinite(element[key])) editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.${key} must be finite`);
  }
  if (!(Number.isFinite(element.h) || (element.type === "text" && element.h === "auto"))) {
    editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.h is invalid`);
  }
  if (element.opacity != null && !Number.isFinite(element.opacity)) {
    editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.opacity must be finite`);
  }
  validateBuildStep(element, path, added);
  if (element.type === "table") validateTableGeometry(element, path, added);
  if (element.type === "sqltable") validateSqlTable(element, path, added);
}

// `build` is a STEP NUMBER, so an integer and nothing else: the fork orders the DISTINCT values on
// a slide and reveals them in that order, and a fractional or stringly step would sort by a rule no
// author could predict. It is checked here rather than inline in validateElement because the patch
// path needs the same check on the MERGED element and validateElement never sees a patch — the one
// place a hostile bag can raise a step to 1e9 on an element that was valid when it baked.
//
// null is "no opinion", exactly as it is for the manual table's tracks: the inspector clears the
// step by writing null so prunePatch can drop the key again. So this is `!= null`, not
// `Object.hasOwn` — and a patch of `{ build: null }` on a built element is a legal un-build.
function validateBuildStep(element, path, added) {
  if (element.build == null) return;
  if (!Number.isInteger(element.build) || element.build < 1 || element.build > EDITABLE_DIVE_MAX_BUILD) {
    editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", `${path}.build must be an integer 1..${EDITABLE_DIVE_MAX_BUILD}`);
  }
}

// Tables are the one element whose geometry spans several keys at once, so a patch that
// touches any of them is checked against the MERGED result rather than in isolation: a patch
// adding a column to `cells` while leaving `colWidths` at the old length must not bake.
function validateTableGeometry(element, path, added) {
  const fail = (message) => editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", message);
  const cells = element.cells;
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > EDITABLE_DIVE_MAX_TABLE_ROWS) {
    fail(`${path}.cells must be 1..${EDITABLE_DIVE_MAX_TABLE_ROWS} rows`);
  }
  const cols = Array.isArray(cells[0]) ? cells[0].length : 0;
  if (cols < 1 || cols > EDITABLE_DIVE_MAX_TABLE_COLS) {
    fail(`${path}.cells must be 1..${EDITABLE_DIVE_MAX_TABLE_COLS} columns`);
  }
  for (let r = 0; r < cells.length; r += 1) {
    if (!Array.isArray(cells[r]) || cells[r].length !== cols) fail(`${path}.cells[${r}] must have ${cols} cells`);
    for (let c = 0; c < cols; c += 1) {
      if (!isPlainRecord(cells[r][c])) fail(`${path}.cells[${r}][${c}] must be an object`);
    }
  }
  const track = (key, expected) => {
    const value = element[key];
    // undefined and null both mean "uniform": writers drop the track entirely rather than
    // storing n copies of 1/n, so a plain grid costs nothing in the override bag.
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.length !== expected) fail(`${path}.${key} must have ${expected} entries`);
    for (const entry of value) {
      if (!Number.isFinite(entry) || entry <= 0) fail(`${path}.${key} entries must be positive numbers`);
    }
  };
  track("colWidths", cols);
  track("rowHeights", cells.length);
  if (element.border !== undefined && element.border !== null && !isPlainRecord(element.border)) {
    fail(`${path}.border must be an object`);
  }
}

// A SQL table's cross-key check is a PER-KEY check, and the reason is structural rather than the
// "nothing here can disagree" this comment used to claim. That claim was simply false: `limit` and
// the element's own `h` genuinely disagree, because a SQL table's rows are fixed-height while the
// manual table's track sizes are weights OF its box and so cannot overflow. That disagreement is
// reconciled where it is observable — the renderer draws min(limit, what the box can show) and the
// caption reports whatever was withheld — not here, because a validator that refused the pair would
// make resizing a box a save-time error instead of a smaller grid.
//
// What IS true structurally is that the merge in the patch guard below is INERT for this type. Every
// base element has already been through validateElement before the patch loop runs, so merging a
// patch onto it can only bring the patch's OWN keys under test, and each key here is checked
// in isolation. The manual table needs the merge for real: `cells`, `colWidths` and `rowHeights` are
// three keys that must agree about ONE shape, so a patch touching one can desynchronize the others.
//
// `columns` is the one open namespace, because its keys are the author's column names. It is bounded
// by COUNT (the manual table's column ceiling) and not by an inner allowlist: enumerating the
// per-column setting names here would put every future one behind a core change and a Save-service
// redeploy, while the values are already covered by assertSafeJson's depth, length and
// forbidden-key rules and by serializeSceneLiteral's escaping on the way into the JSX module.
function validateSqlTable(element, path, added) {
  const fail = (message) => editableDiveFail(added ? "INVALID_OVERRIDES" : "INVALID_SCENE", message);
  // null is "no opinion" for every key here, exactly as it is for the manual table's tracks: the
  // inspector clears a setting by writing null so prunePatch can drop it again.
  const set = (key) => element[key] !== undefined && element[key] !== null;
  for (const key of ["sql", "title"]) {
    if (set(key) && typeof element[key] !== "string") fail(`${path}.${key} must be a string`);
  }
  for (const key of ["header", "zebra"]) {
    if (set(key) && typeof element[key] !== "boolean") fail(`${path}.${key} must be a boolean`);
  }
  for (const key of ["border", "textStyles"]) {
    if (set(key) && !isPlainRecord(element[key])) fail(`${path}.${key} must be an object`);
  }
  // The SAME ceiling a hand-typed table has: a query-backed grid must not be able to draw more rows
  // than an author could have typed into the manual one. An integer, because half a row is not a
  // policy — and a non-integer would reach `rows.slice(0, limit)` and truncate by accident.
  if (set("limit") && (!Number.isInteger(element.limit) || element.limit < 1 || element.limit > EDITABLE_DIVE_MAX_TABLE_ROWS)) {
    fail(`${path}.limit must be an integer 1..${EDITABLE_DIVE_MAX_TABLE_ROWS}`);
  }
  if (set("columns")) {
    if (!isPlainRecord(element.columns)) fail(`${path}.columns must be an object`);
    const keys = Object.keys(element.columns);
    if (keys.length > EDITABLE_DIVE_MAX_TABLE_COLS) {
      fail(`${path}.columns must name at most ${EDITABLE_DIVE_MAX_TABLE_COLS} columns`);
    }
    for (const key of keys) {
      if (element.columns[key] !== null && !isPlainRecord(element.columns[key])) {
        fail(`${path}.columns.${key} must be an object`);
      }
    }
  }
}

function allowedPatchKeys(type, deck = false) {
  const keys = new Set([...EDITABLE_DIVE_COMMON_KEYS, ...EDITABLE_DIVE_TYPE_KEYS[type]]);
  keys.delete("id");
  keys.delete("type");
  if (!deck) for (const key of EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS) keys.delete(key);
  // A group has no box of its own and no build step of its own — validateElement forbids both on it
  // — so a patch offering either could only ever bake a scene the validator rejects on the NEXT
  // save. Refusing it here turns a permanently unsaveable dive into one clear INVALID_OVERRIDES at
  // the boundary.
  if (type === "group") for (const key of EDITABLE_DIVE_LEAF_ONLY_KEYS) keys.delete(key);
  return keys;
}

// One slide record. `id` is required and shares the element id namespace; every other key is
// optional presentation metadata. `temporary` demands the editor-generated new-slide-N form.
function validateSlide(slide, path, { code = "INVALID_SCENE", temporary = false } = {}) {
  if (!isPlainRecord(slide)) editableDiveFail(code, `${path} must be an object`);
  assertSafeJson(slide, path);
  if (typeof slide.id !== "string" || !EDITABLE_DIVE_ID_RE.test(slide.id)) editableDiveFail(code, `${path}.id is invalid`);
  // `prototype` and `constructor` pass the id grammar (`__proto__` does not). Every lookup keyed by
  // an id in THIS file goes through a Map/Set or Object.hasOwn — which was once claimed of the whole
  // codebase and was not true of the two patch lookups in mergeScene/validateBakeInput, nor of the
  // editor's SQL-keyed present-mode pool. They are refused as slide ids anyway
  // because assertSafeJson forbids them as OBJECT KEYS, so such a slide could never be named by a
  // slidePatch: it would bake fine and then be unpatchable forever. One check kills the asymmetry.
  if (EDITABLE_DIVE_FORBIDDEN_KEYS.has(slide.id)) editableDiveFail(code, `${path}.id is a reserved name`);
  if (temporary && !EDITABLE_DIVE_TEMP_SLIDE_ID_RE.test(slide.id)) {
    editableDiveFail(code, `${path}.id must be an editor-generated new-slide-N id`);
  }
  for (const key of Object.keys(slide)) {
    if (!EDITABLE_DIVE_SLIDE_KEYS.has(key)) editableDiveFail(code, `${path}.${key} is not allowed on a slide`);
  }
  for (const key of ["name", "background", "notes"]) {
    if (slide[key] != null && typeof slide[key] !== "string") editableDiveFail(code, `${path}.${key} must be a string`);
  }
  if (slide.hidden != null && typeof slide.hidden !== "boolean") editableDiveFail(code, `${path}.hidden must be a boolean`);
}

// A group and every descendant share one slide. Checking each element against its DIRECT parent
// covers the whole subtree transitively, and it is the same class of structural invariant as
// assertValidParentForest — enforced on the scene, then re-checked on the merged result.
function assertOneSlidePerGroup(elements, code, label) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    const parentId = parentOf(element);
    if (parentId == null) continue;
    const parent = byId.get(parentId);
    // A missing or non-group parent is either already fatal or about to be repaired by
    // sanitizeParents into a root; either way it is not this invariant's business.
    if (!parent || parent.type !== "group") continue;
    if (parent.slide !== element.slide) {
      editableDiveFail(code, `${label} ${element.id} is on slide ${String(element.slide)} but its group ${parentId} is on slide ${String(parent.slide)}`);
    }
  }
}

function assertValidParentForest(elements, code, label, { allowMissing = false } = {}) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    const parentId = parentOf(element);
    if (parentId == null) continue;
    const parent = byId.get(parentId);
    if (!parent) {
      if (allowMissing) continue;
      editableDiveFail(code, `${label} ${element.id} references missing parent ${parentId}`);
    }
    if (parent.type !== "group") editableDiveFail(code, `${label} ${element.id} references non-group parent ${parentId}`);
  }
  for (const element of elements) {
    if (element.type !== "group") continue;
    const seen = new Set([element.id]);
    let current = parentOf(element);
    while (current != null) {
      if (seen.has(current)) editableDiveFail(code, `${label} contains a parent cycle through ${element.id}`);
      seen.add(current);
      const parent = byId.get(current);
      current = parent && parent.type === "group" ? parentOf(parent) : null;
    }
  }
}

export function validateBakeInput(scene, rawOverrides, { maxOverrideBytes = 65536 } = {}) {
  if (!isPlainRecord(scene)) editableDiveFail("INVALID_SCENE", "scene must be an object");
  assertSafeJson(scene, "scene");
  if ((scene.v !== 1 && scene.v !== 2) || !Number.isInteger(scene.version) || scene.version < 0) {
    editableDiveFail("INVALID_SCENE", "scene schema/version is invalid");
  }
  if (!isPlainRecord(scene.page) || !Array.isArray(scene.elements) || scene.elements.length > EDITABLE_DIVE_MAX_ELEMENTS) {
    editableDiveFail("INVALID_SCENE", "scene page/elements are invalid");
  }
  const deck = isDeckScene(scene);
  // A deck declares its slides; a v1 scene must not carry any. The gate is strict in both
  // directions so a half-migrated file cannot bake.
  const sceneSlideIds = new Set();
  if (deck) {
    if (!Array.isArray(scene.slides) || scene.slides.length < 1 || scene.slides.length > EDITABLE_DIVE_MAX_SLIDES) {
      editableDiveFail("INVALID_SCENE", `scene.slides must be an array of 1..${EDITABLE_DIVE_MAX_SLIDES} slides`);
    }
    scene.slides.forEach((slide, index) => {
      validateSlide(slide, `scene.slides[${index}]`);
      if (sceneSlideIds.has(slide.id)) editableDiveFail("INVALID_SCENE", `duplicate slide id ${slide.id}`);
      sceneSlideIds.add(slide.id);
    });
  } else if (scene.slides !== undefined) {
    editableDiveFail("INVALID_SCENE", "scene.slides requires scene schema v2");
  }
  const byId = new Map();
  scene.elements.forEach((element, index) => {
    const path = `scene.elements[${index}]`;
    validateElement(element, path, { deck });
    if (byId.has(element.id)) editableDiveFail("INVALID_SCENE", `duplicate scene id ${element.id}`);
    if (sceneSlideIds.has(element.id)) editableDiveFail("INVALID_SCENE", `scene id ${element.id} collides with a slide id`);
    byId.set(element.id, element);
    // One id namespace, one required pointer: leaves AND groups name the slide they live on.
    if (deck && !sceneSlideIds.has(element.slide)) editableDiveFail("INVALID_SCENE", `${path}.slide must name a live slide`);
  });
  assertValidParentForest(scene.elements, "INVALID_SCENE", "scene");
  if (deck) assertOneSlidePerGroup(scene.elements, "INVALID_SCENE", "scene");
  if (!isPlainRecord(rawOverrides)) editableDiveFail("INVALID_OVERRIDES", "overrides must be an object");
  assertSafeJson(rawOverrides, "overrides");
  let overrideBytes;
  try { overrideBytes = new TextEncoder().encode(JSON.stringify(rawOverrides)).length; } catch {
    editableDiveFail("INVALID_OVERRIDES", "overrides are not serializable");
  }
  if (overrideBytes > maxOverrideBytes) editableDiveFail("PAYLOAD_TOO_LARGE", `overrides exceed ${maxOverrideBytes} bytes`);
  // Derived from the ONE declared bag-key table, not restated here: a new key cannot become legal
  // without also declaring whether it names an id (see EDITABLE_DIVE_BAG_KEYS).
  const topKeys = allowedBagKeys(deck);
  for (const key of Object.keys(rawOverrides)) {
    if (!topKeys.has(key)) editableDiveFail("INVALID_OVERRIDES", `overrides.${key} is not allowed`);
  }
  if (rawOverrides.v !== scene.v || !Number.isInteger(rawOverrides._base)) {
    editableDiveFail("INVALID_OVERRIDES", "overrides v/_base are invalid");
  }
  if (rawOverrides._base !== scene.version) {
    editableDiveFail("STALE_BASE", `edits were made against scene ${rawOverrides._base}, but the current scene is ${scene.version}`, {
      expected: scene.version,
      received: rawOverrides._base,
    });
  }
  const patch = rawOverrides.patch === undefined ? {} : rawOverrides.patch;
  const deleted = rawOverrides.deleted === undefined ? [] : rawOverrides.deleted;
  const added = rawOverrides.added === undefined ? [] : rawOverrides.added;
  if (!isPlainRecord(patch) || !Array.isArray(deleted) || !Array.isArray(added)) {
    editableDiveFail("INVALID_OVERRIDES", "overrides patch/deleted/added are invalid");
  }
  if (scene.elements.length + added.length > EDITABLE_DIVE_MAX_ELEMENTS) {
    editableDiveFail("INVALID_OVERRIDES", "too many elements after merge");
  }
  // ── the deck half of the bag ────────────────────────────────────────────────
  // Validated BEFORE `added`, because an added element's `slide` must name a slide that is live
  // once addedSlides and deletedSlides have been taken into account.
  const slidePatch = deck && rawOverrides.slidePatch !== undefined ? rawOverrides.slidePatch : {};
  const addedSlides = deck && rawOverrides.addedSlides !== undefined ? rawOverrides.addedSlides : [];
  const deletedSlides = deck && rawOverrides.deletedSlides !== undefined ? rawOverrides.deletedSlides : [];
  if (!isPlainRecord(slidePatch) || !Array.isArray(addedSlides) || !Array.isArray(deletedSlides)) {
    editableDiveFail("INVALID_OVERRIDES", "overrides slidePatch/addedSlides/deletedSlides are invalid");
  }
  const baseSlideById = new Map((deck ? scene.slides : []).map((slide) => [slide.id, slide]));
  const addedSlideIds = new Set();
  addedSlides.forEach((slide, index) => {
    validateSlide(slide, `overrides.addedSlides[${index}]`, { code: "INVALID_OVERRIDES", temporary: true });
    if (sceneSlideIds.has(slide.id) || addedSlideIds.has(slide.id)) {
      editableDiveFail("INVALID_OVERRIDES", `duplicate added slide id ${slide.id}`);
    }
    if (byId.has(slide.id)) editableDiveFail("INVALID_OVERRIDES", `added slide id ${slide.id} collides with an element id`);
    addedSlideIds.add(slide.id);
  });
  if (sceneSlideIds.size + addedSlideIds.size > EDITABLE_DIVE_MAX_SLIDES) {
    editableDiveFail("INVALID_OVERRIDES", "too many slides after merge");
  }
  const deletedSlideIds = new Set();
  for (const id of deletedSlides) {
    if (typeof id !== "string" || !(sceneSlideIds.has(id) || addedSlideIds.has(id)) || deletedSlideIds.has(id)) {
      editableDiveFail("INVALID_OVERRIDES", `invalid or duplicate deletedSlides id ${String(id)}`);
    }
    deletedSlideIds.add(id);
  }
  const liveSlideIds = new Set(
    [...sceneSlideIds, ...addedSlideIds].filter((id) => !deletedSlideIds.has(id)),
  );
  for (const [id, value] of Object.entries(slidePatch)) {
    if (!liveSlideIds.has(id) || !isPlainRecord(value)) editableDiveFail("INVALID_OVERRIDES", `slidePatch target ${id} is invalid`);
    for (const key of Object.keys(value)) {
      if (!EDITABLE_DIVE_SLIDE_PATCH_KEYS.has(key)) editableDiveFail("INVALID_OVERRIDES", `slidePatch ${id}.${key} is not allowed`);
    }
    // The merged record goes through the same validator the scene's own slides do, so a patch
    // cannot type-corrupt a field the scene shipped valid.
    const target = baseSlideById.get(id) || { id };
    validateSlide({ ...target, ...value, id }, `slidePatch ${id}`, { code: "INVALID_OVERRIDES" });
  }
  if (rawOverrides.slideOrder !== undefined) {
    if (!Array.isArray(rawOverrides.slideOrder)) editableDiveFail("INVALID_OVERRIDES", "overrides.slideOrder must be an array");
    // Same reserved names as validateSlide: an order entry naming one could only ever be a typo or
    // a probe, since no slide may carry that id.
    for (const id of rawOverrides.slideOrder) {
      if (EDITABLE_DIVE_FORBIDDEN_KEYS.has(id)) editableDiveFail("INVALID_OVERRIDES", `overrides.slideOrder entry ${String(id)} is a reserved name`);
    }
  }
  added.forEach((element, index) => {
    const path = `overrides.added[${index}]`;
    validateElement(element, path, { added: true, deck });
    if (byId.has(element.id)) editableDiveFail("INVALID_OVERRIDES", `duplicate added id ${element.id}`);
    if (sceneSlideIds.has(element.id) || addedSlideIds.has(element.id)) {
      editableDiveFail("INVALID_OVERRIDES", `added id ${element.id} collides with a slide id`);
    }
    // `new-slide-N` also satisfies the element temp-id grammar, and it permanentizes to `slide-N`
    // — which is exactly the id a slide takes. An added element allowed to keep it would bake a
    // scene violating S2 (one id namespace): it renders fine and then fails EVERY later save with
    // `scene id slide-N collides with a slide id`, unrecoverable without hand-editing the JSX. The
    // bag is attacker-controlled, so the shape is refused here rather than repaired downstream.
    if (deck && EDITABLE_DIVE_TEMP_SLIDE_ID_RE.test(element.id)) {
      editableDiveFail("INVALID_OVERRIDES", `${path}.id ${element.id} is reserved for slides`);
    }
    byId.set(element.id, element);
    if (deck && !liveSlideIds.has(element.slide)) editableDiveFail("INVALID_OVERRIDES", `${path}.slide must name a live slide`);
  });
  const seenDeleted = new Set();
  for (const id of deleted) {
    if (typeof id !== "string" || !byId.has(id) || seenDeleted.has(id)) {
      editableDiveFail("INVALID_OVERRIDES", `invalid or duplicate deleted id ${String(id)}`);
    }
    seenDeleted.add(id);
  }
  for (const [id, value] of Object.entries(patch)) {
    const element = byId.get(id);
    if (!element || !isPlainRecord(value)) editableDiveFail("INVALID_OVERRIDES", `patch target ${id} is invalid`);
    const allowed = allowedPatchKeys(element.type, deck);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) editableDiveFail("INVALID_OVERRIDES", `patch ${id}.${key} is not allowed`);
    }
    // Moving an element to another slide is a one-key patch, and that key must land on a slide
    // that still exists after the deck edits above.
    if (deck && Object.hasOwn(value, "slide") && !liveSlideIds.has(value.slide)) {
      editableDiveFail("INVALID_OVERRIDES", `patch ${id}.slide must name a live slide`);
    }
    if (Object.hasOwn(value, "parent") && value.parent != null) {
      const parent = typeof value.parent === "string" ? byId.get(value.parent) : null;
      if (!parent || parent.type !== "group") editableDiveFail("INVALID_OVERRIDES", `patch ${id}.parent is invalid`);
    }
    for (const key of ["x", "y", "w", "z", "opacity"]) {
      if (Object.hasOwn(value, key) && !Number.isFinite(value[key])) {
        editableDiveFail("INVALID_OVERRIDES", `patch ${id}.${key} must be finite`);
      }
    }
    if (element.type === "table" && ["cells", "colWidths", "rowHeights", "border"].some((key) => Object.hasOwn(value, key))) {
      validateTableGeometry({ ...element, ...value }, `patch ${id}`, true);
    }
    // The same posture for the SQL table, and needed for the same reason: validateElement runs on
    // scene and ADDED elements only, so without this a patch could raise `limit` to 1e9 or turn
    // `border` into a string on an element that was perfectly valid when it was baked.
    if (element.type === "sqltable" && EDITABLE_DIVE_SQLTABLE_CHECKED_KEYS.some((key) => Object.hasOwn(value, key))) {
      validateSqlTable({ ...element, ...value }, `patch ${id}`, true);
    }
    if (Object.hasOwn(value, "h") && !(Number.isFinite(value.h) || (element.type === "text" && value.h === "auto"))) {
      editableDiveFail("INVALID_OVERRIDES", `patch ${id}.h is invalid`);
    }
    // The PATCH ITSELF, not the merged element — deliberately, and unlike the two tables above. A
    // merge is what they need because several of their keys must agree about ONE shape, so a patch
    // touching one can desynchronize the others. `build` is a single independent key, and the guard
    // has already established that the patch carries it, so `{ ...element, ...value }` could only
    // ever contribute the value already under test: the merge would be provably inert, which a
    // mutant confirmed. What matters is that the check runs on THIS path at all — validateElement
    // sees scene and ADDED elements only, so without it a bag could raise a step to 1e9 on an
    // element that was perfectly valid when it baked.
    if (Object.hasOwn(value, "build")) validateBuildStep(value, `patch ${id}`, true);
  }
  const deletedIds = new Set(deleted);
  let effective = [
    ...scene.elements.filter((element) => !deletedIds.has(element.id)),
    ...added.filter((element) => !deletedIds.has(element.id)),
    // Own-property, for the same reason mergeScene's lookup is (see patchFor there).
  ].map((element) => applyElPatch(element, Object.hasOwn(patch, element.id) ? patch[element.id] : undefined));
  if (deck) {
    // The strict resolver is the single place slideOrder validity and the "a deck keeps at least
    // one slide" rule are enforced; the runtime resolver tolerates both.
    const live = new Set(slidesOfStrict(scene, rawOverrides).map((slide) => slide.id));
    effective = effective.filter((element) => live.has(element.slide));
  }
  assertValidParentForest(effective, "INVALID_OVERRIDES", "merged overrides", { allowMissing: true });
  if (deck) assertOneSlidePerGroup(effective, "INVALID_OVERRIDES", "merged overrides");
  if (rawOverrides.page !== undefined) {
    if (!isPlainRecord(rawOverrides.page)) editableDiveFail("INVALID_OVERRIDES", "overrides.page must be an object");
    for (const key of Object.keys(rawOverrides.page)) {
      if (!["width", "height", "background"].includes(key)) editableDiveFail("INVALID_OVERRIDES", `overrides.page.${key} is not allowed`);
      if ((key === "width" || key === "height") && !Number.isFinite(rawOverrides.page[key])) {
        editableDiveFail("INVALID_OVERRIDES", `overrides.page.${key} must be finite`);
      }
    }
  }
  return { overrideBytes };
}

// `reservedIds` is THE namespace reservation, and bakeScene hands it reservedNamespaceIds — the
// base scene's elements and slides, every id the bag names, and every id a SLIDE could end up
// holding (its current id and, for a temporary one, the permanent id it is about to take). The
// elements passed in are the MERGED ones, so on their own they do not know about an id the bag has
// spent: a bag that deletes `sqltable-1` and adds `new-sqltable-1` used to be handed back the very
// id it had just tombstoned. Omitting the argument leaves this reserving live merged ids only.
export function permanentizeAddedIds(elements, addedIds, reservedIds) {
  const temporary = new Set(addedIds);
  const reserved = new Set(elements.filter((element) => !temporary.has(element.id)).map((element) => element.id));
  if (reservedIds) for (const id of reservedIds) reserved.add(id);
  const idMap = new Map();
  for (const element of elements) {
    if (!temporary.has(element.id)) continue;
    let candidate = element.id.slice(4);
    if (!EDITABLE_DIVE_ID_RE.test(candidate)) candidate = `${element.type}-1`;
    if (reserved.has(candidate)) {
      const stem = (candidate.replace(/-\d+$/, "") || element.type).slice(0, 110);
      let suffix = 1;
      while (reserved.has(`${stem}-${suffix}`)) suffix += 1;
      candidate = `${stem}-${suffix}`;
    }
    reserved.add(candidate);
    idMap.set(element.id, candidate);
  }
  const rewritten = elements.map((element) => ({
    ...element,
    id: idMap.get(element.id) || element.id,
    parent: element.parent == null ? null : (idMap.get(element.parent) || element.parent),
  }));
  return { elements: rewritten, idMap };
}

// The slide-side twin of permanentizeAddedIds: `new-slide-3` becomes `slide-3` (or the next free
// suffix), and every element pointer follows. Element ids are reserved too, because the two share
// one namespace and the element pass may just have minted `slide-3` from `new-slide-3` as an
// element id. slidePatch/slideOrder need no rewriting: bake resolves them into the effective
// slide list BEFORE this runs, so no reference to a temporary id survives into the baked scene.
//
// `addedSlideIds` is PROVENANCE, and it is the only thing that makes a slide temporary — the same
// contract permanentizeAddedIds has always had for elements. Matching the temp-id shape instead
// would rename a BASE slide an author legitimately named `new-slide-1` on any bag at all, mutating
// a scene nobody asked to change; the shape is only ever a format check at the boundary.
export function permanentizeSlideIds(slides, elements, addedSlideIds, reservedIds) {
  const temporary = new Set(addedSlideIds || []);
  const isTemporary = (id) => temporary.has(id) && EDITABLE_DIVE_TEMP_SLIDE_ID_RE.test(id);
  const reserved = new Set(elements.map((element) => element.id));
  // The same namespace reservation the element pass gets, for the same reason: `slides` is the
  // MERGED slide list, so a slide the bag deleted is absent from it and its id would otherwise be
  // handed straight to a newly added slide.
  if (reservedIds) for (const id of reservedIds) if (!isTemporary(id)) reserved.add(id);
  for (const slide of slides) {
    if (!isTemporary(slide.id)) reserved.add(slide.id);
  }
  const idMap = new Map();
  for (const slide of slides) {
    if (!isTemporary(slide.id)) continue;
    let candidate = slide.id.slice(4);
    if (reserved.has(candidate)) {
      let suffix = 1;
      while (reserved.has(`slide-${suffix}`)) suffix += 1;
      candidate = `slide-${suffix}`;
    }
    reserved.add(candidate);
    idMap.set(slide.id, candidate);
  }
  return {
    slides: slides.map((slide) => ({ ...slide, id: idMap.get(slide.id) || slide.id })),
    elements: elements.map((element) => (
      idMap.has(element.slide) ? { ...element, slide: idMap.get(element.slide) } : element
    )),
    idMap,
  };
}

export function removeEmptyGroups(elements) {
  const sanitized = sanitizeParents(elements);
  const byId = new Map(sanitized.map((element) => [element.id, element]));
  const keepGroups = new Set();
  for (const element of sanitized) {
    if (element.type === "group") continue;
    let current = parentOf(element);
    let guard = 0;
    while (current != null && guard < EDITABLE_DIVE_MAX_DEPTH + 2) {
      if (keepGroups.has(current)) break;
      const parent = byId.get(current);
      if (!parent || parent.type !== "group") break;
      keepGroups.add(current);
      current = parentOf(parent);
      guard += 1;
    }
  }
  return sanitized.filter((element) => element.type !== "group" || keepGroups.has(element.id));
}

// `z` is one global paint order. On a deck, `slideIndexById` (slideId -> deck position) sorts by
// (slideIndex, z) first, so every slide's leaves occupy one contiguous run of the global order —
// which is what keeps a per-slide renumber correct. Omit it and this is the v1 behaviour exactly.
export function renumberLeafZ(elements, slideIndexById) {
  const slideRank = (element) => (slideIndexById ? (slideIndexById.get(element.slide) ?? -1) : 0);
  const leaves = elements
    .filter((element) => element.type !== "group")
    .sort((a, b) => (slideRank(a) - slideRank(b)) || (a.z - b.z));
  const zById = new Map(leaves.map((element, index) => [element.id, (index + 1) * 10]));
  return elements.map((element) => (element.type === "group" ? element : { ...element, z: zById.get(element.id) }));
}

// A bake must never emit a scene its own validator would refuse: such a scene renders fine and
// then fails EVERY later save — even a no-op bag — with nothing but hand-editing the JSX to
// recover. The id-minting and repair steps above are meant to guarantee this; here it is asserted,
// because the failure is silent and permanent. The id-namespace check (spec S2) is spelled out
// first so the message names the real problem instead of the validator's scene path.
function assertBakedSceneValid(baked) {
  const slideIds = new Set(Array.isArray(baked.slides) ? baked.slides.map((slide) => slide.id) : []);
  for (const element of baked.elements) {
    if (slideIds.has(element.id)) {
      editableDiveFail("INVALID_SCENE", `bake produced element id ${element.id}, which collides with a slide id`, { stage: "post-bake" });
    }
  }
  try {
    validateBakeInput(baked, { v: baked.v, _base: baked.version, patch: {}, deleted: [], added: [] });
  } catch (error) {
    editableDiveFail("INVALID_SCENE", `bake produced a scene the validator rejects: ${error && error.message}`, {
      stage: "post-bake",
      cause: (error && error.code) || "UNKNOWN",
    });
  }
}

export function bakeScene(scene, rawOverrides, options) {
  validateBakeInput(scene, rawOverrides, options);
  const merged = mergeScene(scene, rawOverrides);
  if (merged.stale) editableDiveFail("STALE_BASE", "the overrides are stale");
  const added = rawOverrides.added || [];
  const deleted = rawOverrides.deleted || [];
  const liveAddedIds = added
    .map((element) => element.id)
    .filter((id) => !deleted.includes(id));
  const deck = isDeckScene(scene);
  const addedSlideIds = deck
    ? (rawOverrides.addedSlides || []).filter(isPlainRecord).map((slide) => slide.id).filter((id) => typeof id === "string")
    : [];
  // Every id a slide may hold once the slide pass below runs: its current id, plus — for a slide
  // the bag added — the permanent id it is about to claim. Reserving both keeps the element pass
  // from minting an element onto a slide id (spec S2, one namespace).
  const addedSlideIdSet = new Set(addedSlideIds);
  const slideIdReservations = deck
    ? merged.slides.flatMap((slide) => (
      addedSlideIdSet.has(slide.id) ? [slide.id, slide.id.slice(4)] : [slide.id]
    ))
    : undefined;
  // ONE reservation, from the ONE declared table (see EDITABLE_DIVE_BAG_KEYS): the base scene's
  // elements and slides, plus every id the bag names — including the ones it deleted, which is what
  // stops a mint being handed an id this very bag has already spent.
  const namespaceReservations = reservedNamespaceIds(scene, rawOverrides);
  // The element pass reserves that, PLUS the ids the slide pass below may hand out. It deliberately
  // over-reserves: `slideIdReservations` names the permanent id every temporary slide COULD claim,
  // and the slide pass may end up on a later suffix. Feeding those speculative ids back into the
  // slide pass would make a slide dodge an id nothing holds, so it gets the plain reservation.
  const permanentized = permanentizeAddedIds(merged.all, liveAddedIds,
    new Set([...namespaceReservations, ...(slideIdReservations || [])]));
  // mergeScene has already dropped every element whose slide vanished, so the empty-group
  // cascade sees exactly the survivors and a group left childless by a slide deletion goes too.
  const withoutEmptyGroups = removeEmptyGroups(permanentized.elements);
  const sanitized = sanitizeParents(withoutEmptyGroups);
  const slides = deck ? permanentizeSlideIds(merged.slides, sanitized, addedSlideIds, namespaceReservations) : null;
  const elements = renumberLeafZ(
    slides ? slides.elements : sanitized,
    slides ? new Map(slides.slides.map((slide, index) => [slide.id, index])) : undefined,
  );
  const baked = {
    ...scene,
    version: scene.version + 1,
    page: { ...merged.page },
    elements,
  };
  if (deck) baked.slides = slides.slides;
  assertBakedSceneValid(baked);
  const summary = {
    patched: Object.keys(rawOverrides.patch || {}).length,
    deleted: deleted.length,
    added: liveAddedIds.length,
    previousVersion: scene.version,
    newVersion: baked.version,
    elements: baked.elements.length,
  };
  if (deck) {
    const deletedSlides = rawOverrides.deletedSlides || [];
    const baseSlideIds = new Set(scene.slides.map((slide) => slide.id));
    summary.slides = baked.slides.length;
    // Both counts are NET changes to the deck, so they stay symmetric: adding then deleting the
    // same new slide is 0 and 0, not 0 and 1. Only a BASE slide's deletion removes anything.
    summary.slidesAdded = (rawOverrides.addedSlides || []).filter((slide) => !deletedSlides.includes(slide.id)).length;
    summary.slidesDeleted = deletedSlides.filter((id) => baseSlideIds.has(id)).length;
  }
  const result = { scene: baked, idMap: Object.fromEntries(permanentized.idMap), summary };
  // Slide renames ride their own map: the element idMap is what callers use to re-point a
  // selection, and mixing two namespaces into it would make that ambiguous.
  if (deck) result.slideIdMap = Object.fromEntries(slides.idMap);
  return result;
}

// A stable fingerprint of the patch-key allowlist. The Dive and this server must agree on which
// keys are patchable; when the server lags behind a Dive that gained a new patchable field, saves
// fail late with INVALID_OVERRIDES. Exposing this on /api/health makes a stale deploy visible
// without spending a real save to discover it.
export function patchKeyAllowlistFingerprint() {
  const shape = Object.keys(EDITABLE_DIVE_TYPE_KEYS).sort().map((type) => (
    `${type}:${[...EDITABLE_DIVE_COMMON_KEYS, ...EDITABLE_DIVE_TYPE_KEYS[type]].sort().join(",")}`
  )).join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < shape.length; i += 1) {
    hash ^= shape.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function mapRequiredResources(raw) {
  let resources = raw;
  if (typeof resources === "string") {
    try { resources = JSON.parse(resources); } catch {
      editableDiveFail("INVALID_RESOURCES", "MotherDuck returned malformed required resources");
    }
  }
  if (resources == null) return [];
  if (!Array.isArray(resources)) editableDiveFail("INVALID_RESOURCES", "MotherDuck required resources are not an array");
  return resources.map((resource, index) => {
    if (!isPlainRecord(resource)) editableDiveFail("INVALID_RESOURCES", `required resource ${index} is invalid`);
    assertSafeJson(resource, `requiredResources[${index}]`);
    const url = resource.url ?? resource.path;
    const alias = resource.alias;
    if (typeof url !== "string" || !url || typeof alias !== "string" || !alias) {
      editableDiveFail("INVALID_RESOURCES", `required resource ${index} needs url and alias`);
    }
    return { url, alias };
  });
}
// __INLINE_CORE_END__
