// Editable Dive — SLIDES fork of the `editable-dive` skill's framework template.
// Save runs a MotherDuck Flight (SAVE_FLIGHT_ID, flight/save_deck.py) that bakes the batched
// override bag into this Dive's SCENE and writes a new Dive version. Edits stay batched in the bag
// until the author clicks Save and confirms — a save rewrites the Dive and reloads it.
// Only the SCENE, REQUIRED_DATABASES and SAVE_FLIGHT_ID sentinel regions change per dive.
// Architecture: a declarative SCENE (pure JSON, sentinel-delimited) is rendered by a
// generic framework below. Live edits are sparse overrides stored in useDiveState("ov")
// (they travel with the URL); the skill's bake-back command merges them into SCENE.
// merge-core.mjs is the ONLY module shared with template.jsx; scripts/sync-merge-core.mjs
// keeps both templates' generated core regions byte-identical.

import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from "react";
import { useSQLQuery, useDiveState, useRunFlight, useFlightRun } from "@motherduck/react-sql-query";
import {
  ComposedChart, Line, Bar, Area, Scatter, XAxis, YAxis, ZAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  Pencil, Type, Image as ImageIcon, Square, Minus, BarChart3, Layers,
  Undo2, Redo2, Copy, RotateCcw, Trash2, Plus, GripVertical, X,
  AlignLeft, AlignCenter, AlignRight, MousePointer2,
  Maximize, MoveHorizontal, MoveVertical, UnfoldVertical, FoldVertical,
  ChevronUp, ChevronDown, ChevronsUp, ChevronsDown, Check, AlertTriangle,
  Play, Minimize, ChevronLeft,
  Folder, ChevronRight, Hand, Mouse, Crop, Table as TableIcon, Rows3, Columns3, Database,
  Circle, Triangle, Diamond, Hexagon, Star,
  Film, Eye, EyeOff, MoreVertical, ArrowUp, ArrowDown, LayoutTemplate, StickyNote,
  PanelRight,
  List, ListOrdered,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
  Save,
} from "lucide-react";

// __DBS_START__
export const REQUIRED_DATABASES = [];
// __DBS_END__

// __SAVE_FLIGHT_START__
const SAVE_FLIGHT_ID = "";
// __SAVE_FLIGHT_END__

// __SCENE_START__
const SCENE = {
  "v": 2,
  "version": 1,
  "page": { "width": 1280, "height": 720, "background": "#ffffff" },
  "slides": [
    { "id": "slide-1", "name": "Title" },
    { "id": "slide-2", "name": "Content" },
    { "id": "slide-3", "name": "Closing" }
  ],
  "elements": [
    { "id": "group-1", "type": "group", "name": "Title block", "parent": null, "slide": "slide-1" },
    { "id": "title-1", "type": "text", "name": "Title", "parent": "group-1", "slide": "slide-1", "x": 96, "y": 280, "w": 1000, "h": "auto", "z": 10, "opacity": 1,
      "text": "Untitled deck", "level": "h1", "fontSize": 56, "color": "#231f20", "align": "left" },
    { "id": "dek-1", "type": "text", "name": "Subtitle", "parent": "group-1", "slide": "slide-1", "x": 96, "y": 364, "w": 820, "h": "auto", "z": 20, "opacity": 1,
      "text": "This is a placeholder deck. Replace it via the editable-dive skill.", "level": "p", "fontSize": 20, "color": "#6a6a6a", "align": "left" },
    { "id": "rule-1", "type": "line", "name": "Accent rule", "parent": "group-1", "slide": "slide-1", "x": 96, "y": 424, "w": 64, "h": 8, "z": 30, "opacity": 1,
      "orientation": "h", "color": "#0777b3", "thickness": 3 },
    { "id": "head-2", "type": "text", "name": "Heading", "parent": null, "slide": "slide-2", "x": 96, "y": 88, "w": 1000, "h": "auto", "z": 40, "opacity": 1,
      "text": "Second slide", "level": "h2", "fontSize": 36, "color": "#231f20", "align": "left" },
    { "id": "body-2", "type": "text", "name": "Body", "parent": null, "slide": "slide-2", "x": 96, "y": 168, "w": 900, "h": "auto", "z": 50, "opacity": 1,
      "text": "Every slide shares one 1280x720 coordinate space; elements carry a slide key.", "level": "p", "fontSize": 20, "color": "#6a6a6a", "align": "left" },
    { "id": "head-3", "type": "text", "name": "Heading", "parent": null, "slide": "slide-3", "x": 96, "y": 320, "w": 1000, "h": "auto", "z": 60, "opacity": 1,
      "text": "Thanks", "level": "h2", "fontSize": 36, "color": "#231f20", "align": "left" }
  ]
};
// __SCENE_END__

// ── Design tokens ───────────────────────────────────────────────────────────
const T = {
  chromeBg: "#1b1b1f", panelBg: "#232327", panelBorder: "rgba(255,255,255,0.08)",
  inputBg: "#2c2c31", hover: "rgba(255,255,255,0.06)", activeRow: "rgba(61,155,217,0.18)",
  textHi: "#ececf1", textMut: "#9a9aa3", textFaint: "#6b6b74",
  accent: "#3d9bd9", selection: "#3d9bd9", guide: "#f24d80", danger: "#f0546c",
  canvasBg: "#141416",
  // The edit canvas SURROUND: the plane the slide sheet sits on. Its own token, not canvasBg (the
  // app shell behind the chrome), because it is the one colour four different things have to stay
  // visible against and they pull in opposite directions:
  //   • an element parked in the BLEED, in either default text colour (#231f20 ink, #6a6a6a muted)
  //   • the 1px hairline and the drop shadow that mark the sheet's edge
  //   • the white-based scrollbar thumb SCROLLBAR_CSS paints on this same surface
  //   • the hidden-slide dim, which composites the SLIDE against this colour
  // Measured (sRGB contrast): a near-black surround hides the ink (#141416 gives 1.13:1 — an
  // element set to Y:800 is simply gone) and hides the dim on a dark deck (1.00:1, no dim at all);
  // a light surround hides the muted grey, the thumb and the dim on a white deck. #46464c is the
  // maximin of the two text colours — 1.74:1 ink, 1.73:1 muted — and it keeps everything else:
  // the 0.14 thumb still reads at 1.50:1 (exactly what it had on #141416), and the dim now works
  // at BOTH ends (a white slide 2.84:1, a near-black slide 1.40:1). Neither text colour is
  // COMFORTABLE at 1.7:1; the bleed is a parking space, not a reading surface, and the property
  // this has to hold is that a parked element is still findable on screen.
  slideSurround: "#46464c",
  // The edit-mode slide edge. The hairline is LIGHT and sits just OUTSIDE the sheet, so it only
  // ever has to contrast with the one fixed surround colour (slideSurround) — never with the
  // slide's own background, which the author owns and may set to that very colour. Alpha is 0.3
  // rather than 0.18 because a mid surround eats a light hairline's budget: 0.3 over #46464c
  // composites to rgb(126,126,130) = 2.32:1 against the surround (and 4.04:1 against a white
  // sheet), where 0.18 would be 1.67:1 — below the 1.72:1 it had on the near-black surround.
  slideEdge: "0 0 0 1px rgba(255,255,255,0.3), 0 16px 44px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.4)",
  panelShadow: "0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35)",
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif",
  ease: "150ms cubic-bezier(0.2, 0, 0, 1)",
};
const PALETTE = ["#0777b3", "#bd4e35", "#2d7a00", "#e18727", "#638CAD", "#adadad"];
const LEVEL_STYLES = {
  h1: { size: 44, weight: 700, lh: 1.15, ls: "-0.02em" },
  h2: { size: 28, weight: 650, lh: 1.25, ls: "-0.015em" },
  h3: { size: 20, weight: 600, lh: 1.35, ls: "-0.01em" },
  p:  { size: 15, weight: 400, lh: 1.6,  ls: "0" },
  // A code snippet: monospaced, and drawn with a copy-to-clipboard button in its top-right corner
  // (CodeCopyButton). Like the list kinds it is a VALUE of `level`, so it needs no new scene key.
  code: { size: 18, weight: 400, lh: 1.5, ls: "0" },
  // A link: the element's text IS the URL, drawn underlined and opened in a new tab on click
  // (LinkText). Only http(s) URLs become links; anything else renders as plain text.
  link: { size: 24, weight: 600, lh: 1.35, ls: "0" },
};
const CODE_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
const CODE_COPY_PAD = 40;   // right gutter a code element keeps clear for its copy button
// Per-surface defaults for the chart's three text targets (see `chart.text` in reference.md).
const CHART_TEXT_DEFAULTS = {
  title: { fontSize: 13, fontWeight: 600, color: "#231f20", align: "left" },
  labels: { fontSize: 11, fontWeight: 400, color: "#6a6a6a" },
  ticks: { fontSize: 11, fontWeight: 400, color: "#6a6a6a" },
};
const HANDLE_DEFS = [
  { k: "nw", ax: -1, ay: -1, cursor: "nwse-resize" }, { k: "n", ax: 0, ay: -1, cursor: "ns-resize" },
  { k: "ne", ax: 1, ay: -1, cursor: "nesw-resize" },  { k: "e", ax: 1, ay: 0, cursor: "ew-resize" },
  { k: "se", ax: 1, ay: 1, cursor: "nwse-resize" },   { k: "s", ax: 0, ay: 1, cursor: "ns-resize" },
  { k: "sw", ax: -1, ay: 1, cursor: "nesw-resize" },  { k: "w", ax: -1, ay: 0, cursor: "ew-resize" },
];
const SNAP = 5;
// The largest override bag a save accepts: the same 64 KB limit the save Flight enforces.
const SAVE_OVERRIDE_MAX_BYTES = 65536;
const DIVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Edit-mode scrollbars: thin, square-cornered, low-alpha — scoped to .ed-scroll containers
// so the published view and page content keep native scrollbars.
const SCROLLBAR_CSS = `
.ed-scroll::-webkit-scrollbar{width:8px;height:8px}
.ed-scroll::-webkit-scrollbar-track{background:transparent}
.ed-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:0;border:none}
.ed-scroll::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.26)}
.ed-scroll::-webkit-scrollbar-corner{background:transparent}
.ed-scroll{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent}
.sql-editor-input::selection{background:#44475a;color:transparent}
`;
const TYPE_ICONS = { text: Type, image: ImageIcon, shape: Square, line: Minus, chart: BarChart3, table: TableIcon, sqltable: Database, group: Folder };
// Shape kinds. "rect" is the ORIGINAL div path (an absent `shape` prop means rect, so every
// pre-existing shape element keeps rendering through exactly the code it always used); the
// other five are drawn as an inline SVG in a 0..100 viewBox stretched to the element box.
const SHAPE_KINDS = [
  { k: "rect", label: "Rectangle", icon: Square, w: 200, h: 140, name: "Box" },
  { k: "ellipse", label: "Ellipse", icon: Circle, w: 160, h: 160, name: "Ellipse" },
  { k: "triangle", label: "Triangle", icon: Triangle, w: 200, h: 140, name: "Triangle" },
  { k: "diamond", label: "Diamond", icon: Diamond, w: 200, h: 140, name: "Diamond" },
  { k: "hexagon", label: "Hexagon", icon: Hexagon, w: 160, h: 160, name: "Hexagon" },
  { k: "star", label: "Star", icon: Star, w: 160, h: 160, name: "Star" },
];
const SHAPE_POINTS = {
  triangle: "50,0 100,100 0,100",
  diamond: "50,0 100,50 50,100 0,50",
  hexagon: "25,0 75,0 100,50 75,100 25,100 0,50",
  star: "50,0 61.2,34.5 97.6,34.5 68.2,55.9 79.4,90.5 50,69.1 20.6,90.5 31.8,55.9 2.4,34.5 38.8,34.5",
};
// One dash vocabulary shared by shape strokes and lines.
const DASH_OPTS = [{ k: "solid", label: "Solid" }, { k: "dashed", label: "Dashed" }, { k: "dotted", label: "Dotted" }];
const dashCss = (d) => (d === "dashed" ? "dashed" : d === "dotted" ? "dotted" : "solid");
const dashSvg = (d) => (d === "dashed" ? { strokeDasharray: "8 6" }
  : d === "dotted" ? { strokeDasharray: "2 6", strokeLinecap: "round" }
  : null);
const CAP_OPTS = [["none", "None"], ["arrow", "Arrow"], ["circle", "Circle"], ["square", "Square"]];
const MARQUEE_THRESHOLD = 4; // px of pointer travel before a background drag becomes a marquee
// Viewport zoom. `zoom` multiplies the measured fit-width scale; 1 = fit width (the old behaviour).
const PLANE_MARGIN = 240; // logical px of empty plane kept on every side of the used bounds
const ZOOM_MIN = 0.25, ZOOM_MAX = 4, ZOOM_STEP = 1.25;
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
const roundZoom = (z) => Math.round(clampZoom(z) * 100) / 100;
const LEFT_PANE_DEFAULT = 240, RIGHT_PANE_DEFAULT = 260;
const PANE_MIN_WIDTH = 180, PANE_MAX_WIDTH = 560, CANVAS_MIN_WIDTH = 240;
// The single-pane and both-pane clamps this fork used to carry (clampPaneWidth / clampPaneWidths)
// are gone: with THREE hideable, resizable chrome columns the budget is no longer "me versus the
// opposite pane", so both were generalized into clampPanelDrag / clampPanelWidths in the panel
// layout section below. template.jsx, which has two panes and no rail, still carries the pair.

// ── Filmstrip geometry (pure) ───────────────────────────────────────────────
// The rail is a RESIZABLE-width column of FIXED-HEIGHT rows — number gutter, thumbnail, caption.
// The constants are layout; the four functions are the only arithmetic, and they are pure and
// unit-tested because the drop index is the classic off-by-one and a virtual window that disagrees
// with the scrollbar by one row is invisible until a 200-slide deck exposes it.
//
// The rail SHIPPED fixed at 96px, on the argument that "a thumbnail has one size". That was wrong
// for the same reason the layers pane is draggable: a 40-slide deck of dense slides is navigated by
// reading the thumbnails, and 70px of thumbnail cannot be read. Every dimension below the rail
// already derives from its width in ONE place (filmThumbBox), so making the width a variable costs
// nothing but the budget re-derivation — which the panel layout section does.
const FILM_DEFAULT_WIDTH = 96;    // the width it shipped at, and the double-click reset target
// 72 leaves a 46x26 thumbnail — the smallest at which a slide's block structure is still legible and
// the caption still fits a word or two; below that the rail is a list of grey rectangles. 240 leaves
// a 214x120 thumbnail, big enough to read a slide TITLE off, and is deliberately under
// PANE_MAX_WIDTH so the deck navigator can never be the widest thing on screen.
const FILM_MIN_WIDTH = 72, FILM_MAX_WIDTH = 240;
const FILM_PAD_X = 5;             // rail inner padding, each side
const FILM_NUM_W = 13;            // number gutter: the number sits OUTSIDE the thumbnail, never over it
const FILM_NUM_GAP = 3;
const FILM_CAPTION_H = 12;        // reserved whether the slide is named or not, so rowH is constant
const FILM_ROW_GAP = 8;
const FILM_OVERSCAN = 4;          // rows mounted above and below the viewport
const FILM_VIRTUALIZE_FROM = 40;  // at or below this many slides, mount the whole deck (plan §2)
const FILM_AUTOSCROLL_EDGE = 24;  // px from a rail edge where a reorder drag scrolls the rail
const FILM_AUTOSCROLL_STEP = 16;

// Thumbnail box for a pageW×pageH slide inside `railWidth`. The aspect ratio follows the page, so a
// 1280×720 deck gets 16:9 thumbnails and the scale falls out of the width — one source of truth for
// "how big is a thumbnail", which the drop math and the window then both read.
function filmThumbBox(pageW, pageH, railWidth) {
  const rail = Number(railWidth) > 0 ? Number(railWidth) : FILM_DEFAULT_WIDTH;
  const w = Math.max(24, Math.round(rail - FILM_PAD_X * 2 - FILM_NUM_W - FILM_NUM_GAP));
  const pw = Number(pageW) > 0 ? Number(pageW) : 1280;
  const ph = Number(pageH) > 0 ? Number(pageH) : 720;
  return { w, h: Math.max(12, Math.round((w * ph) / pw)), scale: w / pw };
}

const filmRowHeight = (thumbH) => Math.max(1, Math.round(Number(thumbH) || 0)) + FILM_CAPTION_H + FILM_ROW_GAP;

// Rows are absolutely positioned at index*rowH inside a container of the FULL height, so the
// mounted window is a slice with no spacer elements to keep in sync — the scrollbar is correct at
// every scroll offset whether a row is mounted or not. Below `virtualizeFrom` slides the whole deck
// mounts: windowing a 12-slide deck costs more than it saves and only adds a way to be wrong.
function filmWindow(count, rowH, scrollTop, viewportH, overscan, virtualizeFrom) {
  const n = Math.max(0, Math.trunc(Number(count)) || 0);
  const row = Number(rowH);
  if (n === 0 || !(row > 0)) return { start: 0, end: n };
  if (Number.isFinite(Number(virtualizeFrom)) && n <= Number(virtualizeFrom)) return { start: 0, end: n };
  const over = Math.max(0, Math.trunc(Number(overscan)) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const view = Math.max(row, Number(viewportH) || 0);
  // `end` is computed first because `start` is clamped into [0, end]: the two come from
  // DIFFERENT facts — start from the scroll offset, end from the count — with nothing relating
  // them, so a deck that shrank by more than a viewport while the rail was scrolled to the bottom
  // produced start > end, which the render loop reads as "mount nothing": a blank rail over a
  // full-height scroll container, with no row left to scroll back with.
  const end = Math.min(n, Math.ceil((top + view) / row) + over);
  return { start: Math.min(Math.max(0, Math.floor(top / row) - over), end), end };
}

// The insertion SLOT the pointer sits in, in the full list's coordinates: 0 is above row 0 and
// `count` is past the last row. Rounding rather than flooring is what makes the top half of a row
// mean "the gap above me" and the bottom half "the gap below me".
function filmSlotAt(contentY, rowH, count) {
  const n = Math.max(0, Math.trunc(Number(count)) || 0);
  const row = Number(rowH);
  if (!(row > 0)) return 0;
  return Math.max(0, Math.min(n, Math.floor(Math.max(0, Number(contentY) || 0) / row + 0.5)));
}

// The "no drop" marker: a drag with no valid target. Negative on purpose — every consumer tests
// `>= 0` — and TOTAL: no input to filmDropIndex or filmDragTarget yields an out-of-domain index.
// It has to be, because buildReorderedSlides deliberately CLAMPS a negative toIndex to 0, so a bad
// index would silently slam the slide to the top of the deck instead of being refused. The glue
// (moveSlide) refuses it a second time, so the guard is not one `&&` in one component.
const FILM_NO_DROP = -1;

// Slot -> the `toIndex` buildReorderedSlides wants, which counts in the list with the dragged slide
// REMOVED — hence the shift for every slot below the drag origin. Returns FILM_NO_DROP when the
// move is a no-op — the two slots either side of the dragged row are where it already is, so a drag
// that ends where it started commits nothing and paints no indicator — and for ANY out-of-domain
// input: a negative slot is not "slot 0", it is nowhere.
function filmDropIndex(from, slot) {
  const f = Math.trunc(Number(from));
  const s = Math.trunc(Number(slot));
  if (!Number.isFinite(f) || !Number.isFinite(s) || f < 0 || s < 0) return FILM_NO_DROP;
  const at = s > f ? s - 1 : s;
  return at === f ? FILM_NO_DROP : at;
}

// ── Reorder drag decisions (pure) ───────────────────────────────────────────
// The drag's three judgements, lifted out of the pointer closures into functions a test can drive:
// where a pointer would drop, whether the rail should autoscroll, and what a release does. The
// LIFECYCLE stays in the component — it is interleaved DOM reads and writes (measure the rail,
// move its scrollTop, re-read what the browser clamped it to) with nothing left to decide.

// The drop target for a pointer at (x, y) during a drag from row `from`. `rail` is the rail's
// client box and `scrollTop` its CURRENT offset, so a rail that scrolled under a held pointer
// re-derives the slot instead of keeping one computed against the offset the pointer last saw.
//
// Horizontally outside the rail is ABANDON — no slot, no indicator, no commit. "Drag it away to
// drop nothing" is universal, and without this a release over the canvas, the layers tree or the
// inspector still wrote a new slide order. Vertically outside is NOT abandon: above the rail means
// slot 0 and below it the last slot, which is how "drag to the very top/bottom" has to work.
function filmDragTarget(from, count, rowH, rail, scrollTop, x, y) {
  const px = Number(x);
  const py = Number(y);
  const left = rail ? Number(rail.left) : NaN;
  const right = rail ? Number(rail.right) : NaN;
  const top = rail ? Number(rail.top) : NaN;
  if (!(px >= left) || !(px <= right) || !Number.isFinite(top) || !Number.isFinite(py)) {
    return { slot: FILM_NO_DROP, to: FILM_NO_DROP };
  }
  const slot = filmSlotAt(py - top + (Number(scrollTop) || 0), rowH, count);
  return { slot, to: filmDropIndex(from, slot) };
}

// Rail scroll delta while a drag hovers near a vertical edge — 0 unless the pointer is over the
// rail, so a drag held out over the canvas stops scrolling the rail it left.
function filmAutoscrollDelta(rail, x, y) {
  if (!rail) return 0;
  const px = Number(x);
  const py = Number(y);
  if (!(px >= Number(rail.left)) || !(px <= Number(rail.right))) return 0;
  if (py < Number(rail.top) + FILM_AUTOSCROLL_EDGE) return -FILM_AUTOSCROLL_STEP;
  if (py > Number(rail.bottom) - FILM_AUTOSCROLL_EDGE) return FILM_AUTOSCROLL_STEP;
  return 0;
}

// What a release does. `commit` is false for a cancel (Escape, pointercancel). Click suppression is
// for a COMMITTED drag ONLY: a cancelled or abandoned drag is followed by an ordinary click, so
// setting the flag there swallowed the author's NEXT click on a row and that slide never opened.
function filmDragEnd(drag, commit) {
  const ok = !!(drag && commit && drag.moved && drag.to >= 0);
  return { commit: ok ? { to: drag.to, id: drag.id } : null, suppress: ok };
}

// A drag captures its origin index at pointerdown. If the deck changes under it — ⌘Z while the
// pointer is still down — that index means a different slide and the release lands one row from the
// painted indicator. The signature is the live slide-id order; any change cancels the drag.
const filmDeckSig = (slides) => (slides || []).map((s) => (s && s.id) || "").join("\u0001");
function filmDragStale(drag, sig) {
  return !!drag && drag.sig !== sig;
}

// Leaves grouped by slide, REUSING the previous group's array whenever that slide's leaves are
// identity-identical. mergeScene hands back the very same element object for every element the bag
// does not touch (applyElPatch returns its input when there is no patch, and sanitizeParents
// returns its element unchanged when nothing needs fixing — both are load-bearing HERE, and both
// now say so at their definitions in the shared core), so an edit on one slide leaves every other
// slide's array reference alone — which is the whole reason a memoized thumbnail can skip. Without
// this, the merge's fresh outer array would invalidate all of them per keystroke.
//
// One known, accepted leak: an element whose `parent` points at a non-group or at nothing is
// REWRITTEN by sanitizeParents on every merge, so it is a fresh object every time and its slide's
// thumbnail re-renders for the life of the session. It is one slide out of the deck, the scene it
// takes is already malformed, and "fixing" it would mean caching normalization results in the
// shared core — so it is left alone.
function groupLeavesBySlide(leaves, prev) {
  const next = new Map();
  for (const el of leaves || []) {
    const key = el && el.slide;
    if (key == null) continue;
    const bucket = next.get(key);
    if (bucket) bucket.push(el);
    else next.set(key, [el]);
  }
  if (!prev) return next;
  for (const [key, list] of next) {
    const old = prev.get(key);
    if (old && old.length === list.length && old.every((el, i) => el === list[i])) next.set(key, old);
  }
  return next;
}

// ── Panel layout (pure) ─────────────────────────────────────────────────────
// THE BUDGET. Edit mode is four columns in one flex row: the rail, the layers pane, the canvas, the
// inspector. Three of them are resizable AND hideable, which is why this arithmetic is a pure
// function with an exhaustive test rather than three clamps scattered through the root — the old
// pair of clamps could only ever reason about "me and the opposite pane", and the rail was excluded
// from the budget entirely by being a fixed width subtracted up front.
//
// Two facts make the numbers exact:
//   • A HIDDEN panel is not rendered, so it contributes 0 — not a collapsed width, not a 1px border.
//   • Every panel is border-box, so its declared width IS its layout width. The rail already was;
//     the layers pane and the inspector were not, so each depended on the HOST page having a
//     border-box reset. See the three `boxSizing` declarations: they are hardening against a host
//     with no reset, and the "238 instead of 240" figure an earlier commit message claimed for them
//     is NOT a defect anyone measured in the runtime harness — that harness loads Tailwind's
//     preflight, which already sets `box-sizing: border-box` on `*`, so the panes were border-box
//     there whether or not they said so. What IS true: declaring it makes the four-term sum exact
//     without depending on the embedder, and `rail + left + right + canvas` adds up to the row.
const PANEL_LIMITS = {
  rail: [FILM_MIN_WIDTH, FILM_MAX_WIDTH, FILM_DEFAULT_WIDTH],
  left: [PANE_MIN_WIDTH, PANE_MAX_WIDTH, LEFT_PANE_DEFAULT],
  right: [PANE_MIN_WIDTH, PANE_MAX_WIDTH, RIGHT_PANE_DEFAULT],
};
// The order a too-narrow viewport takes width BACK in. The inspector first (widest, and the one a
// narrow window hurts least), then the layers pane, then the rail — the rail is the deck's navigator
// and the narrowest of the three, so it is the last thing a resize should shrink.
const PANEL_SHRINK_ORDER = ["right", "left", "rail"];
const PANEL_KEYS = ["rail", "left", "right"];

// Every panel starts on. VISIBILITY IS EPHEMERAL VIEWPORT STATE — the same class as `activeSlideId`,
// `activeCell`, the notes strip's open flag and the autofit map: it lives in component state, it is
// never written to the override bag, and "I collapsed the inspector on my laptop" is not an edit the
// next person to open the URL should inherit. Same for the rail width beside it.
const PANEL_SHOWN_DEFAULT = { rail: true, left: true, right: true };

// One click. Normalizing through the default matters because the caller's object may predate a key.
function togglePanelShown(shown, key) {
  if (!PANEL_LIMITS[key]) return { ...PANEL_SHOWN_DEFAULT, ...(shown || null) };
  const base = { ...PANEL_SHOWN_DEFAULT, ...(shown || null) };
  return { ...base, [key]: !base[key] };
}

// The rail exists only for a DECK, so on a v1 scene its flag is not a preference the author can
// express — it is forced off. That is what stops the budget reserving width for a column that is
// never rendered, and what stops a Slides toggle appearing where there are no slides.
function panelsShownFor(shown, isDeck) {
  const base = { ...PANEL_SHOWN_DEFAULT, ...(shown || null) };
  return { rail: !!(isDeck && base.rail), left: !!base.left, right: !!base.right };
}

// WHAT A HIDDEN INSPECTOR IS HOLDING THAT NOTHING ELSE SHOWS — a phrase, or null for "nothing you
// cannot reach another way". This is the dot's oracle, and it is deliberately NOT "there is a
// selection".
//
// The first version was `!panelsShown.right && selection.length > 0`, and it missed the case that
// matters most on a deck: with NOTHING selected the inspector shows the SLIDE section, and that
// section's Background field exists nowhere else in the editor. The rail's row menu has
// duplicate / rename / move / hide / delete and no background; the notes strip has notes. So
// deselecting and hiding the inspector put per-slide background permanently out of reach with no
// signal at all — no dot, and no mention of it anywhere on screen.
//
// The phrase is also the ACCESSIBLE half. A 5px accent dot is `aria-hidden` and cannot be anything
// else, so the same string goes into the toggle's name: without it the button's name was
// byte-identical with and without the dot, and a screen-reader user got nothing.
function inspectorHiddenHolds(hasSelection, hasSlide) {
  if (hasSelection) return "the selected element's properties";
  if (hasSlide) return "this slide's background and name";
  return null;
}

// The LAYERS panel's half of the same signal, and it exists because of ONE thing: the build order
// lives here now. The tree itself was never an argument for the dot — everything a tree row does
// (select, rename, reorder, reparent) the canvas and the keyboard do too — but adding, removing and
// reordering a build step exist nowhere else in the editor, so a deck author who hides this panel
// has genuinely lost the feature until they bring it back. A v1 scene cannot carry `build` at all,
// and there the panel holds nothing unique, so it gets no dot.
function layersHiddenHolds(isDeck) {
  return isDeck ? "this slide's build order" : null;
}

// IS THIS A WIDTH AT ALL? One validator in front of every coercion, because `Number()` answers the
// wrong question twice over. `Number(false)`, `Number("")` and `Number("   ")` are all 0 — finite,
// so a plain finite check accepted them and the min-clamp then turned each into "collapse this panel
// to 180", the exact opposite of what an unreadable width should do. And `Number(Symbol())` and
// `Number(Object.create(null))` THROW, so a bare coercion could take the whole editor down over a
// value that merely was not a number. So: a real finite number, or a string that parses to one.
// Everything else is `null`, meaning "not a width" — and the two callers answer that differently
// (restore the panel's default; ignore the drag frame).
function panelWidthNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// One panel against its OWN limits. This is the RESTORE / NORMALIZE path — a remembered width read
// back out of state, a double-click reset, a bag that predates a key — and here a value that is not
// a width falls back to that panel's DEFAULT rather than to its minimum: garbage should restore the
// panel, not collapse it. A live drag wants the opposite answer and gets it from panelDragRequest.
function clampPanelWidth(key, requested) {
  const lim = PANEL_LIMITS[key];
  if (!lim) return 0;
  const wanted = panelWidthNumber(requested);
  if (wanted === null) return lim[2];
  return Math.max(lim[0], Math.min(lim[1], wanted));
}

// A MEASURED row, or null. `null`/`undefined`/NaN is "not measured yet" — and so is 0, which is what
// clientWidth reads before the first layout: `Number(null)` is 0 and finite, so a plain finite check
// let an unmeasured row drive every panel to its minimum and report a negative canvas.
function panelRowWidth(containerWidth) {
  const w = panelWidthNumber(containerWidth);
  // `w > 0` carries the "not measured yet" case on its own, so there is deliberately no separate
  // null guard: panelWidthNumber already rejects null/undefined/booleans/"" and every non-number.
  // FLOORED, because a measured row can be FRACTIONAL — a zoomed browser, a scaled iframe, or any
  // getBoundingClientRect-shaped measurement — and the budget's exact-sum claim is integer
  // arithmetic that IEEE-754 does not survive (100.1 - 96 - 240 - 260 does not come back exact).
  // `clientWidth`, which is what the editor actually passes, is already an integer, so this is a
  // policy for every other caller: round DOWN, because the budget must never claim room the row
  // does not have.
  return w !== null && w > 0 ? Math.floor(w) : null;
}

// Are the requested VISIBILITIES feasible at this width — i.e. can every shown panel sit at its
// minimum and still leave the canvas its floor? Below that (a very narrow window, or an embed) the
// panels keep their minima and the canvas is what gives, which is the same trade the two-pane
// version documented. Exported so the test can DERIVE the floor claim from the same predicate the
// clamp uses, instead of restating a number.
function panelBudgetFeasible(shown, containerWidth) {
  const w = panelRowWidth(containerWidth);
  if (w === null) return true;
  let mins = 0;
  for (const key of PANEL_KEYS) if (shown && shown[key]) mins += PANEL_LIMITS[key][0];
  return mins + CANVAS_MIN_WIDTH <= w;
}

// THE upper bound for a LIVE drag of one panel: everything else visible, plus the canvas floor, is
// off limits. The other panels are read at their own clamped widths, so a drag cannot be given room
// that a second panel's own maximum would never have used.
function clampPanelDrag(key, requested, widths, shown, containerWidth) {
  const lim = PANEL_LIMITS[key];
  if (!lim) return 0;
  const wanted = clampPanelWidth(key, requested);
  const w = panelRowWidth(containerWidth);
  if (w === null) return wanted;
  let others = 0;
  for (const other of PANEL_KEYS) {
    if (other === key || !(shown && shown[other])) continue;
    others += clampPanelWidth(other, widths ? widths[other] : undefined);
  }
  const upper = Math.max(lim[0], Math.min(lim[1], w - others - CANVAS_MIN_WIDTH));
  return Math.max(lim[0], Math.min(upper, wanted));
}

// THE LIVE DRAG AS THE HANDLER SEES IT: one pointer frame in, and either a width to write or `null`
// meaning "ignore this frame". Two reasons it is its own function rather than more code inside the
// handler.
//
// First, a non-finite request must not be DEFAULTED. `clampPanelDrag("left", 400 + (NaN - 10), …)`
// returns 240 — the default — so one unreadable pointer delta silently reset a 400px pane the author
// had sized. "Garbage restores the default" is right for a restore and wrong for a drag, where the
// only correct response to a frame you cannot read is to keep the width you already have. The guard
// lives here, in front of the defaulting clamp, and nowhere else.
//
// Second, the WIRING needed an oracle. Every budget assertion tested the pure clamps and nothing
// asserted that the drag handler called them correctly, so three different mistakes survived the
// whole suite: write the raw pointer delta unclamped (the canvas drops through its floor), clamp to
// the dragged panel's own limits only (which IS the pre-fix rail-exclusion bug, restored), and pass
// a stale visibility (a hidden neighbour still charges its width). With the decision in one pure
// function the handler is a single call, and all three are one assertion each.
function panelDragRequest(key, requested, widths, shown, containerWidth) {
  if (!PANEL_LIMITS[key]) return null;
  if (panelWidthNumber(requested) === null) return null;
  return clampPanelDrag(key, requested, widths, shown, containerWidth);
}

// Reconcile ALL THREE at once — after a browser resize, and after a panel is shown again into a row
// that has since narrowed. Returns the effective width of each panel (0 when hidden) and the canvas
// width that is left, so the caller never has to re-add the columns up itself.
function clampPanelWidths(widths, shown, containerWidth) {
  const out = { rail: 0, left: 0, right: 0 };
  for (const key of PANEL_KEYS) {
    if (!(shown && shown[key])) continue;
    out[key] = clampPanelWidth(key, widths ? widths[key] : undefined);
  }
  const w = panelRowWidth(containerWidth);
  const sum = () => out.rail + out.left + out.right;
  if (w === null) return { ...out, canvas: null, feasible: true };
  let excess = sum() - (w - CANVAS_MIN_WIDTH);
  for (const key of PANEL_SHRINK_ORDER) {
    if (excess <= 0) break;
    if (!out[key]) continue;
    const give = Math.min(excess, out[key] - PANEL_LIMITS[key][0]);
    out[key] -= give;
    excess -= give;
  }
  return { ...out, canvas: w - sum(), feasible: panelBudgetFeasible(shown, w) };
}

// ── Pure helpers ────────────────────────────────────────────────────────────
const N = (v) => (v == null ? 0 : Number(v));
const numOrNull = (v) => (v == null ? null : Number(v));
const byteLen = (obj) => { try { return new TextEncoder().encode(JSON.stringify(obj)).length; } catch { return 0; } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const R = Math.round;
// The two element types whose content comes from a QUERY. Every place that treats "chart" specially
// — the canvas and present-mode renderers, the pointer shield, the rail's inert stub, present mode's
// prefetch set — is really asking this, and asking it by name is what kept the SQL table from
// silently missing one of them.
const isLiveSQL = (el) => !!el && (el.type === "chart" || el.type === "sqltable");

const SQL_EDITOR_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
const SQL_EDITOR_FONT_SIZE = 12;
const SQL_EDITOR_LINE_HEIGHT = 18;
const SQL_EDITOR_PADDING = "10px";
// Populated once per session from duckdb_keywords()/duckdb_functions(). Used for syntax
// highlighting only -- the editor deliberately ships no completion popup, because the Dive
// sandbox validator rejects both `SET autoload_known_extensions` and `INSTALL autocomplete`
// as non-read-only, so DuckDB's sql_auto_complete() table function is unreachable here.
const SQL_VOCABULARY_CACHE = { keywords: null, functions: null };

// SQL tokenization is deliberately lossless: concatenating token.text always reproduces the
// input byte-for-byte, so the painted mirror can never move the textarea's caret or selection.
function tokenizeSQL(value, keywords = new Set(), functions = new Set()) {
  const input = String(value == null ? "" : value);
  const tokens = [];
  const push = (type, start, end, extra) => tokens.push({ type, text: input.slice(start, end), ...(extra || {}) });
  let i = 0;
  while (i < input.length) {
    const start = i;
    const ch = input[i];
    const next = input[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
      while (i < input.length && /\s/.test(input[i])) i += 1;
      push("plain", start, i);
      continue;
    }
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i += 1;
      push("comment", start, i, { closed: i < input.length });
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < input.length && depth > 0) {
        if (input[i] === "/" && input[i + 1] === "*") { depth += 1; i += 2; }
        else if (input[i] === "*" && input[i + 1] === "/") { depth -= 1; i += 2; }
        else i += 1;
      }
      push("comment", start, i, { closed: depth === 0 });
      continue;
    }
    if (ch === "'") {
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] !== "'") { i += 1; continue; }
        if (input[i + 1] === "'") { i += 2; continue; }
        i += 1;
        closed = true;
        break;
      }
      push("string", start, i, { closed });
      continue;
    }
    if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < input.length) {
        if (input[i] !== '"') { i += 1; continue; }
        if (input[i + 1] === '"') { i += 2; continue; }
        i += 1;
        closed = true;
        break;
      }
      push("identifier", start, i, { quoted: true, closed });
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && /\d/.test(next || ""))) {
      const match = input.slice(i).match(/^(?:\d+(?:_\d+)*(?:\.\d*(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?/);
      i += match ? match[0].length : 1;
      push("number", start, i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      i += 1;
      while (i < input.length && /[A-Za-z0-9_$]/.test(input[i])) i += 1;
      const word = input.slice(start, i).toLowerCase();
      push(keywords.has(word) ? "keyword" : functions.has(word) ? "function" : "identifier", start, i);
      continue;
    }
    i += 1;
    while (i < input.length && !/\s|[A-Za-z0-9_'\"]/.test(input[i])
      && !(input[i] === "-" && input[i + 1] === "-")
      && !(input[i] === "/" && input[i + 1] === "*")) i += 1;
    push("operator", start, i);
  }
  return tokens;
}

function sqlTokenLines(tokens) {
  const lines = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((text, index) => {
      if (text) lines[lines.length - 1].push({ ...token, text });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines;
}

function sqlGutterCells(lineHeights, fallbackHeight = SQL_EDITOR_LINE_HEIGHT) {
  return lineHeights.map((height, index) => ({
    line: index + 1,
    height: Number.isFinite(height) && height > 0 ? height : fallbackHeight,
  }));
}

function columnOptionsWithMissing(value, options, availableColumns = options) {
  const shown = [...new Set((options || []).filter((column) => column != null).map(String))];
  const available = new Set((availableColumns || []).map(String));
  const selected = value == null || value === "" ? null : String(value);
  const out = shown.map((column) => ({ value: column, label: column, missing: false }));
  if (selected != null && !shown.includes(selected)) {
    out.unshift({ value: selected, label: available.has(selected) ? selected : `${selected} (missing)`, missing: !available.has(selected) });
  }
  return out;
}

function missingChartColumns(config, availableColumns) {
  const cfg = config || {};
  const keys = [];
  if (cfg.x && cfg.x.key) keys.push(cfg.x.key);
  for (const series of Array.isArray(cfg.series) ? cfg.series : []) if (series && series.key) keys.push(series.key);
  if (cfg.kind === "scatter" && cfg.scatter && cfg.scatter.sizeKey) keys.push(cfg.scatter.sizeKey);
  const available = new Set((availableColumns || []).map(String));
  return [...new Set(keys.map(String).filter((key) => !available.has(key)))];
}

// A freshly inserted chart's query is a LITERAL VALUES table, deliberately. The two
// alternatives both hand the author a broken first frame: an empty `sql` renders the error
// banner (ChartBlock's useSQLQuery is unconditional, so "no query" and "bad query" look the
// same), and any guessed `FROM <table>` names a catalog THIS dive may not have attached, so it
// fails with a Catalog Error that reads like a bug in the editor. A VALUES table touches no
// catalog, so it cannot fail on any DuckDB the dive can reach, it draws real bars immediately,
// and its two columns pre-fill the inspector's X/Series pickers — the author's first act is
// replacing the query, not wiring axes to a chart that shows nothing.
const CHART_DEFAULT_SQL = "SELECT * FROM (VALUES ('A',30),('B',55),('C',40)) t(label,value)";
const CHART_DEFAULT_W = 560;
const CHART_DEFAULT_H = 320;

// Where an inserted box LANDS — shared by every insert type, so the largest default (the chart's
// 560x320) and the smallest (a line's 240x12) get the same guarantee: the first frame of a new
// element is entirely ON the slide.
//
// It centres on the point the author is looking at, then CLAMPS that centre by the box's own half
// extent. The clamp is the whole point: the viewport centre is not the page centre at any zoom
// past fit, and the mint is measured off the live page box, so at 400% scrolled to the sheet's
// top-left corner the visible window is only ~342x327 page units and its centre is (171, 163) —
// an unclamped 560x320 chart starts at x:-109, a fifth of its area in the bleed, on a frame too
// small to show the author what happened. A box that CANNOT fit (bigger than the sheet, or an
// unmeasured page) centres on it instead of being pinned to one edge: the same overhang, made
// symmetric, because there is no position that satisfies the clamp and pinning would look like a
// bug. Nothing here clips or moves an element afterwards — the bleed stays legal and reachable;
// this only decides where a BRAND-NEW box starts.
function insertRect(cx, cy, w, h, page) {
  const fit = (v, size, extent) => {
    if (!(extent > 0)) return N(v);                            // no page measured: nothing to clamp against
    if (!(size > 0) || size >= extent) return N(extent) / 2;   // cannot fit: centre the overhang
    const half = N(size) / 2;
    return Math.min(Math.max(N(v), half), N(extent) - half);
  };
  return { x: R(fit(cx, w, page && page.width) - w / 2), y: R(fit(cy, h, page && page.height) - h / 2), w, h };
}

// Minted config is the SMALLEST one that is both drawable and honestly described in the
// inspector: `x.key` + one series (DynamicChart refuses to draw without them), plus two keys the
// renderer would otherwise decide for itself.
//
// `kind` because ChartSection gates its Bar size / Radius rows on `kind === "bar"`, so omitting it
// to save 15 bytes would hide two controls that apply to the chart on screen. And `y.domain:
// "zero"` for the same class of reason, on the chart itself: a bar encodes magnitude by LENGTH, so
// an axis that does not start at 0 misstates every ratio in the picture. Recharts' auto domain
// puts these three values (30/55/40) on a 28→56 axis, where bar A is a ~7%-height stub and B looks
// ~8x A instead of 1.8x — the textbook way to mislead with a bar chart, shipped as the first chart
// every author sees. Every hand-authored chart in the reference deck carries `y.domain: "zero"`
// and reference.md prescribes it for bar charts, so the default now agrees with the corpus, and
// the inspector's Y Domain control reads "From 0" instead of contradicting it with "Auto".
function newChartElement(common, cx, cy, page) {
  return {
    ...common, type: "chart",
    ...insertRect(cx, cy, CHART_DEFAULT_W, CHART_DEFAULT_H, page),
    sql: CHART_DEFAULT_SQL,
    chart: { kind: "bar", x: { key: "label" }, y: { domain: "zero" }, series: [{ key: "value" }] },
  };
}

// __MERGE_CORE_START__
// Generated from merge-core.mjs. Run scripts/sync-merge-core.mjs; do not edit this region.
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
function allowedBagKeys(deck) {
  const keys = new Set();
  for (const key of Object.keys(EDITABLE_DIVE_BAG_KEYS)) {
    if (deck || !EDITABLE_DIVE_BAG_KEYS[key].deckOnly) keys.add(key);
  }
  return keys;
}

// Every id the bag NAMES, read through the table above. The bag arrives from a URL, so it is
// attacker-controlled and un-normalized: each reader degrades a malformed value to "no ids" rather
// than throwing, because this runs on raw input in the editor as well as at the Save boundary.
function bagNamedIds(rawOverrides) {
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
function reservedNamespaceIds(scene, rawOverrides, extra) {
  const taken = new Set();
  const add = (id) => { if (typeof id === "string" && id) taken.add(id); };
  if (scene && Array.isArray(scene.elements)) for (const el of scene.elements) add(el && el.id);
  if (scene && Array.isArray(scene.slides)) for (const slide of scene.slides) add(slide && slide.id);
  for (const id of bagNamedIds(rawOverrides)) add(id);
  if (extra) for (const id of extra) add(id);
  return taken;
}

class EditableDiveBakeError extends Error {
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

function isPlainRecord(value) {
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

function normOv(raw, fallbackVersion = 1) {
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
function isDeckScene(scene) {
  return !!scene && scene.v === 2;
}

// The deck half of the override bag, normalized the same way normOv normalizes the v1 half:
// every malformed field degrades to "no opinion" instead of throwing. The v1 six keep their
// exact semantics; nothing here touches them.
function normSlideOv(raw) {
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
function slidesOf(scene, rawOverrides) {
  return effectiveSlides(scene, rawOverrides, EDITABLE_DIVE_ORDER_TOLERANT);
}

// Server/bake entry point: every deviation from the contract is a hard error.
function slidesOfStrict(scene, rawOverrides) {
  return effectiveSlides(scene, rawOverrides, EDITABLE_DIVE_ORDER_STRICT);
}

// Returning the INPUT OBJECT for an unpatched element is load-bearing, not an optimization detail:
// the slides fork's filmstrip memoizes one thumbnail per slide on its leaf ARRAY identity, so a
// normalizing `.map()` here (or in sanitizeParents, which likewise returns its element untouched
// when the parent needs no repair) would hand every slide fresh objects and re-render all ~200
// thumbnails on every keystroke. The unit suite asserts the identity through a real commit.
function applyElPatch(el, patch) {
  if (!patch) return el;
  return { ...el, ...patch, id: el.id, type: el.type };
}

const parentOf = (el) => (el && el.parent != null ? el.parent : null);

function sanitizeParents(elements) {
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

function finalizeScene(page, elements, stale, slides) {
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

function mergeScene(scene, rawOverrides) {
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

function valEq(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === "object" || typeof b === "object") {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return a === b;
}

function prunePatch(baseElement, patch) {
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
// per-column setting names here would put every future one behind a core change and a re-assembly
// of every dive, while the values are already covered by assertSafeJson's depth, length and
// forbidden-key rules and by the save's scene-literal escaping on the way into the JSX module.
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

function validateBakeInput(scene, rawOverrides, { maxOverrideBytes = 65536 } = {}) {
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
function permanentizeAddedIds(elements, addedIds, reservedIds) {
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
function permanentizeSlideIds(slides, elements, addedSlideIds, reservedIds) {
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

function removeEmptyGroups(elements) {
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
function renumberLeafZ(elements, slideIndexById) {
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

function bakeScene(scene, rawOverrides, options) {
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

// A stable fingerprint of the patch-key allowlist. Two copies of the core disagree on which keys
// are patchable when one was generated before a new patchable field existed, and a bag built by the
// newer one then fails late with INVALID_OVERRIDES. Comparing fingerprints names the older copy
// without spending a real save to discover it.
function patchKeyAllowlistFingerprint() {
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

function mapRequiredResources(raw) {
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

// The fingerprint of the core above, emitted so a consumer that has only this SOURCE can tell
// which side of a version skew it is looking at. See scripts/sync-merge-core.mjs.
const EDITABLE_DIVE_CORE_FINGERPRINT = "7916132d";
// __MERGE_CORE_END__

// ── Flight Save (pure) ──────────────────────────────────────────────────────
// Save hands the WHOLE batched bag to the save Flight in one run; nothing is written per edit.
// The Flight re-bakes with the core inlined in the live source, so the dry run below is only an
// early, local answer to "will this bake?" — it is not what gets written.

// How many separate things the bag changes — the number on the Save button.
function pendingEditCount(bag) {
  if (!isPlainRecord(bag)) return 0;
  const n = (v) => (Array.isArray(v) ? v.length : isPlainRecord(v) ? Object.keys(v).length : 0);
  return n(bag.patch) + n(bag.added) + n(bag.deleted) + n(bag.slidePatch) + n(bag.addedSlides)
    + n(bag.deletedSlides) + (bag.slideOrder !== undefined ? 1 : 0) + (isPlainRecord(bag.page) ? 1 : 0);
}

function checkFlightSave(scene, rawOverrides, flightId) {
  if (!DIVE_UUID_RE.test(String(flightId || ""))) return { ok: false, error: "No save Flight is configured for this Dive. Use Copy JSON for a manual bake-back." };
  if (!scene || typeof scene.diveId !== "string" || !DIVE_UUID_RE.test(scene.diveId)) {
    return { ok: false, error: "This Dive source does not include a valid save target ID." };
  }
  if (pendingEditCount(rawOverrides) === 0) return { ok: false, error: "No unsaved edits." };
  try {
    const { summary } = bakeScene(scene, rawOverrides, { maxOverrideBytes: SAVE_OVERRIDE_MAX_BYTES });
    return { ok: true, summary, json: JSON.stringify(rawOverrides) };
  } catch (error) {
    if (error && error.code === "STALE_BASE") return { ok: false, error: "These edits are stale. Clear them, reload the Dive, and edit again." };
    if (error && error.code === "PAYLOAD_TOO_LARGE") return { ok: false, error: "These edits exceed the 64 KB Save limit. Use Copy JSON for a manual bake-back." };
    return { ok: false, error: `These edits cannot be saved: ${String((error && error.message) || "invalid override data").slice(0, 180)}` };
  }
}

// The save Flight's exit codes (flight/save_deck.py).
const SAVE_FLIGHT_EXIT_MESSAGES = {
  2: "The save request was malformed.",
  3: "Someone saved this Dive after you started editing. Copy JSON to keep your edits, then reload.",
  4: "The save Flight rejected these edits.",
  5: "These edits are too large to save.",
  6: "The save Flight is not allowed to write this Dive.",
};

function flightSaveFailure(status, exitCode) {
  if (status === "CANCELLED") return "The save was cancelled. Your edits are still here.";
  return `${SAVE_FLIGHT_EXIT_MESSAGES[exitCode] || `The save Flight failed${exitCode != null ? ` (exit ${exitCode})` : ""}.`} Your edits are still here.`;
}

// ── Deck projection (pure) ──────────────────────────────────────────────────
// A deck is ONE flat scene whose elements carry `slide`. Everything the editor already does —
// canvas, selection, marquee, groups, inspector, layers tree, undo, snapping — keeps working
// unchanged because it is pointed at one slide's slice of that flat list instead of at all of
// it. These four helpers are the whole projection.

// One slide's elements, in the source list's order.
//
// Deck-ness is passed EXPLICITLY (`isDeck`) rather than inferred from `slideId == null`, because
// `null` has two meanings that need opposite behaviour: "this is a v1 scene, there are no slides"
// (pass the whole list through untouched — that is what keeps this fork's v1 behaviour identical)
// and "this IS a deck but its effective slide list is empty" (a deck with no slide shows NOTHING;
// passing the deck through unfiltered would paint every slide at once). The default keeps the
// two-argument v1 call sites and their tests reading exactly as before.
function elementsOfSlide(elements, slideId, isDeck = slideId != null) {
  if (!isDeck) return elements;
  if (slideId == null) return [];
  return elements.filter((el) => el.slide === slideId);
}

// Where the slide cursor lands. `wanted` normally wins; when the deck no longer contains it
// (slide deleted, a stale bag reset the deck, or nothing has been picked yet) the cursor falls
// to the nearest surviving index — the deck closes up under it, like a text caret after a
// delete — and to the first slide when there is no remembered index.
function resolveActiveSlideId(slides, wanted, lastIndex) {
  if (!Array.isArray(slides) || !slides.length) return null;
  if (slides.some((slide) => slide.id === wanted)) return wanted;
  const i = Number.isFinite(lastIndex) ? Math.max(0, Math.min(slides.length - 1, Math.trunc(lastIndex))) : 0;
  return slides[i].id;
}

// Every element the editor mints — leaf, group, duplicate or paste — belongs to the slide the
// author is looking at (spec S3 requires `slide` on groups too). On a v1 scene there is nothing
// to stamp AND the key must stay absent: the version gate rejects `slide` on a v1 element.
//
// Deck-ness is explicit here for the same reason as elementsOfSlide: on a DECK with no live slide
// there is no legal value for `slide`, and an element minted without one is unreachable (it
// renders on no slide) yet still costs bag bytes and makes every later Save fail the
// "added[].slide must name a live slide" boundary check. That is a corruption, so it throws — a
// backstop only: every mint site asks `mintRefusal` first and returns before reaching here.
function stampSlide(el, slideId, isDeck = slideId != null) {
  if (!isDeck) return el;
  if (slideId == null) throw new Error("stampSlide: a deck element needs a live slide");
  return { ...el, slide: slideId };
}

// The one gate every mint site (add / group / paste+duplicate) consults BEFORE building anything.
// Returns the toast to show, or null to proceed. A deck can legitimately have no live slide (a
// bag whose `deletedSlides` covers the deck, or a future slide-delete taking the last one), and
// merge-core delegates "never delete the last slide" to the UI — so the UI has to be inert in
// that state rather than minting elements that belong to no slide.
//
// Called with `scene`/`bag` it also answers the STALE question — the one that made every insert
// (text, shape, line, table, chart) a silent no-op: `mergeScene` discards a stale bag wholesale, so
// the element lands in `added`, the byte meter grows, and nothing appears on the slide; Save then
// refuses the bag too. The slide ops learned to refuse that in an earlier pass (slideStaleRefusal);
// the element mints never did, so this gate now asks both questions for all of them. Called with
// two arguments it answers only the no-slide question — that is a permanent state and disables the
// Add controls, whereas a stale bag is one click from cleared, so it stays an enabled button and a
// toast that names that click, exactly as the slide ops report it.
const MINT_NO_SLIDE = "This deck has no slides — add or restore a slide before adding elements";
function mintRefusal(isDeck, slideId, scene, bag) {
  if (isDeck && slideId == null) return MINT_NO_SLIDE;
  return slideStaleRefusal(scene, bag);
}

// How many leaves the slides BEFORE this one own. Leaf `z` is one global paint order (bake
// renumbers it by (slideIndex, z)), so a per-slide renumber has to start where the previous
// slides' leaves end. Numbering every slide from 10 would render identically — two slides never
// paint at once — but would rewrite `z` for the whole slide on every order command, and the
// override bag pays for each of those patches.
//
// Feed this the BASE scene's leaves, never the merged/live ones. The offset exists to reproduce
// the z values the LAST BAKE wrote; a live count drifts the moment the author adds or deletes on
// an earlier slide, and then every order command on a later slide emits a z patch per leaf and
// burns the 64 KB budget for nothing. Because the offset is frozen at the baked count, pending
// `z` values CAN collide across slides between bakes (slide 2's added leaf may share a global z
// with a slide 3 leaf). That is deliberate and harmless: nothing paints two slides at once, and
// `renumberLeafZ` re-contiguises the whole deck by (slideIndex, z) at bake. Do not "fix" it by
// switching back to the live count.
function leavesBeforeSlide(leaves, slides, slideId) {
  if (!Array.isArray(slides) || slideId == null) return 0;
  const rank = new Map(slides.map((slide, i) => [slide.id, i]));
  const mine = rank.get(slideId);
  if (mine === undefined) return 0;
  let n = 0;
  for (const el of leaves) {
    // Groups never carry z, so they never take a slot in the paint order.
    if (el.type === "group") continue;
    const r = rank.get(el.slide);
    if (r !== undefined && r < mine) n += 1;
  }
  return n;
}

// ── Keyboard focus guard (shared) ───────────────────────────────────────────
// The ONE "is the user typing?" test, consulted by BOTH key handlers — the editor's canvas
// shortcuts and present mode's navigation. It was inline in the editor's handler; present mode
// needs exactly the same rule, and two copies of it would drift the moment one grew a case.
function isTypingTarget(node) {
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!node.isContentEditable;
}

// ── Present mode (pure) ─────────────────────────────────────────────────────
// Present mode is the published view of a deck: one slide, scaled to fit whatever viewport the
// host iframe hands us, letterboxed. These helpers are all of its decision-making — the
// visible-slide walk, the fit arithmetic, the chart mount window, the query prefetch order.
// PresentShell below is wiring around them.

const PRESENT_NONE = -1;          // "no such slide": nav at an end, or a deck with no slides
const PRESENT_FADE_MS = 220;      // the ONE transition (plan feature 14 — exactly one crossfade)
const PRESENT_FADE_GRACE_MS = 80; // how long past the fade a layer waits for its transitionend
const PRESENT_MOUNT_RADIUS = 1;   // charts RENDER for the active slide ±1 (plan §3)
const PRESENT_PREFETCH_MAX = 24;  // unique SQL statements in the pool's want set, nearest-first
const PRESENT_INFLIGHT_MAX = 4;   // ...of which this many may be in flight at once (presentAdmit)

// The slides present mode can reach, as indices into `slides`.
//
// EVERY SLIDE HIDDEN is the decision this function encodes: such a deck is treated as fully
// visible. `hidden` means "skip this one", not "show nothing" — and a deck with every slide
// hidden is a mid-edit state, not an instruction to present nothing. Honouring it literally
// strands the viewer on a bare backdrop reading 0 / 0 where no key changes anything and the only
// way out is to know that Esc exists. Falling back to the whole deck keeps the one thing present
// mode owes its user: something is on screen, and it can be navigated.
function presentVisible(slides) {
  const list = Array.isArray(slides) ? slides : [];
  const vis = [];
  for (let i = 0; i < list.length; i += 1) if (!(list[i] && list[i].hidden)) vis.push(i);
  if (vis.length) return vis;
  return list.map((slide, i) => i);
}

// The next reachable slide from `from` in direction `dir` (>0 forward), or PRESENT_NONE at the
// deck's end. Nav stops at the ends — it never wraps (plan cuts autoplay/loop).
//
// Walks the RAW index space rather than a position within the visible list, because `from` itself
// can be hidden: "Present from current" opens on whatever slide the author was editing, flag or
// not. That also makes a run of consecutive hidden slides one loop instead of a special case.
function nextVisibleSlide(slides, from, dir) {
  const list = Array.isArray(slides) ? slides : [];
  const vis = new Set(presentVisible(list));
  const step = dir < 0 ? -1 : 1;
  const start = Number.isFinite(from) ? Math.trunc(from) : PRESENT_NONE;
  // An out-of-range cursor is clamped to just OUTSIDE the deck on its own side, so a walk inward
  // from it still finds the nearest end instead of reporting "no slide" — and a walk outward still
  // reports the end it is already past.
  const seed = Math.max(PRESENT_NONE, Math.min(list.length, start));
  for (let i = seed + step; i >= 0 && i < list.length; i += step) if (vis.has(i)) return i;
  return PRESENT_NONE;
}

// Home / End. dir > 0 -> the first reachable slide, dir < 0 -> the last one.
function presentEdgeSlide(slides, dir) {
  const vis = presentVisible(slides);
  if (!vis.length) return PRESENT_NONE;
  return dir < 0 ? vis[vis.length - 1] : vis[0];
}

// Where present mode OPENS. A valid index is taken AS IS, hidden or not: "present from current"
// means THIS slide, and an author asking for it outranks a flag whose only job is to skip it in a
// walk. Anything else — a cold published URL with no cursor, an index the deck no longer has —
// opens on the first slide the deck would actually present.
function presentEntrySlide(slides, wanted) {
  const list = Array.isArray(slides) ? slides : [];
  if (!list.length) return PRESENT_NONE;
  const i = Number.isFinite(wanted) ? Math.trunc(wanted) : PRESENT_NONE;
  if (i >= 0 && i < list.length) return i;
  return presentEdgeSlide(list, 1);
}

// The counter. Both numbers are over the REACHABLE slides, so "3 / 4" on a five-slide deck with
// one hidden slide counts what the audience will actually see rather than the author's raw slide
// numbers. `n` is 0 when the current slide is not reachable at all — the one case being an entry
// straight onto a hidden slide, which the counter renders as "– / 4" instead of lying.
function presentCounter(slides, index) {
  const vis = presentVisible(slides);
  // indexOf returns -1 for an unreachable slide, so the 1-based conversion lands on 0 by itself —
  // no branch, and 0 is the value the chrome renders as "–".
  const at = vis.indexOf(Number.isFinite(index) ? Math.trunc(index) : PRESENT_NONE);
  return { n: at + 1, total: vis.length };
}

// Fit-and-letterbox: the slide's authored aspect ratio EXACTLY (w / h === pageW / pageH), centred,
// with the surround left to the backdrop and never to the slide's own background — a 16:9 slide in
// a tall viewport would otherwise read as a full-bleed colour field with the content floating in
// the middle of it.
//
// A zero or non-finite viewport (the first paint, before the shell has been measured) returns
// scale 0, which PresentShell paints as backdrop-only. That is deliberately not "assume 1": a
// scale of 1 for one frame flashes an unscaled 1280px slide clipped to the corner.
function letterbox(viewW, viewH, pageW, pageH) {
  const vw = Number(viewW), vh = Number(viewH), pw = Number(pageW), ph = Number(pageH);
  if (!(vw > 0) || !(vh > 0) || !(pw > 0) || !(ph > 0)) return { scale: 0, w: 0, h: 0, left: 0, top: 0 };
  const scale = Math.min(vw / pw, vh / ph);
  const w = pw * scale, h = ph * scale;
  // The offsets round to whole pixels (a half-pixel origin blurs every glyph on the slide); w/h
  // stay exact, so no rounding can ever nudge the aspect ratio the letterbox exists to preserve.
  return { scale, w, h, left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2) };
}

// Which slides RENDER their charts, as slide ids. Queries are deck-wide and eager (see
// presentPrefetchSql); this window governs only the expensive half — mounting a Recharts tree,
// which measures and lays out an SVG per chart.
//
// Active ±radius over the REACHABLE order, so the slide one key press away is already drawn and a
// run of hidden slides between them costs nothing. The active slide is always in the window, even
// when it is itself hidden.
function presentMountWindow(slides, index, radius) {
  const list = Array.isArray(slides) ? slides : [];
  const at = Number.isFinite(index) ? Math.trunc(index) : PRESENT_NONE;
  if (at < 0 || at >= list.length) return [];
  const r = Number.isFinite(radius) ? Math.trunc(radius) : 0; // a negative radius runs zero passes
  const out = [at];
  for (const dir of [1, -1]) {
    let cur = at;
    for (let k = 0; k < r; k += 1) {
      cur = nextVisibleSlide(list, cur, dir);
      if (cur === PRESENT_NONE) break;
      out.push(cur);
    }
  }
  return out.sort((a, b) => a - b).map((i) => list[i].id);
}

// The pool's WANT SET: which SQL present mode intends to run, in priority order, nearest-first
// from `entryIndex` and capped. The shell recomputes this from the LIVE cursor on every
// navigation and admits it through presentAdmit's in-flight budget, so this function decides
// ORDER and MEMBERSHIP only — never how many statements are running.
//
// Nearest-first because order is what a presenter feels: a 60-slide deck of live-data slides
// would otherwise open 60 queries and the FIRST slide's would finish last. Capped because the
// nearest 24 statements are more than any presenter reaches before the budget has cycled several
// times, and because the cursor moving re-derives the window around wherever they went — so a
// chart is inside the cap whenever its own slide is anywhere near the cursor.
// Deduped by SQL text, so a KPI query repeated on five slides is one query.
//
// Unreachable (hidden) slides are skipped: present mode cannot navigate to them, so their queries
// would be pure cost. The entry slide is always included, hidden or not, to match presentEntrySlide.
function presentPrefetchSql(slides, elements, entryIndex, max) {
  const list = Array.isArray(slides) ? slides : [];
  const els = Array.isArray(elements) ? elements : [];
  const at = presentEntrySlide(list, entryIndex);
  if (at === PRESENT_NONE) return [];
  const reachable = new Set(presentVisible(list));
  reachable.add(at);
  const bySlide = new Map();
  for (const el of els) {
    if (!isLiveSQL(el)) continue;
    if (typeof el.sql !== "string" || !el.sql.trim()) continue;
    if (!bySlide.has(el.slide)) bySlide.set(el.slide, []);
    bySlide.get(el.slide).push(el.sql);
  }
  const cap = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  const seen = new Set();
  const out = [];
  const take = (i) => {
    if (out.length >= cap || !reachable.has(i)) return;
    for (const sql of bySlide.get(list[i].id) || []) {
      if (seen.has(sql)) continue;
      seen.add(sql);
      if (out.length >= cap) return;
      out.push(sql);
    }
  };
  take(at);
  for (let d = 1; d < list.length && out.length < cap; d += 1) { take(at + d); take(at - d); }
  return out;
}

// WHICH of the want set may be running right now. This is the whole fan-out policy.
//
// The problem it solves: firing the want set at once is a 24-deep queue the moment the connector
// serialises one connection (measured: the local WASM client does), so a presenter who presses End
// on load waits behind 23 queries for the chart actually in front of them. A budget fixes that
// under EITHER client — if queries run in parallel the budget just cycles faster.
//
// `started` is the SQL already mounted, in admission order, and it is APPEND-ONLY: unmounting a
// query aborts the request and throws the result away, so nothing is ever evicted and nothing
// already run is ever re-queued. `pool` decides what still occupies a slot: a settled entry (rows
// or an error) frees one; a missing or still-loading entry holds one. Priority comes from `order`,
// which the caller re-derives from the LIVE cursor — that, not this function, is what puts the
// slide the presenter is looking at at the head of the queue.
//
// Returns `started` ITSELF when nothing new is admitted, so the caller can store the result
// straight back into state without a render loop.
function presentAdmit(order, started, pool, budget) {
  const list = Array.isArray(started) ? started : [];
  const want = Array.isArray(order) ? order : [];
  const bag = isPlainRecord(pool) ? pool : {};
  const cap = Number.isFinite(budget) ? Math.max(0, Math.trunc(budget)) : 0;
  // OWN-property, and this is not hygiene: `bag["constructor"]` resolves up the prototype chain to a
  // function, which is truthy and has no `isLoading`, so a statement of `constructor`, `toString` or
  // `valueOf` read as ALREADY SETTLED and was never admitted — the grid drew nothing in present mode
  // with no error and no skeleton. `SELECT 1 AS constructor` is a real statement; so is a saved
  // `toString`. Pre-existing for chart SQL; the SQL table inherited it.
  const settled = (sql) => {
    const e = Object.hasOwn(bag, sql) ? bag[sql] : undefined;
    return !!e && !e.isLoading;
  };
  const have = new Set();
  let live = 0;
  for (const sql of list) {
    have.add(sql);
    if (!settled(sql)) live += 1;
  }
  const out = list.slice();
  for (const sql of want) {
    if (live >= cap) break;
    // Sticky both ways: already mounted, or already resolved by some earlier admission.
    if (have.has(sql) || settled(sql)) continue;
    have.add(sql);
    out.push(sql);
    live += 1;
  }
  return out.length === list.length ? list : out;
}

// ── Build steps (pure) ──────────────────────────────────────────────────────
// A build step is one CLICK of a slide: `build: n` on a leaf says "reveal me on step n". A leaf with
// no build is on screen from the moment its slide is. Everything below is the whole feature's
// decision-making — PresentShell holds two lines of wiring around it, and the editor one control.
//
// THE STEPS OF A SLIDE ARE ITS DISTINCT VALUES, ASCENDING AND COMPACTED. That one sentence settles
// three of the four edge cases the brief names:
//   • SPARSE (1, 5, 9) is THREE steps, not nine. An empty step would be a click that changes
//     nothing, which a presenter reads as a broken deck or a missed key; and 1/5/9 is precisely how
//     an author leaves room to insert later, so honouring the gaps would punish the convention.
//   • DUPLICATES reveal TOGETHER. That is the whole mechanism for "these four things arrive at
//     once", and it is why the editor's control writes to every LEAF in the selection rather than
//     inventing a group-level key.
//   • AN EMPTY STEP therefore cannot exist: there is no step 2 to stand on between 1 and 5, and
//     assigning 7 to nothing leaves no trace in the walk.
// The fourth — a HIDDEN slide carrying builds — needs no code here at all: nextVisibleSlide never
// seats the cursor on one, so its steps are never walked and its elements are never drawn. (Present
// mode can still OPEN on one via "present from current", and there its builds work normally, which
// is the same call presentEntrySlide already made for that case.)
const BUILD_NONE = 0;          // "this leaf is not in a build step" — visible from the start
const BUILD_NAV = -1;          // buildNext: no step left this way, so the input is the slide walk's
const BUILD_NO_STEPS = [];     // one shared empty list, so "no builds" has a stable identity
const PRESENT_NO_FADE = {};    // ...and one shared empty record for "nothing is fading"

// An element's step, or BUILD_NONE. Any integer >= 1 counts: the CORE caps what may be WRITTEN
// (EDITABLE_DIVE_MAX_BUILD, checked on scene, added and patched elements alike), and this decides
// what to DRAW for whatever is actually in the file. A hand-edited `build: 1500` revealing last is
// strictly better than one that silently reveals first, so the renderer does not re-apply the cap.
function normBuild(value) {
  return Number.isInteger(value) && value >= 1 ? value : BUILD_NONE;
}

// The slide's steps: ascending, distinct, compacted (see above).
function buildStepsOf(els) {
  const seen = new Set();
  for (const el of Array.isArray(els) ? els : []) {
    const step = normBuild(el && el.build);
    if (step !== BUILD_NONE) seen.add(step);
  }
  if (!seen.size) return BUILD_NO_STEPS;
  return [...seen].sort((a, b) => a - b);
}

// Every slide's steps at once, keyed the way groupLeavesBySlide keys its leaves. Derived from the
// LEAF map and not from the element list, so a group can never contribute a step — the core forbids
// `build` on a group, and this is the reader that would have quietly disagreed.
function buildStepsBySlide(leavesBySlide) {
  const out = new Map();
  if (!leavesBySlide || typeof leavesBySlide.forEach !== "function") return out;
  leavesBySlide.forEach((els, slideId) => { out.set(slideId, buildStepsOf(els)); });
  return out;
}

function buildStepsFor(stepsBySlide, slideId) {
  if (!stepsBySlide || slideId == null || typeof stepsBySlide.get !== "function") return BUILD_NO_STEPS;
  const steps = stepsBySlide.get(slideId);
  return Array.isArray(steps) ? steps : BUILD_NO_STEPS;
}

// The largest step VALUE revealed so far, so the renderer needs one comparison per element instead
// of an index lookup per element. BUILD_NONE means nothing is revealed yet; a cursor past the end
// means the whole slide. Compacted steps are what make the two forms interchangeable.
function buildCutoff(steps, revealed) {
  const list = Array.isArray(steps) ? steps : BUILD_NO_STEPS;
  const at = Number.isFinite(revealed) ? Math.trunc(revealed) : 0;
  if (at <= 0 || !list.length) return BUILD_NONE;
  return list[Math.min(at, list.length) - 1];
}

// Is this leaf on screen at this cutoff? An unbuilt leaf always is — and that needs no branch of its
// own: BUILD_NONE *is* 0 and every cutoff is >= 0, so ONE comparison covers both "always on screen"
// and "already revealed". The explicit `step === BUILD_NONE ||` a reader expects here was written
// first and then deleted: a mutant proved it unreachable, and an unreachable guard is an assertion
// that never runs.
function buildShown(el, cutoff) {
  return normBuild(el && el.build) <= (Number.isFinite(cutoff) ? cutoff : BUILD_NONE);
}

// The build cursor after ONE input in `dir`, or BUILD_NAV when this slide has no step left that way
// — which is exactly when the input belongs to the slide walk instead. advance, retreat AND the
// chrome's atStart/atEnd all read THIS function, which is the seam's second open question answered:
// › cannot grey out on the last slide while a step is still hidden, because both consult one
// decision rather than two that have to be kept in step.
function buildNext(steps, revealed, dir) {
  const n = (Array.isArray(steps) ? steps : BUILD_NO_STEPS).length;
  const at = Number.isFinite(revealed) ? Math.max(0, Math.min(n, Math.trunc(revealed))) : 0;
  if (dir < 0) return at > 0 ? at - 1 : BUILD_NAV;
  return at < n ? at + 1 : BUILD_NAV;
}

// Where the cursor SITS on arrival, from the direction of travel. Forward (and Home) land on a
// slide with nothing built, so the next input builds its first step; backward (and End) land on it
// fully built, so the next ← takes its last step away.
//
// Landing fully built going backward is the decision, and it is what makes a backward trip through
// a deck show the same states a forward trip did, in reverse: seat it at zero instead and every
// build on the way back is skipped, which is the one thing a presenter walking back to re-explain
// a slide cannot use.
function buildSeat(steps, dir) {
  const n = (Array.isArray(steps) ? steps : BUILD_NO_STEPS).length;
  return dir < 0 ? n : 0;
}

// ONE reveal or un-reveal, as a pure nav transition — or null when this slide has no step left that
// way and the caller should navigate. `snap: false` is what lets the reveal FADE (buildRevealMs).
function presentReveal(slides, stepsBySlide, nav, dir) {
  const list = Array.isArray(slides) ? slides : [];
  const at = nav && Number.isFinite(nav.cur) ? Math.trunc(nav.cur) : PRESENT_NONE;
  const cur = at >= 0 && at < list.length ? list[at] : null;
  const to = buildNext(buildStepsFor(stepsBySlide, cur && cur.id), nav ? nav.revealed : 0, dir);
  if (to === BUILD_NAV) return null;
  return { ...nav, revealed: to, snap: false };
}

// Seat the cursor on slide `to`, coming from `dir`. THREE things a navigation owes the build cursor,
// and the first is the seam's other open question:
//   1 the arriving slide's cursor is SEATED from the direction and never inherited, so `jump`
//     (Home / End) goes through here too — End lands on the last slide fully built, Home on the
//     first with nothing built, neither carrying over what the slide it left was showing.
//   2 the DEPARTING slide keeps the CUTOFF IT LEFT WITH, recorded against its id in `fading`. A
//     single shared cursor would repaint the outgoing layer to the incoming slide's state and its
//     content would change while it fades out — the glitch is worst on the ordinary forward step,
//     where a fully-built slide would drop everything the presenter just revealed and then fade.
//   3 `snap: true`, so those cutoff changes switch hard instead of running a second animation
//     underneath the crossfade (buildRevealMs).
// A target that IS the current slide still re-seats: Home on slide 1 with two steps built has to
// reset them, and the slide walk cannot express that as a move.
function presentSeat(slides, stepsBySlide, nav, to, dir) {
  const list = Array.isArray(slides) ? slides : [];
  const at = Number.isFinite(to) ? Math.trunc(to) : PRESENT_NONE;
  if (at < 0 || at >= list.length) return nav;
  const target = list[at];
  const revealed = buildSeat(buildStepsFor(stepsBySlide, target && target.id), dir);
  if (at === nav.cur) return revealed === nav.revealed ? nav : { ...nav, revealed, snap: true };
  const from = nav.cur >= 0 && nav.cur < list.length ? list[nav.cur] : null;
  const fromId = from ? from.id : null;
  const toId = target ? target.id : null;
  const prev = isPlainRecord(nav.fading) ? nav.fading : PRESENT_NO_FADE;
  const fading = {};
  // The INCOMING slide can itself be mid-fade (→ then ← inside the 220 ms): it has to leave the set
  // or it would keep animating away underneath the presenter. Own-key iteration throughout — a
  // slide id cannot be a prototype member (validateSlide refuses those), and this is the reader
  // that would have had to be trusted about it.
  for (const id of Object.keys(prev)) if (id !== toId && id !== fromId) fading[id] = prev[id];
  if (fromId && fromId !== toId) fading[fromId] = buildCutoff(buildStepsFor(stepsBySlide, fromId), nav.revealed);
  return {
    cur: at, revealed, snap: true,
    fading: Object.keys(fading).length ? fading : PRESENT_NO_FADE,
  };
}

// THE WHOLE OF ONE ADVANCING / RETREATING INPUT: offer it to this slide's builds first, and fall
// through to the slide walk only when there is no step left that way. This is the seam's funnel, as
// one pure function rather than a fallthrough inside a setState — so "the funnel forgot to try the
// reveal" is a branch the unit suite can kill, and the test driver calls the real decision instead of
// a second copy of it.
function presentStep(slides, stepsBySlide, nav, dir) {
  return presentReveal(slides, stepsBySlide, nav, dir)
    || presentSeat(slides, stepsBySlide, nav, nextVisibleSlide(slides, nav.cur, dir), dir);
}

// Home / End. No reveal at all: the far slide is re-seated from the direction, which is the whole
// answer to "Home/End needs a build reset".
function presentJump(slides, stepsBySlide, nav, dir) {
  return presentSeat(slides, stepsBySlide, nav, presentEdgeSlide(slides, dir), dir);
}

// Is the chrome's arrow DEAD in this direction? The derivation is "pressing it would change
// nothing", so it reads the SAME buildNext the funnel does rather than a parallel rule: the slide
// walk alone would grey out › on the last slide while its build steps were still hidden, which is
// exactly what the seam warned about.
function presentArrowDead(slides, stepsBySlide, nav, dir) {
  const list = Array.isArray(slides) ? slides : [];
  const cur = nav && nav.cur >= 0 && nav.cur < list.length ? list[nav.cur] : null;
  return nextVisibleSlide(list, nav ? nav.cur : PRESENT_NONE, dir) === PRESENT_NONE
    && buildNext(buildStepsFor(stepsBySlide, cur && cur.id), nav ? nav.revealed : 0, dir) === BUILD_NAV;
}

// WHICH CUTOFF A LAYER DRAWS AT. The live slide's comes from the cursor; a DEPARTING one keeps the
// cutoff it left with (presentSeat recorded it); an invisible pre-mount gets nothing revealed and
// never animates into place, because the commit that makes it current is a navigation and switches
// it hard (buildRevealMs).
function presentLayerCut(nav, slideId, curId, curSteps) {
  if (slideId === curId) return buildCutoff(curSteps, nav ? nav.revealed : 0);
  const fading = nav && isPlainRecord(nav.fading) ? nav.fading : PRESENT_NO_FADE;
  return Object.hasOwn(fading, slideId) ? fading[slideId] : BUILD_NONE;
}

// The reveal's transition duration — and the whole of "exactly one animation per reveal". A
// NAVIGATION commit changes several layers' cutoffs at once (the arriving slide seats its cursor,
// the departing one keeps its own), so animating them would put a second fade under the crossfade
// the layer is already running. A REVEAL commit changes one slide's cutoff by one step, and that
// change IS the fade — the same duration and the same easing as the slide crossfade, because the
// plan's rule is one transition vocabulary, not two.
function buildRevealMs(snap) {
  return snap ? 0 : PRESENT_FADE_MS;
}

// ── Build steps: what the EDITOR shows and writes (pure) ────────────────────
// A build VALUE is what a leaf stores; its ORDINAL is which click reveals it. They differ the
// moment a stored sequence is sparse — 5 is step 2 of 3 — and NOTHING the editor shows is ever the
// stored value: the canvas chip, the layers-row mark and the Build order section all carry the
// ORDINAL, because "which click reveals this" is the only number an author can act on. The numeric
// field that used to show the raw value is gone (see the Build order section for what replaced it),
// and with it the last reason for two numbers to be on screen at once.
function buildOrdinal(steps, value) {
  const step = normBuild(value);
  if (step === BUILD_NONE) return 0;
  return (Array.isArray(steps) ? steps : BUILD_NO_STEPS).indexOf(step) + 1;
}

// The step A SET OF LEAVES is in: a number when they all agree (BUILD_NONE when none of them is
// built), and null for a MIXED set. What a GROUP row in the layers tree asks: the core forbids
// `build` on a group, so a group answers for its descendant leaves, and a group whose leaves
// disagree is a real state — who-deck's `s4-chartgrp` holds steps 1, 2 and 3 — which the row shows
// as "mixed" rather than picking one of the answers and flattening the other on the next write.
function buildSelectionStep(els) {
  const list = Array.isArray(els) ? els : [];
  if (!list.length) return null;
  let first = null;
  for (const el of list) {
    const step = normBuild(el && el.build);
    if (first === null) first = step;
    else if (first !== step) return null;
  }
  return first;
}

// ── The build ORDER, as the editor manipulates it (pure) ────────────────────
// ONE representation, ONE write, and every operation in the UI is a list edit over it.
//
// The representation is the STEP SEQUENCE: an array of arrays of leaf ids — outer index = click,
// inner list = "these arrive together". It is exactly what the Build order section draws, it makes
// reorder a splice and add/remove a filter, and it cannot express either of the two states the
// stored form can that the UI must never produce (an empty step, or a `build` on a group).
//
// EVERY WRITE NORMALIZES TO 1..N. Stored values are re-derived from the sequence's positions, so a
// slide stored as 1/5/9 becomes 1/2/3 the first time anything here touches it. That is a deliberate
// break with the inspector field this replaced, whose "one past the highest" rule existed to leave
// room to type a value BETWEEN two others: nothing types a value any more — a step is dragged where
// it belongs and everything after it renumbers — so a gap has stopped meaning anything, and keeping
// gaps would only make value and ordinal disagree again in a UI that shows nothing but ordinals.
// Normalizing is also what makes each op cheap to reason about: after any write, value === ordinal.
const BUILD_NO_ROWS = [];                        // one shared empty list, like BUILD_NO_STEPS
const BUILD_ROW_NONE = { kind: "none", ordinal: 0 };    // not in the build order
const BUILD_ROW_MIXED = { kind: "mixed", ordinal: 0 };  // a group whose leaves disagree
const BUILD_ROW_EMPTY = { kind: "empty", ordinal: 0 };  // a group with no leaves — nothing to build

// The slide's steps as ROWS — one per click, members in the order they were handed in (the caller
// sorts the leaves in canvas reading order, the same order the layers tree uses). Ascending and
// compacted for the same reason buildStepsOf is: a step nothing is in is not a click.
function buildStepRows(orderedLeaves) {
  const byStep = new Map();
  for (const el of Array.isArray(orderedLeaves) ? orderedLeaves : []) {
    const step = normBuild(el && el.build);
    if (step === BUILD_NONE) continue;
    if (!byStep.has(step)) byStep.set(step, []);
    byStep.get(step).push(el);
  }
  if (!byStep.size) return BUILD_NO_ROWS;
  return [...byStep.keys()].sort((a, b) => a - b).map((step) => ({ step, members: byStep.get(step) }));
}

// The current sequence, from the same rows the section draws.
function buildOrderOf(orderedLeaves) {
  return buildStepRows(orderedLeaves).map((row) => row.members.map((el) => el.id));
}

// ADD: the ids leave whatever step they were in and land TOGETHER in a new LAST step. Pulling them
// out first is what makes ONE button work for a group whose leaves are already scattered over three
// steps ("make these arrive together"), and it is why add is not simply a push.
function buildOrderAdd(order, ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const list = Array.isArray(order) ? order : [];
  if (!set.size) return list;
  return [...list.map((group) => group.filter((id) => !set.has(id))), [...set]];
}

// REMOVE: the ids leave the sequence and become visible-from-the-start. Nothing else about the
// elements changes — this is not a delete, and a step left with no members simply stops being a
// step (buildWritePlan drops it, which is the same rule buildStepsOf applies to the stored form).
function buildOrderRemove(order, ids) {
  const set = new Set(Array.isArray(ids) ? ids : []);
  const list = Array.isArray(order) ? order : [];
  if (!set.size) return list;
  return list.map((group) => group.filter((id) => !set.has(id)));
}

// REORDER: move one step to another index. A drag released past either end of the list means
// "first" / "last" rather than nothing happening, and the two ends need DIFFERENT amounts of help
// from splice:
//   • ABOVE the end, splice already does the right thing — an index past the end appends — so there
//     is no ceiling here and a mutant that adds one is provably equivalent.
//   • BELOW zero it does the OPPOSITE of the right thing: `splice(-1, …)` means `len - 1`, so a drag
//     released above the first row would move the step to the LAST position. The floor is real.
//   • `from` is clamped both ways because `splice(99, 1)` removes NOTHING, and the insert would then
//     push `undefined` into the sequence.
function buildOrderMove(order, from, to) {
  const list = (Array.isArray(order) ? order : []).slice();
  if (list.length < 2) return list;
  const f = Math.max(0, Math.min(list.length - 1, Math.trunc(from)));
  const t = Math.max(0, Math.trunc(to));
  if (f === t) return list;
  const [moved] = list.splice(f, 1);
  list.splice(t, 0, moved);
  return list;
}

// THE ONE WRITE. Turns a step sequence into the patch entries that make the slide's leaves say it:
// every leaf the sequence names gets its 1-based position, every OTHER leaf on the slide is cleared
// to `null`, and a leaf already carrying the right value is left out entirely — so an op that moves
// one step of a forty-leaf slide commits the two or three patches it actually changed. The caller
// hands the whole list to ONE patchMany, which is what makes a reorder ONE undo step.
//
// `build` AND NOTHING ELSE. Reordering the build order must never touch `z` or `parent` — a step
// sequence is neither a paint order nor a hierarchy — and this is the one function that could have
// quietly disagreed. (The mirror rule holds on the other side: the tree's drag writes `parent`/`z`
// and never `build`.)
function buildWritePlan(slideLeaves, order) {
  const leaves = Array.isArray(slideLeaves) ? slideLeaves : [];
  // The ids this plan is ALLOWED to spend a click on. Without it the 1..N invariant is over the
  // ARRAY's length rather than over what the plan can write: `[["deleted-id"], ["a"]]` counted the
  // first group as step 1 and stored `a` as 2, on a slide whose only step is `a`. Reachable the
  // moment a sequence outlives the elements it names — a slide switch mid-drag, an undone delete —
  // and the docstring above promises otherwise.
  const onSlide = new Set();
  for (const el of leaves) if (el && el.id != null) onSlide.add(el.id);
  const want = new Map();
  let n = 0;
  for (const group of Array.isArray(order) ? order : []) {
    // A leaf named twice keeps its FIRST step: the sequence is a partition, and letting a later
    // step re-claim it would make the same id appear on two clicks.
    const ids = (Array.isArray(group) ? group : []).filter((id) => onSlide.has(id) && !want.has(id));
    if (!ids.length) continue;                 // an emptied step is not a step
    // Clamped, never dropped: past the core's ceiling the tail shares the last legal step, so an
    // absurd slide still reveals those leaves LAST rather than silently un-building them. The
    // ceiling is READ from the core so the section and the validator cannot drift.
    n = Math.min(n + 1, EDITABLE_DIVE_MAX_BUILD);
    for (const id of ids) want.set(id, n);
  }
  const out = [];
  for (const el of leaves) {
    if (!el || el.id == null) continue;
    const next = want.has(el.id) ? want.get(el.id) : BUILD_NONE;
    if (normBuild(el.build) === next) continue;
    out.push({ id: el.id, partial: { build: next === BUILD_NONE ? null : next } });
  }
  return out;
}

// THE ORDINAL AN ADD WOULD LAND ON: the sequence's length once the ids are pulled out of it, plus
// the one they join. CLAMPED to the core's ceiling because that is where buildWritePlan puts them —
// past 999 an add JOINS the last legal step instead of creating a new one, and a button advertising
// "step 1000" would be describing something the write cannot do.
function buildAddOrdinal(order, ids) {
  const next = buildOrderAdd(order, ids).filter((group) => group.length).length;
  return Math.min(next, EDITABLE_DIVE_MAX_BUILD);
}

// THE LEAVES ONE MARK WRITES TO. Normally the row's own — itself for a leaf, every descendant leaf
// for a group. But when the clicked row is part of a MULTI-SELECTION, it is the whole selection's
// leaves, and that is not a convenience: it is the one thing the deleted inspector field could do
// that a strictly per-row button cannot, which is put an ARBITRARY SUBSET of a group's leaves on one
// click. who-deck slide 4 contains exactly that shape — step 2 is `s4-note` + `s4-arrow`, two of the
// four leaves under `s4-chartgrp` — so without this the example deck held a state the editor could
// no longer author: remove that step and every route back produced four separate clicks.
//
// Reading order is the SELECTION's order here only in so far as the caller hands it in; duplicates
// are dropped, which is what makes "a group and one of its own leaves" a legal selection to click.
function buildMarkTargets(rowId, selection, leavesOf) {
  const sel = Array.isArray(selection) ? selection : [];
  const ids = sel.length > 1 && sel.includes(rowId) ? sel : [rowId];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    for (const leaf of (leavesOf(id) || [])) {
      if (!leaf || leaf.id == null || seen.has(leaf.id)) continue;
      seen.add(leaf.id);
      out.push(leaf);
    }
  }
  return out;
}

// THE MARK'S WORDS, as a value rather than three ternaries inside JSX. Two strings — the tooltip
// and the accessible name — and three things that can go wrong in them, none of which a source regex
// could have been trusted about:
//   • a stale hint that REPLACES the readout instead of SUFFIXING it takes the ordinal out of the
//     accessible name while leaving it on screen, so the one user who cannot see it loses it;
//   • a click that writes the whole SELECTION while describing itself as writing one element is a
//     lie about a write that touches four;
//   • the number in both strings has to be the ORDINAL, like everything else in the editor.
function buildMarkText(state, selCount, nextOrdinal, disabledHint) {
  const inOrder = state.kind === "step";
  const mixed = state.kind === "mixed";
  const many = Number(selCount) || 0;
  const subject = many ? `the ${many} selected elements` : "it";
  const what = inOrder ? `Build step ${state.ordinal}`
    : mixed ? (many ? "Mixed build steps in the selection" : "Mixed build steps in this group")
    : "Not in the build order";
  const action = inOrder ? `click to remove ${subject} from the build order`
    : mixed ? `click to make ${many ? "them" : "all of it"} arrive together, as step ${nextOrdinal}`
    : `click to add ${subject} as step ${nextOrdinal}`;
  const verb = inOrder ? `Remove ${many ? subject : "this"} from the build order (step ${state.ordinal})`
    : mixed ? `Make ${many ? subject : "this group"} arrive together, as build step ${nextOrdinal}`
    : `Add ${many ? subject : "this"} to the build order as step ${nextOrdinal}`;
  return disabledHint
    ? { title: `${what} — ${disabledHint}`, label: `${verb} — ${disabledHint}` }
    : { title: `${what} — ${action}`, label: verb };
}

// ── The two keyboard maps (pure) ────────────────────────────────────────────
// Both handlers below used to be `if (e.key === …)` ladders inside a JSX closure, and that is
// precisely the shape this repo's mutation suite has been unable to see three times now (T8's ghost,
// T11's header band): a source regex can assert the CALL SITE and never the BRANCH. A dropped
// `stopPropagation` here is not cosmetic — the window handler deletes the SELECTION on Delete and
// flips the editor into the Hand tool on Space — so "which keys does this control claim" is made a
// value a test can compare.
//
// "pass" is the ONLY answer that lets a key reach the window, and it is what keeps ⌘Z working with a
// mark focused. Everything else is claimed: handled, or SWALLOWED on purpose.
const BUILD_KEY_PASS = "pass";
function buildMarkKey(key) {
  if (key === "Enter" || key === " ") return "activate";
  // Swallowed, not handled. The mark sits ON the selected row, so the global handler's Delete would
  // destroy the very element the author was trying to un-build — the worst possible reading of the
  // key, and silent.
  if (key === "Delete" || key === "Backspace") return "swallow";
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "prev";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return BUILD_KEY_PASS;
}

// The Build order section's rows. Same contract, one extra gesture: Alt+↑↓ REORDERS rather than
// moving the caret, which is the keyboard equivalent of the grip drag.
function buildStepKey(key, altKey) {
  if (key === "Enter" || key === " ") return "activate";
  if (key === "Delete" || key === "Backspace") return "remove";
  if (key === "ArrowDown") return altKey ? "moveDown" : "next";
  if (key === "ArrowUp") return altKey ? "moveUp" : "prev";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return BUILD_KEY_PASS;
}

// WHAT ONE STEP ROW IS CALLED. Element names, except when the step is EXACTLY one group's leaves —
// then the group's name, because who-deck slide 2 otherwise reads "Value, Label" four times down
// the panel, which says nothing, where "KPI: cities, in 124 countries" says what arrives on that
// click. `leafCountOf` is what makes the substitution honest: a group only HALF of whose leaves are
// in the step must not be named as though all of it arrived.
function buildStepLabel(members, nameOf, leafCountOf) {
  const list = Array.isArray(members) ? members : [];
  const names = list.map((el) => (el && (el.name || el.id)) || "?").join(", ");
  if (list.length < 2) return names;
  const parent = list[0].parent;
  if (parent == null) return names;
  for (const el of list) if (!el || el.parent !== parent) return names;
  if (leafCountOf(parent) !== list.length) return names;
  return nameOf(parent) || names;
}

// WHAT ONE LAYERS-TREE ROW SHOWS on its right. A leaf answers for itself; a group answers for its
// descendant leaves, because its button writes to every one of them. Four answers, and "mixed" is
// the one that earns its keep: an ordinal on a group holding steps 1, 2 and 3 would be a lie, and
// that state is in the shipped example deck.
function buildRowState(steps, leaves) {
  const list = Array.isArray(leaves) ? leaves : [];
  if (!list.length) return BUILD_ROW_EMPTY;
  const step = buildSelectionStep(list);
  if (step === null) return BUILD_ROW_MIXED;
  if (step === BUILD_NONE) return BUILD_ROW_NONE;
  return { kind: "step", ordinal: buildOrdinal(steps, step) };
}

// The badge box, in PAGE units so it scales with the canvas exactly like the selection ring and the
// snap guides do. It STRADDLES the element's top-RIGHT corner: the selection chip already owns
// top-left, and a badge inside the box would sit on the author's own content.
const BUILD_BADGE = 18;
function buildBadgeBox(rect) {
  if (!rect) return null;
  return { left: rect.x + rect.w - BUILD_BADGE / 2, top: rect.y - BUILD_BADGE / 2, size: BUILD_BADGE };
}

// ── Override-bag transforms (pure) ──────────────────────────────────────────
// Every mutation the editor makes to the override bag lives HERE, as a pure
// `(scene, bag, …) -> bag` function with no React and no DOM. The component holds no second
// copy: each handler in the root is a thin wrapper that gathers the current projection (which
// slide is active, that slide's elements, the deck-wide element list), calls one of these, and
// hands the result to `doCommit`. That is what makes the deck plumbing testable — the wiring
// below is a few lines of glue, and everything that can be wrong about a bag is reachable from
// `tests/unit/run.mjs`.

// The bag contract makes `patch`, `deleted` and `added` OPTIONAL — `{ v: 2, _base: 7 }` is a
// valid, empty bag that validateBakeInput accepts — while every op below reads all three
// unconditionally. This is the ONE place that gap is closed: each op normalizes its input here
// instead of sprinkling `|| []` guards, so a new op cannot forget and a caller other than the
// component (the component normalizes its own bag) cannot trip over it either.
// Only the three v1 collections are materialized. The four deck keys stay ABSENT when they are
// absent, because the ops prune them back out again and an empty `addedSlides: []` or
// `slidePatch: {}` would be bag bytes that say nothing.
function opBag(bag) {
  const raw = isPlainRecord(bag) ? bag : {};
  return {
    ...raw,
    patch: isPlainRecord(raw.patch) ? raw.patch : {},
    deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    added: Array.isArray(raw.added) ? raw.added : [],
  };
}

// One undo/redo stack entry. The bag is normalized to `null` for "there were no overrides at
// all" (distinct from an absent entry), and the two slide ids are the transition's TWO endpoints:
// `slideId` is where the author belongs once THIS entry's bag is restored, and `peerSlideId` is
// the endpoint on the other side of the transition — the cursor the entry pushed onto the
// opposite stack must carry. They differ exactly for the ops that change which slide is active
// (new, duplicate, delete): undoing a New belongs on the slide the author started from, while
// REDOING it belongs on the slide it re-creates. Omit `peerSlideId` for a transition that stays
// put (every element edit, rename, hide, reorder) and both endpoints are the same slide.
// Both are viewport cursors and are never written into the bag — the same rule `activeCell` and
// `croppingId` follow.
function undoEntry(bag, slideId, peerSlideId) {
  const cursor = slideId == null ? null : slideId;
  return {
    bag: bag == null ? null : bag,
    slideId: cursor,
    peerSlideId: peerSlideId === undefined ? cursor : (peerSlideId == null ? null : peerSlideId),
  };
}

// ── The ONE id reservation ─────────────────────────────────────────────────
// Spec S2 puts element ids and slide ids in a SINGLE namespace, so every mint has to dodge every
// id anything else in that namespace could already be called. This namespace has bitten the
// codebase FOUR times — an element mint colliding with a slide id, a slide mint colliding with an
// element id, a new slide handed back the id of a TOMBSTONED one, and then the CORE's own
// permanentizer doing exactly the same thing to an element while this file's table said the class
// was closed. Every time, the fix was "add the missing source to the union", and every time some
// caller was still free to assemble a smaller union of its own.
//
// So the union is declared ONCE, in merge-core.mjs (`EDITABLE_DIVE_BAG_KEYS`), and BOTH sides read
// it: the core's validator takes its bag-key allowlist from that table, the core's two
// permanentizers take their reservation from `reservedNamespaceIds`, and the editor's mint below
// calls the same function. There is no second table to forget, and the suite asserts the two sides
// still agree. `idReserver(scene, bag, ctx)` remains the ONLY way to get a mint function: `mintId`
// is not exported and no call site builds a `taken` set of its own.
//
// A TOMBSTONED id stays reserved for the same reason a baked one does: the id is spent until the
// next bake, and re-minting it is precisely the bag the server refuses.
//
// The editor adds ONE thing the core cannot know — the live projection the caller is editing
// (`ctx.deckAll` is DECK-WIDE, not this slide: element ids are unique across the deck; `ctx.slides`
// is the live slide list). It goes in as `extra`, never as a union of its own.
function reservedIds(scene, bag, ctx) {
  const extra = [];
  for (const el of (ctx && ctx.deckAll) || []) if (el && el.id) extra.push(el.id);
  for (const slide of (ctx && ctx.slides) || []) if (slide && slide.id) extra.push(slide.id);
  return reservedNamespaceIds(scene, bag, extra);
}

// Next free `new-<type>-<n>`. `taken` is EXTENDED as ids are handed out, so minting several ids in
// one operation cannot hand out the same id twice. `counters` is a per-type resume point so a
// large paste does not rescan from 1 for every node. NOT exported: minting from a set assembled
// anywhere but `reservedIds` is the defect this section exists to make impossible.
function mintId(taken, type, counters) {
  let n = (counters && counters[type]) || 1;
  while (taken.has(`new-${type}-${n}`)) n++;
  const id = `new-${type}-${n}`;
  if (counters) counters[type] = n + 1;
  taken.add(id);
  return id;
}

// The one mint entry point. Hand it the scene, the bag and the projection ctx it is minting into;
// it returns `mint(type)`, which every id in one operation comes from — so ids minted together
// dodge each other as well as everything already taken.
function idReserver(scene, bag, ctx) {
  const taken = reservedIds(scene, bag, ctx);
  const counters = {};
  return (type) => mintId(taken, type, counters);
}

// A null written onto an ADDED element is dead weight, not a value. Every inspector control clears a
// setting by writing `null` so prunePatch can drop the key from a PATCH — but an added element is
// edited in place, so the null landed on the element itself and stayed there: toggling a default off
// and on again left `{"header":null,"zebra":null}` in the bag and then in the baked scene, forever.
// `parent` is the one exception, because `null` there is the documented value for "top level" rather
// than the absence of an opinion.
function stripNulls(element) {
  const out = {};
  for (const key of Object.keys(element)) {
    if (element[key] === null && key !== "parent") continue;
    out[key] = element[key];
  }
  return out;
}

// Apply `[{ id, partial }]` to a bag. An added element is edited in place (its id and type are
// immutable); a base element becomes a pruned patch, and a patch that no longer differs from the
// base is dropped entirely so it costs no bytes. An id that is neither is silently skipped.
function buildPatched(scene, rawBag, entries) {
  const bag = opBag(rawBag);
  let added = bag.added;
  const patch = { ...bag.patch };
  for (const { id, partial } of entries) {
    const ai = added.findIndex((e) => e.id === id);
    if (ai >= 0) {
      added = added.map((e, i) => (i === ai ? stripNulls({ ...e, ...partial, id: e.id, type: e.type }) : e));
      continue;
    }
    const baseEl = scene.elements.find((e) => e.id === id);
    if (!baseEl) continue;
    const nextP = prunePatch(baseEl, { ...(patch[id] || {}), ...partial });
    if (Object.keys(nextP).length) patch[id] = nextP; else delete patch[id];
  }
  return { ...bag, patch, added };
}

// z entries for one slide's leaf order. `elements` is the ACTIVE slide's projection, so an id
// from another slide is not found and emits nothing — that is the structural reason an order
// command can never touch a slide the author cannot see. Only leaves whose z actually CHANGES
// are emitted; combined with a base-scene `zOffset` a freshly baked deck reorders for free.
function zEntries(elements, orderedLeafIds, zOffset) {
  const byId = new Map((elements || []).map((e) => [e.id, e]));
  const entries = [];
  (orderedLeafIds || []).forEach((id, i) => {
    const el = byId.get(id);
    const z = ((zOffset || 0) + i + 1) * 10;
    if (el && el.z !== z) entries.push({ id, partial: { z } });
  });
  return entries;
}

// Deleting a group deletes its whole subtree; any group left childless goes too (Figma's
// empty-group rule). `elements` is the active slide's projection, so an id from another slide
// resolves to nothing and is dropped.
function deleteCascade(elements, ids) {
  const list = elements || [];
  const byId = new Map(list.map((e) => [e.id, e]));
  const kids = new Map();
  for (const e of list) {
    const key = parentOf(e) || "";
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(e);
  }
  const kidsOf = (id) => kids.get(id || "") || [];
  const kill = new Set();
  const walk = (id) => {
    if (kill.has(id) || !byId.has(id)) return;
    kill.add(id);
    for (const c of kidsOf(id)) walk(c.id);
  };
  (ids || []).forEach(walk);
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const e of list) {
      if (e.type !== "group" || kill.has(e.id)) continue;
      const k = kidsOf(e.id);
      if (k.length && k.every((c) => kill.has(c.id))) { kill.add(e.id); changed = true; }
    }
    if (!changed) break;
  }
  return [...kill];
}

// The bag after a delete: additions dropped outright, base elements tombstoned, and every dead
// element's patch removed so it stops costing bytes. `null` when nothing died.
function buildDeleted(scene, rawBag, elements, ids) {
  const bag = opBag(rawBag);
  const dead = deleteCascade(elements, ids);
  if (!dead.length) return null;
  const kill = new Set(dead);
  const patch = { ...bag.patch };
  dead.forEach((id) => delete patch[id]);
  const baseDel = dead.filter((id) => scene.elements.some((e) => e.id === id));
  return {
    bag: {
      ...bag, patch,
      added: bag.added.filter((e) => !kill.has(e.id)),
      deleted: [...new Set([...bag.deleted, ...baseDel])],
    },
    dead,
  };
}

// Paste / duplicate. `ctx` is the current projection:
//   { deckAll, slides, elements, leafOrder, zOffset, slideId, isDeck }
// where `elements` and `leafOrder` are the ACTIVE slide's (all elements, then its leaf ids in
// paint order). Every node is re-stamped with the TARGET slide, which is how content moves
// between slides; a root whose original parent group is not on this slide lands at the slide's
// top level instead of rejoining a group it could not legally belong to. Returns null for an
// empty insert.
function buildInserted(scene, rawBag, ctx, trees, dx, dy) {
  if (!trees || !trees.length) return null;
  const bag = opBag(rawBag);
  const byId = new Map((ctx.elements || []).map((e) => [e.id, e]));
  const mint = idReserver(scene, bag, ctx);
  const idMap = {};
  for (const t of trees) for (const n of t.nodes) idMap[n.id] = mint(n.type);
  const fresh = [], rootIds = [];
  for (const t of trees) {
    rootIds.push(idMap[t.rootId]);
    const rpEl = t.rootParent ? byId.get(t.rootParent) : null;
    const rp = rpEl && rpEl.type === "group" ? t.rootParent : null;
    for (const n of t.nodes) {
      const node = stampSlide({ ...clone(n), id: idMap[n.id] }, ctx.slideId, ctx.isDeck);
      node.parent = n.id === t.rootId ? rp : (idMap[n.parent] || null);
      if (n.type !== "group") { node.x = R(n.x + dx); node.y = R(n.y + dy); }
      fresh.push(node);
    }
  }
  // Each clone block lands CONTIGUOUSLY immediately above its source block; a clipboard whose
  // source has since been deleted (or lives on another slide) goes on top instead.
  const order = (ctx.leafOrder || []).slice();
  for (const t of trees) {
    const srcLeaves = t.nodes.filter((n) => n.type !== "group");
    let at = -1;
    for (const n of srcLeaves) { const i = order.indexOf(n.id); if (i > at) at = i; }
    order.splice(at < 0 ? order.length : at + 1, 0, ...srcLeaves.map((n) => idMap[n.id]));
  }
  const zFor = {};
  order.forEach((id, i) => { zFor[id] = ((ctx.zOffset || 0) + i + 1) * 10; });
  for (const node of fresh) if (node.type !== "group") node.z = zFor[node.id];
  let next = { ...bag, added: [...bag.added, ...fresh] };
  const ze = order
    .filter((id) => byId.has(id) && byId.get(id).z !== zFor[id])
    .map((id) => ({ id, partial: { z: zFor[id] } }));
  if (ze.length) next = buildPatched(scene, next, ze);
  return { bag: next, added: fresh, rootIds };
}

// A brand-new element joins the bag's additions. It is the third mint site, so it goes through the
// same `idReserver` as the other two. `ctx.type` is the id prefix; `makeElement(id, stamp)` is
// handed the minted id and a pre-bound slide stamp so the caller decides WHERE in its element
// literal the `slide` key lands, keeping the emitted JSON byte-for-byte what it was.
function buildAdded(scene, rawBag, ctx, makeElement) {
  const bag = opBag(rawBag);
  const id = idReserver(scene, bag, ctx)(ctx.type);
  const el = makeElement(id, (common) => stampSlide(common, ctx.slideId, ctx.isDeck));
  return { bag: { ...bag, added: [...bag.added, el] }, id, element: el };
}

// ── Slide operations (pure) ─────────────────────────────────────────────────
// The deck half of the same idea. Every slide command is a pure `(scene, bag, …) -> bag` that
// writes ONLY the four deck keys — plus the element keys where deleting a slide takes its
// elements' bag entries with it. The four ops that change the deck's shape return
// `{ bag, slideId, order }`: `slideId` is where the cursor belongs afterwards and `order` is the
// resulting full deck order, which the glue needs because the effective `slides` list is one
// render behind the commit and cannot yet contain a brand-new slide.

const SLIDE_DECK_FULL = `This deck is at the ${EDITABLE_DIVE_MAX_SLIDES}-slide limit`;
const SLIDE_LAST_ONE = "A deck needs at least one slide — this is the last one";
// Same words as the top bar's stale banner, and it names that banner's own button, because the
// only way out is the affordance already on screen.
const SLIDE_STALE = "Edits from an older version are being ignored — Clear stale edits first";

// A bag whose `_base` is not the scene's version is STALE: effectiveSlides returns the base
// slides verbatim for it (spec §3), so a slide op would write a bag the render then ignores —
// the author clicks New and nothing happens. Such a bag can never bake either (validateBakeInput
// fails STALE_BASE), so there is no path to a wrong baked deck; the only symptom is a dead-looking
// UI, and this refusal is what turns it into a sentence. A bag with no `_base` at all is not
// stale: normOv reads that as "against the current scene", and so does this.
function slideStaleRefusal(scene, bag) {
  const base = isPlainRecord(bag) ? bag._base : undefined;
  return scene && base !== undefined && base !== scene.version ? SLIDE_STALE : null;
}

// The slide cap is the SAME count validateBakeInput checks: base slides plus `addedSlides`, not
// the live count. Deleting a slide does not free its temp id, so the live count would let the
// author mint a bag that renders fine and then fails at the Save boundary.
function slideAddRefusal(scene, bag) {
  const minted = ((scene && scene.slides) || []).length + ((bag && bag.addedSlides) || []).length;
  return minted >= EDITABLE_DIVE_MAX_SLIDES ? SLIDE_DECK_FULL : null;
}

// merge-core deliberately does NOT stop a bag from deleting every slide: its tolerant path
// reports the empty deck, and the editor then paints a blank canvas with no way back. The core's
// comment delegates the rule to the UI, so it lives here — as a refusal with a message, next to
// `mintRefusal`, not as a disabled button, so the author is told why.
function slideDeleteRefusal(slides, slideId) {
  const list = slides || [];
  if (!list.some((slide) => slide && slide.id === slideId)) return null; // not live: a no-op, not a refusal
  return list.length <= 1 ? SLIDE_LAST_ONE : null;
}

const slideIdsOf = (slides) => (slides || []).map((slide) => slide.id);

// The deck order the bag produces with NO `slideOrder`: base slides then `addedSlides`, both
// minus `deletedSlides` — steps 1-2 of `slidesOf`. Every order is pruned against it.
// Stale-aware for the same reason effectiveSlides is: a stale bag HAS no deck edits, so its
// natural order is the base order alone. Defensive — every op refuses a stale bag before it gets
// here — but pruning correctness rests on this function agreeing with `slidesOf` exactly, and a
// silent disagreement in the stale case is the kind of thing that survives for months.
function naturalSlideOrder(scene, bag) {
  const stale = !!slideStaleRefusal(scene, bag);
  const dropped = new Set(stale ? [] : (bag && bag.deletedSlides) || []);
  const ids = [];
  const source = stale
    ? ((scene && scene.slides) || [])
    : [...((scene && scene.slides) || []), ...((bag && bag.addedSlides) || [])];
  for (const slide of source) {
    if (slide && typeof slide.id === "string" && !dropped.has(slide.id) && !ids.includes(slide.id)) ids.push(slide.id);
  }
  return ids;
}

// Spec O5 has no partial form: `slideOrder` is a FULL permutation of the live set or it is absent.
// So every op materializes the complete order and this drops it again when it says nothing —
// the same pruning discipline `prunePatch` applies to elements. That is what keeps appending a
// slide, or deleting the last one, from paying for an order it did not change.
function withSlideOrder(scene, bag, order) {
  const natural = naturalSlideOrder(scene, bag);
  const next = { ...bag };
  if (order.length === natural.length && order.every((id, i) => id === natural[i])) delete next.slideOrder;
  else next.slideOrder = order;
  return next;
}

// Immediately AFTER the active slide — where every presentation tool puts a new slide — or at the
// end when the cursor names none (a deck whose slides were all deleted; new-slide is its way back).
function orderWithInsert(ids, id, afterId) {
  const out = ids.slice();
  const at = out.indexOf(afterId);
  out.splice(at < 0 ? out.length : at + 1, 0, id);
  return out;
}

// Which slide an element sits on with the bag applied. `slide` is patchable (spec O6), so the
// baked value is not the answer.
function slideOfEl(el, bag) {
  const p = bag && bag.patch ? bag.patch[el.id] : null;
  return p && Object.hasOwn(p, "slide") ? p.slide : el.slide;
}

// Field equality for the slide pruner. Only `hidden` has a default — absent means visible — and an
// emptied string field is the same as an unset one, so clearing a name costs zero bytes instead
// of `"name":""`.
function slideFieldEq(key, a, b) {
  if (key === "hidden") return !!a === !!b;
  return (a == null ? "" : a) === (b == null ? "" : b);
}

// One tree per top-level element of a slide, subtree flattened root-first — the exact shape
// `buildInserted` eats, so duplicate-slide reuses the ONE cloner instead of growing a second.
// Siblings are ordered by the lowest `z` beneath them because buildInserted assigns fresh `z` in
// node order: that is what makes the copy paint like its source.
function slideTrees(elements) {
  const list = elements || [];
  const kids = new Map();
  for (const el of list) {
    const key = parentOf(el) || "";
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(el);
  }
  const minZ = new Map();
  const zOf = (el) => {
    if (minZ.has(el.id)) return minZ.get(el.id);
    minZ.set(el.id, Infinity); // set BEFORE recursing: a parent cycle must not loop forever
    let z = el.type === "group" || !Number.isFinite(el.z) ? Infinity : el.z;
    for (const kid of kids.get(el.id) || []) z = Math.min(z, zOf(kid));
    minZ.set(el.id, z);
    return z;
  };
  const sorted = (arr) => arr.slice().sort((a, b) => zOf(a) - zOf(b));
  const trees = [];
  for (const root of sorted(kids.get("") || [])) {
    const nodes = [];
    const walk = (el, depth) => {
      if (depth > 32) return;
      nodes.push(clone(el));
      for (const kid of sorted(kids.get(el.id) || [])) walk(kid, depth + 1);
    };
    walk(root, 0);
    trees.push({ rootId: root.id, rootParent: null, nodes });
  }
  return trees;
}

// Where a COPY of `slideId`'s leaves starts in the global paint order: the source slide's own
// baked offset plus its own baked leaf count, i.e. exactly one slide's worth further along. Reads
// the BASE scene for both halves for the reason leavesBeforeSlide spells out. It lives here
// rather than inline in the component's duplicate handler so the ONE non-trivial expression in
// that glue is the same expression the tests exercise — a drift in the component would otherwise
// be invisible to the suite.
function slideZOffset(scene, slides, slideId) {
  const baseEls = (scene && scene.elements) || [];
  const own = baseEls.filter((el) => el && el.slide === slideId && el.type !== "group").length;
  return leavesBeforeSlide(baseEls, slides, slideId) + own;
}

// ── Text lists and autofit (pure) ───────────────────────────────────────────
// ZERO new schema keys, for the reason ghostTextOf spells out: the text allow-list is generated from
// merge-core.mjs, frozen and byte-identical across both templates AND every saved Dive's inlined core (which the save Flight
// bakes with), so a new key is a lockstep before a dive using it can save.
//
// LISTS LIVE IN `level`, already the BLOCK TYPE — the key picking a text element's HTML tag and
// default metrics — and `ul`/`ol` are the block types HTML puts beside h1/h2/h3/p. The core validates
// the KEY, never the value, so `level: "ul"` is legal today and the inspector's level control IS the
// list control, making "an h2 that is also a bulleted list" unrepresentable. That is also the cost: a
// list takes body metrics unless `fontSize`/`weight` say otherwise. The INDENT is leading tabs per
// line of `text` (the plan's own choice); MARKERS stay out of the string, where stored glyphs would be
// typeable by accident and (numbered) stale as soon as a line moved.
const LIST_MAX_DEPTH = 8;      // deeper than a slide needs; the cap keeps a pasted string sane
const LIST_INDENT_EM = 1.6;    // one indent step, in EM so the list scales with autofit
const LIST_MARKER_EM = 1.15;   // the marker column's minimum width; it grows for "10." itself
const LIST_BULLETS = ["•", "◦", "▪"];   // cycled by depth, as Slides does
const LIST_ALPHA = "abcdefghijklmnopqrstuvwxyz";
const LIST_TAB_SIZE = 2;       // while EDITING, a tab reads as one indent step, not 8 columns

// The list kinds and the block tag a text element renders as: six values of ONE key.
const listKindOf = (el) => (el && (el.level === "ul" || el.level === "ol") ? el.level : null);
function textTagOf(el) {
  const level = el && el.level;
  return level === "h1" || level === "h2" || level === "h3" ? level : "p";
}
// The px size a text element resolves to BEFORE autofit. Shared by the renderer and the readout, so
// the number the author is TOLD and the number DRAWN cannot drift.
const textFontSize = (el) =>
  (el && el.fontSize != null ? Number(el.fontSize) : (LEVEL_STYLES[el && el.level] || LEVEL_STYLES.p).size);

// One line, split into indent and content. Leading TABS only — a leading SPACE is content, so a
// line aligned by eye is not silently promoted a level.
function listDepthOf(line) {
  const text = String(line == null ? "" : line);
  let raw = 0;
  while (raw < text.length && text.charAt(raw) === "\t") raw += 1;
  return { depth: Math.min(raw, LIST_MAX_DEPTH), body: text.slice(raw) };
}

// 1 -> a, 26 -> z, 27 -> aa. Bijective base-26, so no ordinal is ever skipped or repeated.
function listAlpha(n) {
  let k = Math.max(1, Math.trunc(n));
  let out = "";
  while (k > 0) {
    const r = (k - 1) % 26;
    out = LIST_ALPHA.charAt(r) + out;
    k = (k - 1 - r) / 26;
  }
  return out;
}
// Subtractive pairs before their bases, so the greedy loop below emits `ix` and never `viiii`.
// Lower case, and no zero: `listMarker` only ever asks for ordinals, which start at 1.
const LIST_ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
function listRoman(n) {
  let k = Math.max(1, Math.trunc(n));
  let out = "";
  for (const [value, glyph] of LIST_ROMAN) while (k >= value) { out += glyph; k -= value; }
  return out;
}
// decimal / lower-alpha / lower-roman, cycled by depth — the ladder Slides and Word both use.
function listMarker(kind, depth, n) {
  const d = Math.max(0, Math.trunc(depth));
  if (kind !== "ol") return LIST_BULLETS[d % LIST_BULLETS.length];
  const style = d % 3;
  return (style === 0 ? String(Math.max(1, Math.trunc(n))) : style === 1 ? listAlpha(n) : listRoman(n)) + ".";
}

// One counter PER DEPTH; an item at depth d bumps its own and DISCARDS every deeper one, so returning
// to a shallower level restarts the next sublist while an item nested deeper inside a run does not
// interrupt it. Recomputed from the raw text every render, so an indent renumbers for free. A BLANK
// line is TRANSPARENT — no marker, no ordinal consumed, no run broken — because it is the only way
// this string can put air between items.
function listItems(text, kind) {
  const counters = [];
  return String(text == null ? "" : text).split("\n").map((line) => {
    const { depth, body } = listDepthOf(line);
    if (body === "") return { depth, body: "", marker: "", blank: true };
    counters[depth] = (counters[depth] || 0) + 1;
    counters.length = depth + 1;
    return { depth, body, marker: listMarker(kind, depth, counters[depth]), blank: false };
  });
}

// Tab / Shift-Tab while editing, PURE — so "the caret keeps the same words" and "an indent stops at
// the cap" are assertions about a function rather than claims about a keydown handler.
//
// The selection rules, each of which is a bug someone hits otherwise:
//   • every line the selection TOUCHES moves, a bare caret's line included;
//   • an end exactly AT a line start does not pull that line in — without this, selecting one whole
//     line (which ends at the start of the next) indents two;
//   • a caret at a line start rides OUT with the inserted tab, so the words under it do not shift
//     away from the cursor.
// `changed` is separate from the string so the caller can swallow the key — focus must never leave
// the box — without writing an identical string back and minting a no-op override.
function indentText(text, start, end, outdent) {
  const src = String(text == null ? "" : text);
  const clamp = (v) => Math.max(0, Math.min(src.length, Math.trunc(Number(v)) || 0));
  const from = Math.min(clamp(start), clamp(end));
  const to = Math.max(clamp(start), clamp(end));
  // The last offset that still counts as "inside the selection": for a range, the character BEFORE
  // its end; for a caret, the caret itself.
  const lastInside = to > from ? to - 1 : to;
  const out = [];
  let at = 0;
  let shiftFrom = 0;
  let shiftTo = 0;
  let changed = false;
  for (const line of src.split("\n")) {
    const lineEnd = at + line.length;
    let next = line;
    if (lineEnd >= from && at <= lastInside) {
      if (outdent) {
        if (line.charAt(0) === "\t") {
          next = line.slice(1);
          changed = true;
          if (at < from) shiftFrom -= 1;
          if (at < to) shiftTo -= 1;
        }
      } else if (listDepthOf(line).depth < LIST_MAX_DEPTH) {
        next = "\t" + line;
        changed = true;
        if (at <= from) shiftFrom += 1;
        if (at <= to) shiftTo += 1;
      }
    }
    out.push(next);
    at = lineEnd + 1;
  }
  return {
    text: out.join("\n"),
    start: Math.max(0, from + shiftFrom),
    end: Math.max(0, to + shiftTo),
    changed,
  };
}

// AUTOFIT IS WHAT A FIXED HEIGHT MEANS. `h` already carries the whole decision in two states one key
// cannot hold at once: `h: "auto"` grows the BOX to the text (unchanged, still text's default), a
// numeric `h` shrinks the TEXT to the box. Mutual exclusion is the arity of one key, not a rule anyone
// enforces, and the inspector's H field is already the control. The cost: "fixed height, let it
// overflow" stops being expressible, which is the trade the feature exists to make. Shrink-ONLY, so a
// fixed box whose text fits keeps its authored size and nothing existing changes unless it was
// already overflowing.
//
// The ladder is a FIXED ARRAY rather than a search, and that is what makes the whole thing
// terminate: eleven candidate scales, measured all at once, picked by an index. Binary-searching a
// continuous size would need a measurement per probe and each probe's result would depend on the
// previous one. The steps are 6 percentage points apart because that is roughly the smallest
// difference visible at slide type sizes — finer steps would cost probes to redraw the same
// picture. It bottoms out at 0.4 and not lower: below ~40% of an authored size the text is no
// longer the thing the author styled, and silently shrinking further hides an overflow that the
// author should see and fix. Hitting the floor is therefore a REPORTED state (autofitReadout says
// "minimum"), not a quiet success.
const AUTOFIT_LADDER = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46, 0.4];
const autofitOn = (el) => !!el && el.type === "text" && Number.isFinite(el.h);
const autofitScale = (index) =>
  AUTOFIT_LADDER[Math.max(0, Math.min(AUTOFIT_LADDER.length - 1, Math.trunc(Number(index)) || 0))];
const autofitPercent = (index) => Math.round(autofitScale(index) * 100);

// The measurement key: every input that changes how tall the text lays out, and deliberately NOT
// `h`. That omission is the entire anti-oscillation argument (see useAutofit). Width IS in the key
// because it changes wrapping; height is not, because it only chooses which already-measured step
// wins. Joined on a separator no style value can hold, so two key tuples cannot collide into one.
const AUTOFIT_GEN_KEYS = ["text", "level", "fontSize", "weight", "lineHeight", "italic"];
function autofitGen(el, boxW) {
  if (!autofitOn(el)) return "";
  const parts = [String(Math.round(Number(boxW) || 0))];
  for (const key of AUTOFIT_GEN_KEYS) parts.push(el[key] === undefined ? "" : String(el[key]));
  return parts.join("\u0001");
}

// Pick the ladder step from the measured natural height AT EACH STEP and the box: the FIRST that fits
// wins, so the answer is the largest size that fits, and when nothing fits the floor is used rather
// than the text vanishing. No monotonicity is assumed — "the first index that fits" is total and
// terminating whatever the measurements say.
function autofitPick(heights, boxH) {
  if (!Array.isArray(heights) || !heights.length) return 0;
  const box = Number(boxH);
  if (!Number.isFinite(box) || box <= 0) return 0;
  for (let i = 0; i < heights.length; i += 1) {
    if (Number.isFinite(heights[i]) && heights[i] <= box) return i;
  }
  return heights.length - 1;
}

// EPHEMERAL, and that is a schema decision: the settled step is a measurement of the current
// viewport, not an edit to the document, so it never enters the override bag — the same rule
// `activeCell`, `croppingId` and `wantedSlideId` follow. Re-deriving it costs one layout pass and
// keeps the bag free of a number that would be wrong on the next window size.
//
// Written as a transition rather than inside a setState closure so the three decisions in it are
// reachable by a test. Returning the SAME object when nothing moved keeps a measurement from
// re-rendering the inspector, and the null branch is what stops a box that no longer autofits from
// keeping a stale readout.
function fitMapPatch(prev, id, index) {
  const map = prev || {};
  if (index == null) {
    if (!Object.hasOwn(map, id)) return map;
    const next = { ...map };
    delete next[id];
    return next;
  }
  if (map[id] === index) return map;
  return { ...map, [id]: index };
}

// WHAT THE AUTHOR IS TOLD. A shrink nobody asked for needs a reason on screen, in the author's own
// units, plus the two states a percentage alone cannot explain: measuring, and at the floor.
function autofitReadout(el, index) {
  if (!autofitOn(el)) return null;
  const base = textFontSize(el);
  if (index == null) return "Measuring…";
  const step = Math.max(0, Math.min(AUTOFIT_LADDER.length - 1, Math.trunc(Number(index)) || 0));
  if (step === 0) return "Fits at " + base + "px";
  const size = Math.round(base * autofitScale(step) * 10) / 10;
  return "Shrunk to " + autofitPercent(step) + "% — " + size + "px"
    + (step === AUTOFIT_LADDER.length - 1 ? " (minimum)" : "");
}

// ── Layouts and placeholder ghosts (pure) ───────────────────────────────────
// A layout is a STAMP, not a live link: it emits ordinary elements into a brand-new slide and is
// then forgotten (plan §4 — no master/layout inheritance graph, no master editing UI). Nothing
// records which layout a slide came from, so every element a layout produced is selected, moved,
// restyled and deleted exactly like one the author added by hand.
//
// FLAT, NEVER GROUPED. A layout could plausibly wrap its title block in a group, and reference.md
// asks authored scenes to do that — but `clickTarget` promotes a click to the outermost ancestor
// GROUP, so a grouped placeholder would select the group instead of the text and the one-click
// caret below could never fire. A layout's job is to be typed into immediately; grouping is
// something the author can do afterwards with ⌘G.
//
// THE PLACEHOLDER GHOST, AND WHY IT NEEDS NO SCHEMA KEY. The plan sketches
// `placeholder: "Click to add title"` on a layout's text elements. That would be a NEW key on
// `text`, and the allow-list it has to join is generated from merge-core.mjs — frozen, twice
// reviewed, and inlined byte-for-byte in every Dive the save Flight bakes. It would also be a key that BAKES:
// ghost prose stored on the element, shipped in the dive source, one careless renderer away from
// being read as content.
//
// So the ghost is DERIVED, not stored. The condition is "a text element with NO `text` KEY", and
// the words come from the element's `name` — which layouts already set (`Title`, `Subtitle`,
// `Body`) and which the layers tree and the inspector header already display. Every requirement
// falls out:
//   • zero new schema keys, zero core change, and zero bytes on the wire — a placeholder omits
//     `text` entirely, which is legal (only x/y/w/h/z are required of a text element);
//   • it cannot bake as content, because there is no content to bake;
//   • it vanishes on the first keystroke for free, because the condition stops holding.
//
// THE KEY, NOT FALSINESS. This condition was "no text OR empty text", which made an author who
// CLEARED an authored title indistinguishable from a placeholder that was never filled: the words
// were gone and the box said "Click to add title" on the canvas and in the rail, as if nothing had
// ever been written there. It also made a deliberately-empty text box unrepresentable. `text: ""`
// is a value the author chose and survives merge, patch-pruning and bake distinctly from an absent
// key, so the key is the honest test — and it is what a placeholder actually IS. The problem the
// loose version was covering (an `h: "auto"` box with no text collapsing to an unclickable sliver)
// is solved where it belongs, by AUTO_TEXT_MIN_H on the element wrapper.
function ghostTextOf(el) {
  if (!el || el.type !== "text") return null;
  if ("text" in el) return null;
  // Three phrasings, as in Slides — a per-element sentence would just be the `name` twice.
  // Anchored at a WORD BOUNDARY: a bare substring match called "Untitled" a title, and would
  // caption any name that happens to contain one of these words. Matching the word's START keeps
  // the plural ("Subtitles") while dropping the accident ("Untitled"). "subtitle" is tested first
  // because a name can hold both words, and the more specific one wins.
  const words = (typeof el.name === "string" ? el.name.toLowerCase() : "").split(/[^a-z]+/);
  const named = (word) => words.some((w) => w.startsWith(word));
  return "Click to add " + (named("subtitle") ? "subtitle" : named("title") ? "title" : "text");
}

// WHICH SURFACES SHOW A GHOST — one decision in one place, instead of one per call site. The two
// EDIT surfaces do: the canvas and the filmstrip rail, both of which are edit-mode chrome (a slide
// freshly stamped from a layout would otherwise have a completely blank thumbnail and hide the
// layout the author just picked). The two VIEWER surfaces never do: present mode and the reading
// view render `el.text`, so a placeholder is simply empty there — which is the whole "must not
// appear in present mode" rule. An unknown surface — or none — shows nothing, so a caller that
// forgets to declare itself gets ghost-free rendering rather than hint prose in front of an
// audience. That default is the reason this is a surface name and not a boolean.
const GHOST_SURFACES = new Set(["canvas", "thumb"]);
function ghostVisible(el, surface) {
  return GHOST_SURFACES.has(surface) ? ghostTextOf(el) : null;
}

// An `h: "auto"` text element with no text has no content to give it height, so its box collapses
// to a zero-height sliver: unclickable, un-hoverable, and with a selection ring you cannot see.
// A floor on the WRAPPER fixes that without touching what "empty" means (the ghost condition above
// used to widen itself to cover this, at the cost of hiding cleared text). It is a rendering
// minimum only: nothing writes it into `h`, so the bag and the baked scene never see it.
const AUTO_TEXT_MIN_H = 24;

// Which element a plain click should drop a CARET into, or null for "this click only selects".
// Four conditions, each one a bug that shipped or nearly did:
//   • the click must resolve to the element ITSELF — a placeholder inside a group promotes to the
//     group, and the group is what a click there selects;
//   • the element must be showing a GHOST on the canvas — a text box with words in it keeps the
//     double-click rule, because there a single click means "select the box", which is what
//     dragging and restyling need;
//   • the click must be UNMODIFIED — shift-click means "extend the selection", and a caret dropped
//     into a member of a multi-selection puts a contenteditable under the typing guard, which then
//     swallows ⌘D, Delete and ⌘G while the inspector still offers all three;
//   • the selection must be exactly this ONE element, for the same reason.
function tapTarget(el, clickTargetId, shiftKey, selLength) {
  if (!el || shiftKey || selLength !== 1) return null;
  if (clickTargetId !== el.id) return null;
  return ghostVisible(el, "canvas") ? el.id : null;
}

// Whether a text commit CHANGES anything. A placeholder has no `text` key at all, so clicking into
// a ghost and out again without typing would commit "" — an undo step and 11 bag bytes for a change
// nobody made, and (now that a cleared box keeps its emptiness) a placeholder that quietly stopped
// being one. Absent and "" are the same EDIT here even though they are different VALUES: only a
// real keystroke may write the key.
const textCommitChanged = (el, text) => text !== ((el && el.text) || "");

// "Match the page" writes NULL, not the colour the picker is showing. Absent is precisely what
// falls back to `page.background`, so absent is the canonical way to say it — and writing the
// colour instead would make a per-slide background impossible to REMOVE, only to overwrite.
const slideBackgroundWrite = (value, pageBackground) => (value === pageBackground ? null : value);

// Whether a finished pointer gesture was a TAP — a plain click. It ENDED (a release, not a
// pointercancel), it never crossed the drag threshold, and it was not escaped mid-gesture. Pure so
// that "a drag does not drop a caret" and "a cancelled gesture does not either" are assertions
// rather than claims about a closure.
const gestureIsTap = (released, moved, cancelled) => !!released && !moved && !cancelled;

// The layout geometry, in the 1280×720 logical space every slide shares. These are the same
// authored conventions slides/deck-v2.json uses — 96px side margins, an 8px vertical rhythm, one
// accent rule under a heading — so a stamped slide sits in a hand-authored deck without looking
// pasted in. Two colours plus one accent, per reference.md.
const SL_MARGIN = 96;
const SL_COL = 1280 - SL_MARGIN * 2;          // 1088 — the full-width content column
const SL_HALF = 520, SL_GUTTER = 48;          // 96 + 520 + 48 + 520 + 96 = 1280
// A MEASURE for body copy, not the full column: 1088px at 20px is ~88 characters a line, wider
// than any text run in the authored deck (the widest is 900). 880 is a paragraph you can read.
const SL_BODY = 880;
// Heading to accent rule: deck-v2.json puts an h2 at y 72 and its rule at y 132. The gap, not the
// grid, is what makes a stamped slide sit in register beside an authored one — so the rule follows
// its heading and is deliberately NOT snapped to the 8px rhythm the rest of the geometry keeps.
const SL_RULE_DROP = 60;
const SL_INK = "#231f20", SL_MUTED = "#6a6a6a", SL_ACCENT = "#0777b3";
// The deck's third text colour, used for exactly one thing in the authored deck and here: the
// corner footer. Four of the five authored slides put a 100px, right-aligned, 14px footer slot at
// x 1096; a stamped slide with no footer is the only slide in the deck without one.
const SL_FAINT = "#9a9aa3";
const SL_FOOT_X = 1096, SL_FOOT_W = 100, SL_FOOT_Y = 600, SL_FOOT_SIZE = 14;
// The tint the authored deck itself uses for a slide that is a different KIND of slide
// (deck-v2.json's slide-3). Stamped on the section-header record — see SLIDE_LAYOUTS.
const SL_TINT = "#fbf7f0";
// `text` is deliberately ABSENT (see ghostTextOf). Key order matches what addElement emits for a
// hand-added text element minus that one key, so a layout's JSON reads like the rest of the bag.
const slLayoutText = (name, level, x, y, w, h, fontSize, color) => ({
  name, type: "text", x, y, w, h, level, fontSize, color, align: "left",
});
const slLayoutRule = (y) => ({
  name: "Rule", type: "line", x: SL_MARGIN, y, w: 96, h: 8, orientation: "h", color: SL_ACCENT, thickness: 3,
});
// The corner footer every authored slide carries. Right-aligned in its slot, so it reads as a page
// number however long the text is. It ghosts like any other placeholder, and an author who wants
// no footer deletes it — the same as any other element a layout stamps.
const slLayoutFooter = () => ({
  name: "Footer", type: "text", x: SL_FOOT_X, y: SL_FOOT_Y, w: SL_FOOT_W, h: "auto",
  level: "p", fontSize: SL_FOOT_SIZE, color: SL_FAINT, align: "right",
});

// The five layouts, in picker order. `build()` returns element BODIES in paint order — no id, no
// z, no slide: buildNewSlide mints those, so the definitions stay pure data and the tests can read
// them without a bag. "Blank" builds nothing, which is exactly what a new slide was before layouts
// existed — so the no-layout path is byte-for-byte the old one.
const SLIDE_LAYOUTS = [
  { k: "blank", label: "Blank", build: () => [] },
  {
    k: "title", label: "Title slide", build: () => [
      slLayoutText("Title", "h1", SL_MARGIN, 248, SL_COL, "auto", 54, SL_INK),
      slLayoutText("Subtitle", "p", SL_MARGIN, 336, SL_BODY, "auto", 22, SL_MUTED),
      slLayoutRule(408),
      slLayoutFooter(),
    ],
  },
  {
    k: "titleBody", label: "Title and content", build: () => [
      slLayoutText("Title", "h2", SL_MARGIN, 72, SL_COL, "auto", 38, SL_INK),
      slLayoutRule(72 + SL_RULE_DROP),
      // A fixed height, not "auto": this box IS the content region, and a fixed box is what an
      // author drops several paragraphs into without the slide reflowing under them. (Autofit is a
      // later task; nothing shrinks to fit yet.) Empty, it renders as one line of grey at the top
      // left — a placeholder, not an outline of the region.
      slLayoutText("Body", "p", SL_MARGIN, 176, SL_BODY, 472, 20, SL_INK),
      slLayoutFooter(),
    ],
  },
  {
    k: "twoBody", label: "Two content", build: () => [
      slLayoutText("Title", "h2", SL_MARGIN, 72, SL_COL, "auto", 38, SL_INK),
      slLayoutRule(72 + SL_RULE_DROP),
      slLayoutText("Left", "p", SL_MARGIN, 176, SL_HALF, 472, 18, SL_INK),
      slLayoutText("Right", "p", SL_MARGIN + SL_HALF + SL_GUTTER, 176, SL_HALF, 472, 18, SL_INK),
      slLayoutFooter(),
    ],
  },
  {
    // A LOUDER BEAT, and a different KIND of slide. At 44px with the same ink on the same white
    // this was a title slide minus its subtitle — and at 70px wide in the filmstrip it was
    // indistinguishable from one. Two changes, because they answer two different questions: the h1
    // goes to the deck's loudest size (54, what deck-v2.json's own title and closing slides use)
    // so it reads as a beat on the canvas, and the slide RECORD carries the tint the authored deck
    // uses for its own odd-one-out slide, which is the part that reads at thumbnail size.
    k: "section", label: "Section header", slide: { background: SL_TINT }, build: () => [
      slLayoutText("Section title", "h1", SL_MARGIN, 296, SL_COL, "auto", 54, SL_INK),
      slLayoutRule(376),
      slLayoutFooter(),
    ],
  },
];

const slideLayout = (k) => SLIDE_LAYOUTS.find((l) => l.k === k) || null;
// An unknown key is "blank", not a throw: the layout key comes from a menu and a stale one must
// not be able to break a new slide.
const slideLayoutElements = (k) => {
  const l = slideLayout(k);
  return l ? l.build() : [];
};
// The slide-RECORD half of a layout: the fields it asserts on the `addedSlides` entry itself rather
// than on an element. Only `background` is used today (the section header's tint), and only the
// patchable slide keys can ever come through — a layout cannot smuggle an `id` or an unknown key
// into the bag. Absent for every other layout, so their records stay the cheapest legal one.
const slideLayoutRecord = (k) => {
  const l = slideLayout(k);
  const out = {};
  if (l && isPlainRecord(l.slide)) {
    for (const key of EDITABLE_DIVE_SLIDE_PATCH_KEYS) {
      if (l.slide[key] !== undefined) out[key] = l.slide[key];
    }
  }
  return out;
};

// NEW. Minted through the ONE reserved-id set (idReserver), because spec S2 puts slide ids in the
// element id namespace. The record carries only what the layout asserts — for four of the five
// layouts that is nothing at all, and an unnamed record is the cheapest legal slide.
//
// `ctx.layout` optionally names one of SLIDE_LAYOUTS; its elements ride the EXISTING `added` array
// with the new slide stamped on them, which is the whole reason "new slide with a layout" is ONE
// commit and ONE undo step: the slide record and its elements are two keys of one bag, and the glue
// hands that bag to the same `doCommit` a drag goes through. No layout (or "blank", or an unknown
// key) emits nothing at all, so the pre-layout path is byte-for-byte unchanged.
//
// Ids come from the SAME `taken` set the slide id came from, extended in place — a layout minting
// four elements cannot collide with the slide it is being stamped into. `ctx.zOffset` is where this
// slide's leaves start in the global paint order (slideZOffset, as duplicate-slide uses); pending
// z may collide across slides between bakes and that is declared harmless, because bake
// re-contiguises by (slideIndex, z) and nothing paints two slides at once.
function buildNewSlide(scene, rawBag, ctx) {
  const bag = opBag(rawBag);
  // A v1 or slideless scene has no deck to add to, and `addedSlides` is not even a legal bag key
  // there — so a bag written here could never bake. Not reachable from the UI (the filmstrip
  // renders only for a deck), but this is an exported pure API and the next caller will not know.
  // An all-slides-DELETED deck is NOT this case and must keep working: it is still a v2 scene with
  // base slides, its live slide list is empty, and a new slide is its only way back (spec/SLEDS).
  if (!isDeckScene(scene) || !Array.isArray(scene.slides)) return null;
  if (slideAddRefusal(scene, bag) || slideStaleRefusal(scene, bag)) return null;
  const mint = idReserver(scene, bag, ctx);
  const id = mint("slide");
  let next = { ...bag, addedSlides: [...(bag.addedSlides || []), { id, ...slideLayoutRecord(ctx.layout) }] };
  const specs = slideLayoutElements(ctx.layout);
  if (specs.length) {
    const zBase = Number.isFinite(ctx.zOffset) ? ctx.zOffset : 0;
    // Same two-step shape addElement uses (a stamped `common`, then the type body), so the key
    // order of a layout's element matches a hand-added one exactly.
    const fresh = specs.map(({ name, ...body }, i) => ({
      ...stampSlide({ id: mint(body.type), name, z: (zBase + i + 1) * 10, opacity: 1 }, id, true),
      ...body,
    }));
    next = { ...next, added: [...next.added, ...fresh] };
  }
  const order = orderWithInsert(slideIdsOf(ctx.slides), id, ctx.afterId);
  return { bag: withSlideOrder(scene, next, order), slideId: id, order };
}

// DUPLICATE. The source's meta, then `buildInserted` — the SAME cloner ⌘D and paste use — over
// the slide's whole root forest, so nested groups keep their shape and every descendant is
// re-stamped with the new slide id in one pass.
//
// The copy keeps the source's name VERBATIM: no "Copy" suffix. A slide name here is an
// organizational label (the filmstrip numbers slides; it does not need unique names), Google
// Slides does not rename a duplicate either, and a suffix would copy a growing string into
// `addedSlides` every time a duplicate is duplicated.
function buildDuplicatedSlide(scene, rawBag, ctx) {
  const bag = opBag(rawBag);
  if (slideAddRefusal(scene, bag) || slideStaleRefusal(scene, bag)) return null;
  const src = (ctx.slides || []).find((slide) => slide && slide.id === ctx.slideId);
  if (!src) return null;
  const id = idReserver(scene, bag, ctx)("slide");
  const meta = { id };
  // Only the fields the source actually asserts, so a bare slide duplicates to a bare record.
  for (const key of EDITABLE_DIVE_SLIDE_PATCH_KEYS) {
    if (!slideFieldEq(key, src[key], undefined)) meta[key] = src[key];
  }
  let next = { ...bag, addedSlides: [...(bag.addedSlides || []), meta] };
  const trees = slideTrees(ctx.elements);
  if (trees.length) {
    // `leafOrder: []` is deliberate: the clones are the only leaves in the order being numbered,
    // so buildInserted emits no `z` patch against the SOURCE — duplicating a slide must not
    // renumber the slide it was copied from. `elements` is still passed, because that is the map
    // buildInserted resolves a root's parent through, and a whole-slide root has none.
    const inserted = buildInserted(scene, next, {
      deckAll: ctx.deckAll, slides: ctx.slides, elements: ctx.elements,
      leafOrder: [], zOffset: ctx.zOffset, slideId: id, isDeck: true,
    }, trees, 0, 0);
    if (inserted) next = inserted.bag;
  }
  const order = orderWithInsert(slideIdsOf(ctx.slides), id, ctx.slideId);
  return { bag: withSlideOrder(scene, next, order), slideId: id, order };
}

// DELETE. A bag-added slide is UNMADE — dropped from `addedSlides` together with its element
// additions — rather than paired with a `deletedSlides` tombstone. The pair is not merely more
// expensive: it does not VALIDATE, because those additions' `slide` would no longer name a live
// slide (spec O3/O4). Unmaking it returns the bag to the CANONICAL form of what it was before the
// slide existed — canonical, not byte-identical: an optional key the incoming bag carried EMPTY
// (`addedSlides: []`, `slidePatch: {}`) is deleted rather than restored, so the bag can come back
// 17 bytes SMALLER than it went in. That is the better answer — an empty key is bytes that say
// nothing — and it is deliberate.
//
// A base slide gets the tombstone, and the elements whose BASE slide it is are deliberately NOT
// listed in `deleted`: mergeScene and validateBakeInput both drop a dead slide's elements
// implicitly, so naming them would cost bytes for nothing. What DOES have to go is every bag
// entry pointing at the slide — its `slidePatch`, and the patch / tombstone / addition of each
// element on it. A leftover patch offering `slide: "<dead>"` is an INVALID_OVERRIDES at the next
// Save, not just waste.
function buildDeletedSlide(scene, rawBag, slides, slideId) {
  const bag = opBag(rawBag);
  const ids = slideIdsOf(slides);
  const at = ids.indexOf(slideId);
  if (at < 0 || slideDeleteRefusal(slides, slideId) || slideStaleRefusal(scene, bag)) return null;
  const next = { ...bag };
  if ((bag.addedSlides || []).some((slide) => slide && slide.id === slideId)) {
    const kept = bag.addedSlides.filter((slide) => !(slide && slide.id === slideId));
    if (kept.length) next.addedSlides = kept; else delete next.addedSlides;
  } else {
    next.deletedSlides = [...(bag.deletedSlides || []), slideId];
  }
  if (bag.slidePatch && Object.hasOwn(bag.slidePatch, slideId)) {
    const slidePatch = { ...bag.slidePatch };
    delete slidePatch[slideId];
    if (Object.keys(slidePatch).length) next.slidePatch = slidePatch; else delete next.slidePatch;
  }
  // Membership is the PATCHED slide (spec O6) — WYSIWYG: what the author can SEE on this slide
  // dies with it, and an element they had already moved OFF it survives, because mergeScene
  // applies patches above the slide filter.
  //
  // Three shapes, and they need three answers:
  //   • a bag ADDITION on the slide is unmade — dropped from `added` outright;
  //   • a base element whose BASE slide is this one needs nothing beyond dropping its bag
  //     entries: the core's implicit cascade removes it, so a tombstone would be pure bytes;
  //   • a base element that is only here because a patch MOVED it here needs an explicit
  //     TOMBSTONE. Dropping just its patch would teleport it back to its base slide — the author
  //     deleted a slide and an element they had moved away from reappeared somewhere else. It is
  //     a base id, so `deleted` accepts it, and an id already tombstoned stays tombstoned rather
  //     than being resurrected by the pruning pass.
  // The patch itself goes in every case: the element is gone, so its `x`/`text`/`slide` edits
  // have nothing left to describe. Undo restores the whole previous bag, so nothing here is lost
  // to the author — only to this bag.
  const doomed = new Set();
  const tombstones = new Set();
  const baseIds = new Set(scene.elements.map((el) => el.id));
  for (const el of [...scene.elements, ...bag.added]) {
    if (slideOfEl(el, bag) !== slideId) continue;
    doomed.add(el.id);
    if (el.slide !== slideId && baseIds.has(el.id)) tombstones.add(el.id);
  }
  next.added = bag.added.filter((el) => !doomed.has(el.id));
  next.deleted = [...new Set([...bag.deleted.filter((id) => !doomed.has(id)), ...tombstones])];
  next.patch = {};
  for (const id of Object.keys(bag.patch)) if (!doomed.has(id)) next.patch[id] = bag.patch[id];
  const order = ids.filter((id) => id !== slideId);
  // Next slide, else previous: the cursor closes up under the deletion like a text caret.
  return { bag: withSlideOrder(scene, next, order), slideId: order[Math.min(at, order.length - 1)], order };
}

// HIDE/SHOW, RENAME, BACKGROUND and NOTES — one function, because each is a single shallow slide
// field. An ADDED slide is edited in place (its
// record already lives in the bag, like an added element in `buildPatched`); a base slide gets a
// `slidePatch` entry pruned against the baked record, so a value toggled and untoggled leaves NO
// trace — the canonical form of an unedited bag, which is the same 17-byte qualification the
// delete op's comment spells out: an empty `slidePatch` the bag arrived with is deleted, not put
// back. `slideFieldEq` treats an absent field as the default, so `hidden: false` and a cleared
// name prune away too.
//
// All four fields now have a reader AND a writer: `name` in the rail's caption and inline rename,
// `background` on the page sheet with a colour field in the inspector's Slide section, `hidden`
// in the rail's glyph, the canvas dim, and the presentable-slide walk both present mode and the
// present mode navigates by, and `notes` in the strip under the canvas (and nowhere else — there
// is no presenter view). So a value written here is a value something shows.
function buildSlidePatched(scene, rawBag, slideId, partial) {
  const bag = opBag(rawBag);
  if (slideStaleRefusal(scene, bag)) return null;
  if (((bag && bag.deletedSlides) || []).includes(slideId)) return null;
  const at = (bag.addedSlides || []).findIndex((slide) => slide && slide.id === slideId);
  if (at >= 0) {
    const merged = { ...bag.addedSlides[at], ...partial };
    const rec = { id: slideId };
    for (const key of EDITABLE_DIVE_SLIDE_PATCH_KEYS) {
      if (!slideFieldEq(key, merged[key], undefined)) rec[key] = merged[key];
    }
    return { ...bag, addedSlides: bag.addedSlides.map((slide, i) => (i === at ? rec : slide)) };
  }
  const base = ((scene && scene.slides) || []).find((slide) => slide && slide.id === slideId);
  if (!base) return null;
  const merged = { ...((bag.slidePatch || {})[slideId] || {}), ...partial };
  const nextP = {};
  for (const key of EDITABLE_DIVE_SLIDE_PATCH_KEYS) {
    if (!Object.hasOwn(merged, key)) continue;
    if (!slideFieldEq(key, merged[key], base[key])) nextP[key] = merged[key];
  }
  const slidePatch = { ...(bag.slidePatch || {}) };
  if (Object.keys(nextP).length) slidePatch[slideId] = nextP; else delete slidePatch[slideId];
  const next = { ...bag };
  if (Object.keys(slidePatch).length) next.slidePatch = slidePatch; else delete next.slidePatch;
  return next;
}

// REORDER. One slide to an arbitrary index in the RESULTING deck, written as the whole
// permutation — the op the filmstrip's drag-to-reorder lands on. A no-op returns null rather than
// burning an undo step on nothing.
function buildReorderedSlides(scene, rawBag, slides, slideId, toIndex) {
  const bag = opBag(rawBag);
  if (slideStaleRefusal(scene, bag)) return null;
  const ids = slideIdsOf(slides);
  const from = ids.indexOf(slideId);
  if (from < 0 || !Number.isFinite(toIndex)) return null;
  const rest = ids.filter((id) => id !== slideId);
  const at = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
  if (at === from) return null;
  const order = [...rest.slice(0, at), slideId, ...rest.slice(at)];
  return { bag: withSlideOrder(scene, bag, order), slideId, order };
}

// ── Align / distribute (pure) ───────────────────────────────────────────────
// Both operate on the selection ROOTS' derived rects, so a group moves as ONE unit, and both
// express the result as a per-root DELTA that is written to that root's LEAVES — the only
// place x/y live, which keeps the URL overrides per-element.
// `getRect(id)` -> {x,y,w,h} (rectOf: union for a group), `getLeaves(id)` -> leaf ids.
function rootDeltaEntries(roots, deltas, getRect, getLeaves, axis) {
  const entries = [];
  roots.forEach((id, i) => {
    const d = deltas[i];
    if (!d) return;
    for (const leaf of getLeaves(id)) {
      const lr = getRect(leaf);
      if (!lr) continue;
      entries.push({ id: leaf, partial: axis === "x" ? { x: R(lr.x + d) } : { y: R(lr.y + d) } });
    }
  });
  return entries;
}

function alignEntries(roots, edge, getRect, getLeaves) {
  const items = roots.map((id) => ({ id, r: getRect(id) })).filter((o) => o.r);
  if (items.length < 2) return [];
  const horiz = edge === "left" || edge === "centerX" || edge === "right";
  const lo = Math.min(...items.map((o) => (horiz ? o.r.x : o.r.y)));
  const hi = Math.max(...items.map((o) => (horiz ? o.r.x + o.r.w : o.r.y + o.r.h)));
  const at = (r) => {
    if (edge === "left" || edge === "top") return lo;
    if (edge === "right" || edge === "bottom") return hi - (horiz ? r.w : r.h);
    return (lo + hi) / 2 - (horiz ? r.w : r.h) / 2;
  };
  const ids = items.map((o) => o.id);
  const deltas = items.map((o) => at(o.r) - (horiz ? o.r.x : o.r.y));
  return rootDeltaEntries(ids, deltas, getRect, getLeaves, horiz ? "x" : "y");
}

// Equalize the GAPS between roots along one axis: the outermost two stay put, the rest are
// re-spaced. Needs ≥3 roots to mean anything.
function distributeEntries(roots, axis, getRect, getLeaves) {
  const items = roots.map((id) => ({ id, r: getRect(id) })).filter((o) => o.r);
  if (items.length < 3) return [];
  const horiz = axis === "h";
  const p = (r) => (horiz ? r.x : r.y);
  const s = (r) => (horiz ? r.w : r.h);
  items.sort((a, b) => p(a.r) - p(b.r) || s(a.r) - s(b.r));
  const first = items[0].r, last = items[items.length - 1].r;
  const span = (p(last) + s(last)) - p(first);
  const sum = items.reduce((m, o) => m + s(o.r), 0);
  const gap = (span - sum) / (items.length - 1);
  const deltas = [];
  let cur = p(first);
  items.forEach((o, i) => {
    if (i === 0 || i === items.length - 1) deltas.push(0);
    else deltas.push(cur - p(o.r));
    cur += s(o.r) + gap;
  });
  return rootDeltaEntries(items.map((o) => o.id), deltas, getRect, getLeaves, horiz ? "x" : "y");
}

// ── Grouping (pure) ─────────────────────────────────────────────────────────
// Where a newly formed group's leaf BLOCK lands in the global leaf order.
//   ascIds  — the current leaf order, z ascending
//   members — the leaves moving into the new group
//   chainOf(leafId) — that leaf's ancestor GROUP ids, innermost first
//   openable — group ids allowed to span the insertion point (the new group's own ancestors)
// The block ends where the topmost member sat, so the new group keeps the selection's paint
// position.
function groupBlockOrder(ascIds, members, chainOf, openable) {
  const idx = new Map(ascIds.map((id, i) => [id, i]));
  let topIdx = -1;
  for (const id of members) { const i = idx.get(id); if (i != null && i > topIdx) topIdx = i; }
  const block = ascIds.filter((id) => members.has(id));
  const rest = ascIds.filter((id) => !members.has(id));
  let at = rest.filter((id) => idx.get(id) < topIdx).length;
  // INVARIANT: a group's leaves occupy one unbroken run of the global order — every z command
  // relies on it. Once the members are pulled out, the slot they vacated can sit INSIDE the
  // block of a group they are leaving, so dropping the new block there would interleave the two
  // groups. Slide forward to the first seam spanned only by the new group's own ancestors.
  const open = new Set(openable || []);
  while (at > 0 && at < rest.length) {
    const before = chainOf(rest[at - 1]), after = chainOf(rest[at]);
    if (!before.some((g) => after.indexOf(g) >= 0 && !open.has(g))) break;
    at++;
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

function resizeRect(start, hd, dx, dy, aspect) {
  let nx = start.x, ny = start.y, nw = start.w, nh = start.h;
  if (hd.ax === 1) nw = start.w + dx;
  if (hd.ax === -1) { nw = start.w - dx; nx = start.x + dx; }
  if (hd.ay === 1) nh = start.h + dy;
  if (hd.ay === -1) { nh = start.h - dy; ny = start.y + dy; }
  if (aspect && hd.ax !== 0 && hd.ay !== 0 && start.w > 0 && start.h > 0) {
    const sw = nw / start.w, sh = nh / start.h;
    // Under aspect the 8px floor applies to the SCALE, not to each side: clamping w and h
    // independently below would square off the short side and destroy the very ratio the
    // shift-drag exists to hold (and a drag past the anchor makes the raw scale negative).
    const minS = Math.max(8 / start.w, 8 / start.h);
    const s = Math.max(minS, Math.abs(sw - 1) >= Math.abs(sh - 1) ? sw : sh);
    nw = start.w * s; nh = start.h * s;
    if (hd.ax === -1) nx = start.x + (start.w - nw);
    if (hd.ay === -1) ny = start.y + (start.h - nh);
  }
  if (nw < 8) { if (hd.ax === -1) nx = start.x + start.w - 8; nw = 8; }
  if (nh < 8) { if (hd.ay === -1) ny = start.y + start.h - 8; nh = 8; }
  return { x: R(nx), y: R(ny), w: R(nw), h: R(nh) };
}

function snapCandidates(elements, excludeIds, page, getH) {
  const xs = [0, R(page.width / 2), page.width];
  const ys = [0, R(page.height / 2), page.height];
  for (const el of elements) {
    if (excludeIds.has(el.id)) continue;
    const h = getH(el);
    xs.push(el.x, R(el.x + el.w / 2), el.x + el.w);
    ys.push(el.y, R(el.y + h / 2), el.y + h);
  }
  return { xs, ys };
}
function snapAxis(edges, cands) {
  let best = null;
  for (const e of edges) for (const c of cands) {
    const d = c - e;
    if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, line: c };
  }
  return best;
}
function snapRect(rect, cands) {
  const bx = snapAxis([rect.x, rect.x + rect.w / 2, rect.x + rect.w], cands.xs);
  const by = snapAxis([rect.y, rect.y + rect.h / 2, rect.y + rect.h], cands.ys);
  return {
    x: bx ? R(rect.x + bx.d) : rect.x,
    y: by ? R(rect.y + by.d) : rect.y,
    guides: { x: bx ? [bx.line] : [], y: by ? [by.line] : [] },
  };
}

const FMT = {
  number: (v) => N(v).toLocaleString("en-US"),
  compact: (v) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(N(v)),
  percent: (v) => (N(v) * 100).toFixed(0) + "%",
};
const fmtOf = (key) => (key && FMT[key]) || undefined;

// ── Shared text styling ─────────────────────────────────────────────────────
// A TextStyle is a SPARSE bag used by EVERY text surface (text elements, chart title, axis
// labels, axis ticks):
//   { fontSize?, bold?, italic?, underline?, align?, color?, highlight? }
// An absent key means "use this surface's default"; `highlight: null` means "no highlight".
// The resolver turns one into the concrete style a renderer needs.
function resolveTextStyle(ts, defaults) {
  const t = ts || {};
  const d = defaults || {};
  return {
    fontSize: t.fontSize != null ? t.fontSize : d.fontSize,
    fontWeight: t.bold != null ? (t.bold ? 700 : 400) : d.fontWeight,
    fontStyle: t.italic ? "italic" : "normal",
    textDecoration: t.underline ? "underline" : "none",
    textAlign: t.align || d.align,
    color: t.color || d.color,
    background: t.highlight || null,
  };
}

// SVG <text> has no background, so a highlight there is a <rect> drawn behind the glyphs,
// sized from APPROXIMATE metrics: width = chars × fontSize × 0.62, height = fontSize × 1.35,
// top edge at baseline − 1.05 × fontSize. Real advance widths vary by roughly ±10% with the
// string, so a band can run slightly wide or narrow; measuring exactly would cost a layout
// pass per tick. HTML surfaces (text elements, chart title) use a real CSS background.
const HL_CHAR_W = 0.62, HL_LINE_H = 1.35, HL_ASCENT = 1.05;
function highlightBox(text, fontSize, textAnchor, baselineDy) {
  const w = String(text == null ? "" : text).length * fontSize * HL_CHAR_W;
  return {
    x: textAnchor === "middle" ? -w / 2 : textAnchor === "end" ? -w : 0,
    y: baselineDy - fontSize * HL_ASCENT,
    w,
    h: fontSize * HL_LINE_H,
  };
}
// Recharts' <Text> pushes the first line off the anchor point by capHeight (0.71em) for
// verticalAnchor "start" and by half of it for "middle"; hand-rolled SVG text must match.
const baselineDyOf = (verticalAnchor, fontSize) =>
  (verticalAnchor === "start" ? 0.71 : verticalAnchor === "middle" ? 0.355 : 0) * fontSize;

// Custom axis tick — mounted ONLY when chart.text.ticks is set, so charts without a tick
// style keep the plain-object tick path and render exactly as before. Recharts clones the
// element with x/y/payload/textAnchor/verticalAnchor/tickFormatter/index; it also overwrites
// `angle` and `textAnchor`, so the angled-tick behaviour rides in as tsAngle/tsAnchor.
function StyledTick(props) {
  const { x, y, payload, textAnchor, verticalAnchor, tickFormatter, index, ts, tsAngle, tsAnchor } = props;
  const t = ts || {};
  const fs = t.fontSize != null ? t.fontSize : CHART_TEXT_DEFAULTS.ticks.fontSize;
  const raw = payload ? payload.value : "";
  const label = typeof tickFormatter === "function" ? tickFormatter(raw, index) : raw;
  const anchor = tsAnchor || textAnchor || "middle";
  const dy = baselineDyOf(verticalAnchor || "start", fs);
  const box = t.highlight ? highlightBox(label, fs, anchor, dy) : null;
  return (
    <g transform={tsAngle ? `rotate(${tsAngle}, ${x}, ${y})` : undefined}>
      {box ? <rect x={x + box.x} y={y + box.y} width={box.w} height={box.h} fill={t.highlight} /> : null}
      <text x={x} y={y + dy} textAnchor={anchor} fontSize={fs}
        fill={t.color || CHART_TEXT_DEFAULTS.ticks.color}
        fontWeight={t.bold != null ? (t.bold ? 700 : 400) : undefined}
        fontStyle={t.italic ? "italic" : undefined}
        textDecoration={t.underline ? "underline" : undefined}>
        {String(label)}
      </text>
    </g>
  );
}

// Custom axis LABEL — mounted ONLY when the label style carries a highlight; every other
// label style rides the plain label object so Recharts keeps owning the geometry. Recharts
// hands a custom `content` the raw viewBox and skips its own positioning, so the two
// positions this template uses are reproduced here as getCartesianPosition computes them.
function StyledAxisLabel(props) {
  const vb = props.viewBox || {};
  const x0 = N(vb.x), y0 = N(vb.y), w0 = N(vb.width), h0 = N(vb.height);
  const off = props.offset != null ? props.offset : 5;
  let tx, ty, anchor, va;
  if (props.position === "insideLeft") { tx = x0 + off; ty = y0 + h0 / 2; anchor = "start"; va = "middle"; }
  else if (props.position === "insideBottom") { tx = x0 + w0 / 2; ty = y0 + h0 - off; anchor = "middle"; va = "end"; }
  else { tx = x0 + w0 / 2; ty = y0 + h0 / 2; anchor = "middle"; va = "middle"; }
  const fs = props.fontSize != null ? props.fontSize : CHART_TEXT_DEFAULTS.labels.fontSize;
  const dy = baselineDyOf(va, fs);
  const box = props.highlight ? highlightBox(props.value, fs, anchor, dy) : null;
  return (
    <g transform={props.angle ? `rotate(${props.angle}, ${tx}, ${ty})` : undefined}>
      {box ? <rect x={tx + box.x} y={ty + box.y} width={box.w} height={box.h} fill={props.highlight} /> : null}
      <text x={tx} y={ty + dy} textAnchor={anchor} fontSize={fs} fill={props.fill}
        fontWeight={props.fontWeight} fontStyle={props.fontStyle} textDecoration={props.textDecoration}>
        {props.value}
      </text>
    </g>
  );
}

// ── DynamicChart: config-driven Recharts (all 9 types via one ComposedChart) ─
function DynamicChart({ rows, config }) {
  const c = config || {};
  const kind = c.kind || "bar";
  const stacked = !!c.stacked && kind !== "scatter";
  const horizontal = kind === "barH";
  const st = c.style || {};
  const series = Array.isArray(c.series) ? c.series : [];
  const cx = c.x || {};
  const cy = c.y || {};
  const grid = c.grid || { show: true, dash: "3 3" };
  const legend = c.legend || { show: series.length > 1, position: "top" };
  const tooltip = c.tooltip || { show: true };
  const xNumeric = cx.type === "number" || cx.type === "time";
  const xFmt = fmtOf(cx.tickFormat);
  const yFmt = fmtOf(cy.tickFormat);
  const yDomain = cy.domain === "zero" ? [0, "auto"] : ["auto", "auto"];
  const lineType = st.lineType || "linear";
  const margin = { top: 8, right: 16, bottom: 4, left: 4 };

  const data = useMemo(() => {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const o = { ...r };
      for (const s of series) if (s.key in o) o[s.key] = numOrNull(o[s.key]);
      if (xNumeric && cx.key in o) o[cx.key] = numOrNull(o[cx.key]);
      // Category x must be a primitive: DuckDB DATE/STRUCT objects blank-screen JSX.
      else if (cx.key in o && o[cx.key] != null && typeof o[cx.key] === "object") o[cx.key] = String(o[cx.key]);
      if (kind === "scatter" && c.scatter && c.scatter.sizeKey && c.scatter.sizeKey in o) {
        o[c.scatter.sizeKey] = numOrNull(o[c.scatter.sizeKey]);
      }
      return o;
    });
  }, [rows, config]);

  if (!series.length || !cx.key) {
    return <ChartNote text="Chart needs an x column and at least one series" />;
  }
  if (!data.length) return <ChartNote text="No data" />;
  if (missingChartColumns(c, Object.keys(data[0] || {})).length) {
    return <ChartNote text="Chart needs an x column and at least one series" />;
  }

  // Optional shared text styling for the chart's own type. Absent => the exact pre-existing
  // plain-object label/tick props, so an unstyled chart is untouched.
  const labelsTS = (c.text && c.text.labels) || null;
  const ticksTS = (c.text && c.text.ticks) || null;
  const labelRS = resolveTextStyle(labelsTS, CHART_TEXT_DEFAULTS.labels);
  const labelStyleProps = labelsTS
    ? {
      fontSize: labelRS.fontSize, fill: labelRS.color, fontWeight: labelRS.fontWeight,
      fontStyle: labelRS.fontStyle, textDecoration: labelRS.textDecoration,
      ...(labelsTS.highlight ? { content: StyledAxisLabel, highlight: labelsTS.highlight } : {}),
    }
    : { fontSize: 11, fill: "#6a6a6a" };
  const xLabelProps = cx.label ? { value: cx.label, position: "insideBottom", offset: -2, ...labelStyleProps } : undefined;
  const yLabelProps = cy.label ? { value: cy.label, angle: -90, position: "insideLeft", ...labelStyleProps } : undefined;
  const tickAngle = cx.tickAngle || 0;
  const tickStyle = { fontSize: 11, fill: "#6a6a6a" };
  const tickFor = (angle, anchor) => (ticksTS
    ? <StyledTick ts={ticksTS} tsAngle={angle || 0} tsAnchor={anchor} />
    : (angle ? { ...tickStyle, angle, textAnchor: anchor } : tickStyle));
  const plainTick = tickFor(0);

  let xAxis, yAxis;
  if (horizontal) {
    // Explicit category-axis width: Recharts' width="auto" under-measures long labels
    // (~87% of true width) and clips them. 6.8px/char at 11px font, bounded 60..240.
    const maxLabelLen = data.reduce((m, r) => Math.max(m, String(r[cx.key] == null ? "" : r[cx.key]).length), 0);
    const tickFS = ticksTS && ticksTS.fontSize != null ? ticksTS.fontSize : 11;
    const catW = Math.max(60, Math.min(240, 14 + maxLabelLen * 6.8 * (tickFS / 11)));
    xAxis = <XAxis type="number" tickFormatter={yFmt} tick={plainTick} domain={yDomain} label={yLabelProps ? { ...yLabelProps, angle: 0, position: "insideBottom", offset: -2 } : undefined} />;
    yAxis = <YAxis type="category" dataKey={cx.key} width={catW} tick={plainTick} tickFormatter={xFmt} label={xLabelProps ? { ...xLabelProps, angle: -90, position: "insideLeft", offset: 0 } : undefined} />;
  } else if (kind === "scatter") {
    xAxis = <XAxis type="number" dataKey="__x" name={cx.label || cx.key} tickFormatter={xFmt} tick={plainTick} domain={["auto", "auto"]} label={xLabelProps} />;
    yAxis = <YAxis type="number" dataKey="__y" name={cy.label || (series[0] && series[0].key)} tickFormatter={yFmt} tick={plainTick} domain={yDomain} label={yLabelProps} />;
  } else {
    xAxis = (
      <XAxis type={xNumeric ? "number" : "category"} dataKey={cx.key} tickFormatter={xFmt} tick={tickAngle ? tickFor(tickAngle, "end") : plainTick}
        height={tickAngle ? 56 : undefined} interval={xNumeric ? undefined : "preserveStartEnd"} domain={xNumeric ? ["auto", "auto"] : undefined} label={xLabelProps} />
    );
    yAxis = <YAxis type="number" domain={yDomain} tickFormatter={yFmt} tick={plainTick} label={yLabelProps} />;
  }

  const barRadius = (r) => (r ? (horizontal ? [0, r, r, 0] : [r, r, 0, 0]) : 0);

  const seriesEls = series.map((s, i) => {
    const color = s.color || PALETTE[i % PALETTE.length];
    const name = s.label || s.key;
    if (kind === "bar" || kind === "barH") {
      return <Bar key={s.key} dataKey={s.key} name={name} fill={color} stackId={stacked ? "a" : undefined}
        radius={stacked ? 0 : barRadius(st.radius)} barSize={st.barSize || undefined} maxBarSize={64} isAnimationActive={false} />;
    }
    if (kind === "area" || (kind === "line" && stacked)) {
      const isLine = kind === "line";
      return <Area key={s.key} type={lineType} dataKey={s.key} name={name} stroke={color}
        strokeWidth={st.strokeWidth != null ? st.strokeWidth : 2} dot={!!st.dot}
        fill={isLine ? "transparent" : color} fillOpacity={isLine ? 0 : (st.fillOpacity != null ? st.fillOpacity : 0.25)}
        stackId={stacked ? "a" : undefined} legendType={isLine ? "line" : undefined}
        connectNulls={!!c.connectNulls} isAnimationActive={false} />;
    }
    if (kind === "line") {
      return <Line key={s.key} type={lineType} dataKey={s.key} name={name} stroke={color}
        strokeWidth={st.strokeWidth != null ? st.strokeWidth : 2} dot={!!st.dot}
        connectNulls={!!c.connectNulls} isAnimationActive={false} />;
    }
    if (kind === "scatter") {
      const pts = data
        .map((r) => ({ __x: numOrNull(r[cx.key]), __y: numOrNull(r[s.key]), __z: c.scatter && c.scatter.sizeKey ? N(r[c.scatter.sizeKey]) : 1, __row: r }))
        .filter((p) => p.__x != null && p.__y != null);
      return <Scatter key={s.key} name={name} data={pts} fill={color} isAnimationActive={false} />;
    }
    return null;
  });

  return (
    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 300 }}>
      <ComposedChart data={kind === "scatter" ? undefined : data} layout={horizontal ? "vertical" : "horizontal"}
        stackOffset={stacked && c.stackOffset && c.stackOffset !== "none" ? c.stackOffset : undefined} margin={margin}>
        {grid.show !== false && <CartesianGrid strokeDasharray={grid.dash || "3 3"} stroke="#e4e4e4" />}
        {xAxis}
        {yAxis}
        {kind === "scatter" && c.scatter && c.scatter.sizeKey ? <ZAxis dataKey="__z" range={[40, 400]} /> : null}
        {tooltip.show !== false && <Tooltip formatter={yFmt} cursor={kind === "scatter" ? { strokeDasharray: "3 3" } : undefined}
          contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e4e4e4" }} />}
        {legend.show && <Legend verticalAlign={legend.position === "bottom" ? "bottom" : "top"} iconSize={10} wrapperStyle={{ fontSize: 11 }} />}
        {seriesEls}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function ChartNote({ text }) {
  return (
    <div className="flex items-center justify-center" style={{ width: "100%", height: "100%", color: "#9aa1aa", fontSize: 12 }}>
      {text}
    </div>
  );
}

// ── Element content renderers ───────────────────────────────────────────────
// Text elements keep their style as FLAT props (fontSize/color/align/weight/italic/underline/
// highlight) but resolve through the same shared resolver as every other text surface. The
// numeric `weight` ladder wins over the resolver's boolean bold, which text elements don't use.
//
// `scale` is autofit's only effect on rendering: it multiplies the resolved font size and nothing
// else, because everything else governing the block's height is already relative to it — `lineHeight`
// is a unitless ratio, and `letterSpacing`, the list indent and the marker column are all in em for
// exactly this reason. One number scales the whole block; there is no second place to forget.
function textStyleOf(el, scale) {
  const lv = LEVEL_STYLES[el.level] || LEVEL_STYLES.p;
  const rs = resolveTextStyle(
    { fontSize: el.fontSize, italic: el.italic, underline: el.underline, align: el.align, color: el.color, highlight: el.highlight },
    { fontSize: lv.size, fontWeight: lv.weight, color: "#231f20", align: "left" },
  );
  const fit = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    ...rs,
    fontSize: rs.fontSize * fit,
    fontWeight: el.weight != null ? el.weight : lv.weight,
    lineHeight: el.lineHeight != null ? el.lineHeight : lv.lh,
    letterSpacing: lv.ls,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    tabSize: LIST_TAB_SIZE,
    margin: 0,
    fontFamily: el.level === "code" ? CODE_FONT : T.font,
    ...(el.level === "code" ? { paddingRight: CODE_COPY_PAD } : null),
  };
}

// `innerText` needs layout: on a DETACHED node it degrades to textContent, which drops the
// newlines that <br>/block boundaries represent. React can unmount a contentEditable before blur
// fires (clicking another element), so callers read the text while the node is still connected
// and keep the last value; the unmount path then commits that instead of reading a dead node.
// Shared by the text element and by table cells so both behave identically.
function readEditableText(node) {
  if (!node) return null;
  if (node.isConnected) return node.innerText;
  // Detached fallback: serialize newlines ourselves rather than losing them.
  let out = "";
  const walk = (n) => {
    for (const child of n.childNodes) {
      if (child.nodeType === 3) out += child.data;
      else if (child.nodeName === "BR") out += "\n";
      else {
        const block = child.nodeType === 1 && getComputedStyle(child).display !== "inline";
        if (block && out && !out.endsWith("\n")) out += "\n";
        walk(child);
      }
    }
  };
  walk(node);
  return out;
}

// The text AND the selection in ONE walk, because the offsets must be in the SAME coordinates as the
// string: `Range.toString()` is textContent-shaped and drops the newlines a <br> or block boundary
// stands for, so a caret measured that way lands a line off in a box that has seen an Enter. Marking
// during the serialization makes them agree, on readEditableText's own rules.
function editableSnapshot(root) {
  if (!root) return null;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  // A selection that is absent, or anchored outside this box, is NOT an error: Tab can arrive while
  // the caret is nowhere useful. `inside` false means no offset is ever marked, and the fallbacks at
  // the bottom put both ends at the end of the string — an indent of the last line, which is the
  // least surprising thing a keypress with no caret can do.
  const inside = range && root.contains(range.startContainer) && root.contains(range.endContainer);
  let out = "";
  let start = -1;
  let end = -1;
  // A caret sits inside a text node (offset = characters) or BETWEEN an element's children (offset =
  // child index); both need marking, or an empty line loses the caret.
  const mark = (node, offset, at) => {
    if (!inside) return;
    if (start < 0 && range.startContainer === node && range.startOffset === offset) start = at;
    if (range.endContainer === node && range.endOffset === offset) end = at;
  };
  const walk = (node) => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i += 1) {
      mark(node, i, out.length);
      const child = kids[i];
      if (child.nodeType === 3) {
        if (inside && range.startContainer === child && start < 0) start = out.length + Math.min(range.startOffset, child.data.length);
        if (inside && range.endContainer === child) end = out.length + Math.min(range.endOffset, child.data.length);
        out += child.data;
      } else if (child.nodeName === "BR") {
        out += "\n";
      } else {
        const block = child.nodeType === 1 && getComputedStyle(child).display !== "inline";
        if (block && out && !out.endsWith("\n")) out += "\n";
        walk(child);
      }
    }
    mark(node, kids.length, out.length);
  };
  walk(root);
  const at = out.length;
  return { text: out, start: start < 0 ? at : start, end: end < 0 ? (start < 0 ? at : start) : end };
}

// Write a whole string back and put the caret back, in flat text offsets. The string becomes ONE text
// node — `pre-wrap` renders its newlines (it is how the box is seeded) and collapsing the tree keeps
// the offsets above meaningful afterwards.
function writeEditableText(root, text, start, end) {
  root.textContent = text;
  const node = root.firstChild;
  if (!node) return;   // an empty box has nowhere to put a caret, and is already focused
  try {
    const range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(node.length, start)));
    range.setEnd(node, Math.max(0, Math.min(node.length, end)));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* selection is best-effort, as the seed path also treats it */ }
}

// ── Autofit: one measurement pass, no feedback ──────────────────────────────
// TERMINATION. No loop over renders, and no measurement whose result can change its own input. The
// PROBE renders one hidden copy of the text per AUTOFIT_LADDER step, all at the box's WIDTH with no
// height constraint; one layout effect reads every height; `autofitPick` scans that fixed-length
// array for the first that fits.
//
// What is measured — how tall this text is at each of N fixed sizes — depends on the text, the style
// and the WIDTH, never on the chosen step and never on the box HEIGHT. So applying the answer cannot
// invalidate the measurement, and a resize re-picks from numbers already in hand. Both ways such a
// loop fights itself are absent by construction: the applied size cannot change the measured size
// (every step is measured, not just the chosen one), and the height constraint cannot change the
// wrap (there is no height constraint on the probe).
//
// NO THRASH WHILE TYPING. The key is built from `el.text`, the COMMITTED string, so a keystroke
// leaves it identical and the scale frozen. Thirty-six keystrokes mount zero probes.
//
// EVERY SURFACE AGREES. The probe measures LOGICAL pixels, before any `transform: scale(…)`, so the
// rail's 0.07 thumbnail and the canvas at 400% ask the same question — and the module-level cache
// then hands every surface the same answer array rather than four independent ones.
const AUTOFIT_CACHE = new Map();
// Bounded, cleared wholesale rather than evicted one at a time: a width drag mints a key per pixel
// crossed, so the cap is all that stands between a resize and a map that grows for the session.
const AUTOFIT_CACHE_MAX = 400;
function autofitCached(key) {
  return key && AUTOFIT_CACHE.has(key) ? AUTOFIT_CACHE.get(key) : null;
}
function autofitStore(key, heights) {
  if (!key) return;
  if (AUTOFIT_CACHE.size >= AUTOFIT_CACHE_MAX) AUTOFIT_CACHE.clear();
  AUTOFIT_CACHE.set(key, heights);
}

function AutofitProbe({ el, width, nodeRef }) {
  return (
    // The copies sit in NORMAL FLOW at the box's width, so each one's `offsetHeight` is its own; the
    // container is zero-height and clipped, so none of it reaches the real layout. `visibility:
    // hidden` and NOT `display: none`, which has no layout to measure.
    // The ladder LENGTH rides in the attribute so a browser pass can assert the probe drew every
    // step: a probe that rendered fewer copies than the ladder has steps would still pick an index
    // and still look right, which is the one failure a screenshot cannot show.
    <div ref={nodeRef} aria-hidden="true" data-autofit-probe={AUTOFIT_LADDER.length} style={{
      position: "absolute", left: 0, top: 0, width, height: 0,
      overflow: "hidden", visibility: "hidden", pointerEvents: "none", zIndex: -1,
    }}>
      {AUTOFIT_LADDER.map((step, i) => <TextBody key={i} el={el} scale={step} />)}
    </div>
  );
}

// `report` is how the INSPECTOR learns what happened, the shape charts already use for their
// columns. Only the canvas passes it; nothing else has an inspector to explain a shrink to.
function useAutofit(el, boxW, boxH, report) {
  const on = autofitOn(el);
  const key = on ? autofitGen(el, boxW) : "";
  const [resolved, setResolved] = useState(null);
  const probeRef = useRef(null);
  // Read during RENDER, so a key another surface already measured costs no extra render and no
  // probe. State is a keyed local copy, so the previous key's array can never be applied to this.
  const heights = resolved && resolved.key === key ? resolved.heights : autofitCached(key);
  useLayoutEffect(() => {
    if (!key || heights) return;
    const node = probeRef.current;
    if (!node) return;
    const measured = [];
    for (const child of node.children) measured.push(child.offsetHeight);
    autofitStore(key, measured);
    setResolved({ key, heights: measured });
  }, [key, heights]);
  // Two different "no answer yet" values, deliberately. `index` is what to DRAW, so before any
  // measurement it is 0 — full size, never a guessed shrink. `reported` is what the inspector is
  // TOLD, and there null means "still measuring" (autofitReadout says so) while for a box that does
  // not autofit at all it means "forget this element" (fitMapPatch deletes the entry). Collapsing
  // the two would either make the readout claim a size it has not measured or leave a stale
  // percentage on a box switched back to auto height.
  const index = heights ? autofitPick(heights, boxH) : 0;
  const reported = on && heights ? index : null;
  useEffect(() => {
    if (report) report(el.id, reported);
  }, [report, el.id, reported]);
  return {
    scale: on ? autofitScale(index) : 1,
    index: reported,
    probe: on && !heights ? <AutofitProbe el={el} width={boxW} nodeRef={probeRef} /> : null,
  };
}

// ── The ONE text body renderer ─────────────────────────────────────────────
// Every surface draws text through this — canvas, the v1 published page, present mode, the rail's
// thumbnail and the autofit probe — so "identical on all four surfaces" is structural, and the probe
// measure the very thing that will be painted. A GHOST is a PLAIN paragraph even on a list: a hint is
// not an item (and a bare string is not a legal child of <ul>).
// Copy `text` to the clipboard from a click. The async Clipboard API is refused inside an iframe
// whose host did not grant `clipboard-write` (a Dive is always framed), so the fallback is the
// legacy copy command on a throwaway textarea, which needs only the click's user activation.
async function copyToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// The copy button of a `level: "code"` element. `live` is false on surfaces that must not take the
// click: thumbnails, and in present mode every layer but the one on screen and every element still
// waiting for its build step (present layers are pointer-events:none and stacked, so a live button
// on a hidden layer would catch clicks meant for the slide above it). It stops the click either way
// so a copy never also advances the slide or starts a drag in the editor.
function CodeCopyButton({ text, live }) {
  const [state, setState] = useState("idle");
  useEffect(() => {
    if (state === "idle") return undefined;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  const Icon = state === "done" ? Check : state === "fail" ? AlertTriangle : Copy;
  return (
    <button type="button" tabIndex={-1} data-code-copy="1" data-copy-state={state}
      title={state === "done" ? "Copied" : state === "fail" ? "Copy failed" : "Copy to clipboard"}
      aria-label="Copy to clipboard"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(text || "").then((ok) => setState(ok ? "done" : "fail"));
      }}
      style={{
        position: "absolute", top: 0, right: 0, width: 30, height: 30, padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1.5px solid currentColor", borderRadius: 6, background: "transparent",
        color: "inherit", opacity: state === "idle" ? 0.75 : 1,
        cursor: live ? "pointer" : "default", pointerEvents: live ? "auto" : "none",
      }}>
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

// The link of a `level: "link"` element. `live` follows the copy button's rule, and is also false on
// the editor canvas, where a click must select the element rather than leave the page.
const SAFE_LINK = /^https?:\/\/[^\s]+$/i;
function LinkText({ el, style, live }) {
  const url = (el.text || "").trim();
  if (!SAFE_LINK.test(url)) return <p style={style}>{el.text}</p>;
  return (
    <p style={style}>
      <a href={url} target="_blank" rel="noopener noreferrer" data-link="1"
        onPointerDown={(e) => { if (live) e.stopPropagation(); }}
        onClick={(e) => { if (!live) { e.preventDefault(); return; } e.stopPropagation(); }}
        style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: "0.15em",
          cursor: live ? "pointer" : "inherit", pointerEvents: live ? "auto" : "none" }}>
        {url}
      </a>
    </p>
  );
}

function TextBody({ el, scale, ghost, copyLive = true, linkLive = copyLive }) {
  const style = textStyleOf(el, scale);
  const kind = listKindOf(el);
  if (ghost) {
    // Muted by OPACITY, not a grey: the background is the author's and may be anything, so a faded
    // version of the element's own ink is the only muting that reads on every deck. The metrics are
    // untouched, so the box does not jump when the first character lands.
    const Tag = kind ? "p" : textTagOf(el);
    return <Tag data-ghost="1" style={{ ...style, opacity: 0.38 }}>{ghost}</Tag>;
  }
  if (el.level === "link") return <LinkText el={el} style={style} live={linkLive} />;
  if (el.level === "code") {
    return (
      <div data-code="1" style={{ position: "relative", color: style.color }}>
        <p style={style}>{el.text}</p>
        <CodeCopyButton text={el.text} live={copyLive} />
      </div>
    );
  }
  if (!kind) {
    const Tag = textTagOf(el);
    return <Tag style={style}>{el.text}</Tag>;
  }
  const Tag = kind;
  const items = listItems(el.text, kind);
  return (
    <Tag data-list={kind} style={{ ...style, listStyle: "none", padding: 0 }}>
      {items.map((item, i) => (
        // THE HANGING INDENT. Marker and text are two flex items, so a wrapped line starts at the
        // TEXT column's edge, not under the marker — the one thing a literal marker character in the
        // string cannot do. The depth offset is in em, so it scales with autofit.
        <li key={i} data-list-depth={item.depth} style={{
          display: "flex", alignItems: "baseline", marginLeft: (item.depth * LIST_INDENT_EM) + "em",
        }}>
          <span aria-hidden="true" style={{
            flex: "none", minWidth: LIST_MARKER_EM + "em", paddingRight: "0.35em",
            whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
          }}>{item.marker}</span>
          {/* `minWidth: 0` lets a flex item wrap instead of overflowing; a blank line gets a
              non-breaking space so it keeps one line's height instead of collapsing. */}
          <span style={{ flex: "1 1 auto", minWidth: 0 }}>{item.blank ? "\u00a0" : item.body}</span>
        </li>
      ))}
    </Tag>
  );
}

// `surface` NAMES the caller ("canvas" from the edit canvas, "read" from the v1 published page, and
// present mode has its own renderer) and the ghost decision is `ghostVisible`'s, not this
// component's — so a surface that should never ghost cannot start ghosting through a change in
// here. See ghostTextOf for why the ghost is derived rather than stored.
// `boxW`/`boxH` are the box the text must live in, not always `el.w`/`el.h`: mid-resize the canvas
// passes the DRAFT rect so autofit tracks the handle live. Absent, they fall back to the element.
function TextContent({ el, editing, onCommit, onCancel, surface, boxW, boxH, reportFit, copyLive }) {
  const fit = useAutofit(el, boxW != null ? boxW : el.w, boxH != null ? boxH : el.h, reportFit);
  const cancelled = useRef(false);
  const committed = useRef(false);
  const seeded = useRef(false);
  const nodeRef = useRef(null);
  const commitRef = useRef(onCommit);
  const latestText = useRef(null);
  commitRef.current = onCommit;
  // Commit exactly once — from blur OR from unmount (e.g. the user clicked another
  // element, which unmounts the contentEditable before blur can fire).
  const readEditable = readEditableText;
  const captureText = useCallback((event) => {
    const value = readEditable(event.currentTarget);
    if (value != null) latestText.current = value;
  }, [readEditable]);
  const doCommit = useCallback(() => {
    if (committed.current || cancelled.current) return;
    const value = latestText.current != null ? latestText.current : readEditable(nodeRef.current);
    if (value == null) return;
    committed.current = true;
    // innerText already drops trailing line breaks per spec; this only guards the detached path.
    commitRef.current(value.replace(/\n$/, ""));
  }, [readEditable]);
  useEffect(() => {
    if (!editing) return undefined;
    return () => doCommit();
  }, [editing, doCommit]);
  const seedRef = useCallback((node) => {
    if (node) nodeRef.current = node;
    if (node && !seeded.current) {
      seeded.current = true;
      node.textContent = el.text || "";
      node.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* selection is best-effort */ }
    }
  }, []);
  const style = textStyleOf(el, fit.scale);
  if (!editing) {
    return (
      <>
        {fit.probe}
        <TextBody el={el} scale={fit.scale} ghost={ghostVisible(el, surface)} copyLive={copyLive}
          linkLive={copyLive !== false && surface !== "canvas"} />
      </>
    );
  }
  return (
    <>
    {fit.probe}
    <div
      contentEditable
      suppressContentEditableWarning
      ref={seedRef}
      // THE RAW STRING IS WHAT IS EDITED, tabs and all: markers are derived, so drawing them here
      // would put glyphs in front of the caret that are not in the text — selectable, deletable, and
      // in `innerText` at commit. `tabSize` keeps a tab reading as one indent step meanwhile.
      style={{ ...style, outline: "none", cursor: "text", minHeight: "1em" }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); return; }
        // Tab NEVER leaves the box: the browser default (focus the next control) would end the edit
        // mid-word and commit. Swallowing it is half the fix; doing something is the other half.
        if (e.key === "Tab") {
          e.preventDefault();
          const node = e.currentTarget;
          const snap = editableSnapshot(node);
          if (!snap) return;
          const next = indentText(snap.text, snap.start, snap.end, e.shiftKey);
          if (!next.changed) return;
          writeEditableText(node, next.text, next.start, next.end);
          // A programmatic write fires no `input` event, so the commit path is told by hand.
          latestText.current = next.text;
        }
      }}
      onInput={captureText}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
        try { document.execCommand("insertText", false, text); } catch (err) { /* noop */ }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => {
        if (cancelled.current) onCancel();
        else doCommit();
      }}
    />
    </>
  );
}

// ── Image crop ──────────────────────────────────────────────────────────────
// An image element MAY carry `crop: { ox, oy, zoom }`. ABSENT means "no crop" and the element
// renders through exactly the single-<img> path it always used — the whole crop path is
// guarded, so every pre-existing image is byte-for-byte unaffected.
//
// THE MODEL. The image is put in an overflow-hidden frame that is the element box (W×H) and
// the <img> keeps its existing `objectFit`. Two composed offsets pan it, BOTH driven by the
// same normalized pair (ox, oy) ∈ [0,1]²:
//   1. `object-position: ox*100% oy*100%`   — applied for fit "cover" ONLY, where it slides the
//      source inside the cover overflow (Ox, Oy = rendered size − frame size ≥ 0).
//   2. `transform: scale(zoom)` with `transform-origin: ox*100% oy*100%` — the zoom window.
// Writing L(ox) for the left edge of the painted content relative to the frame:
//      L(ox) = −ox · [ W·(zoom−1) + zoom·Ox ]
// so L(0) = 0 (flush left) and L(1) + zoom·(W+Ox) = W (flush right). ox is therefore an exact
// 0..1 parametrization of the LEGAL pan range at any zoom ≥ 1: the frame is always fully
// covered and no clamp against `zoom` is needed beyond keeping ox/oy in [0,1]. (0.5, 0.5) is
// centred, which is what an image without a crop already shows.
//
// TRAVEL. The total pannable distance is Dx = W·(zoom−1) + zoom·Ox (Dy likewise). Dragging the
// image right by `dx` logical px is Δox = −dx/Dx, so the picture tracks the pointer 1:1. At
// zoom = 1 with fit "cover" the only travel is the cover overflow; with "contain"/"fill" there
// is none (Ox = Oy = 0) and only zoom > 1 opens a pan range.
//
// FIT INTERACTION. "cover" is the intended case and is exact. For "contain"/"fill" the frame
// scales the letterboxed/stretched box itself, so cropping there behaves like a cover of the
// zoomed region (a contain image can be panned until its gutter shows) — acceptable, and the
// reason the crop UI is most useful on cover.
const CROP_ZOOM_MIN = 1, CROP_ZOOM_MAX = 4;
const DEFAULT_CROP = { ox: 0.5, oy: 0.5, zoom: 1 };
const clamp01 = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
function normCrop(c) {
  if (!c || typeof c !== "object") return null;
  const z = Number(c.zoom);
  return {
    // clamp01 already encodes "only a finite NUMBER is a value" — wrapping in Number() first
    // defeated it, because Number(null) / Number("") / Number([]) are 0, which silently jams a
    // half-written crop against the top-left edge instead of falling back to centred.
    ox: clamp01(c.ox),
    oy: clamp01(c.oy),
    zoom: isFinite(z) ? Math.max(CROP_ZOOM_MIN, Math.min(CROP_ZOOM_MAX, z)) : 1,
  };
}
const roundCrop = (c) => ({
  ox: Math.round(c.ox * 1000) / 1000,
  oy: Math.round(c.oy * 1000) / 1000,
  zoom: Math.round(c.zoom * 100) / 100,
});

// ── Browser image cache (stale-while-revalidate) ──
// Every image comes from the scene's one images query, and that query needs a network round trip
// on every page load, so a reload used to paint grey "missing" boxes until it returned. This keeps
// the last result in this browser's IndexedDB, keyed by Dive id + a hash of the query text, and
// paints it the moment the Dive mounts. The live query still runs every time; when it returns, its
// images replace the cached ones (so a changed or new image shows up) and become the new cache.
// Storage is per browser and per viewer, never shared, and every call is wrapped: with no
// IndexedDB (private window, blocked site data) the Dive behaves exactly as it did without a cache.
const IMAGE_CACHE_DB = "md-dive-image-cache";
const IMAGE_CACHE_STORE = "imageMaps";
const IMAGE_CACHE_INDEX = "__index__"; // { [key]: savedAt } so eviction never loads every map
const IMAGE_CACHE_MAX_ENTRIES = 24;    // the origin is shared by every Dive this browser opens
const EMPTY_IMAGE_MAP = Object.freeze({});

function imageCacheKey(sql) {
  // FNV-1a over the query text: an edited images query never paints another query's images.
  let h = 0x811c9dc5;
  const s = String(sql || "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${SCENE.diveId || "dive"}:${h.toString(16)}`;
}

let imageCacheDbPromise = null;
function imageCacheDb() {
  if (!imageCacheDbPromise) {
    imageCacheDbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined" || !indexedDB) { resolve(null); return; }
        const req = indexedDB.open(IMAGE_CACHE_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IMAGE_CACHE_STORE)) db.createObjectStore(IMAGE_CACHE_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  return imageCacheDbPromise;
}

function imageCacheGet(store, key) {
  return new Promise((resolve) => {
    try {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}

async function imageCacheRead(key) {
  try {
    const db = await imageCacheDb();
    if (!db) return null;
    const rec = await imageCacheGet(db.transaction(IMAGE_CACHE_STORE, "readonly").objectStore(IMAGE_CACHE_STORE), key);
    return rec && rec.map && typeof rec.map === "object" ? rec.map : null;
  } catch (e) { return null; }
}

async function imageCacheWrite(key, map) {
  try {
    const db = await imageCacheDb();
    if (!db) return;
    const tx = db.transaction(IMAGE_CACHE_STORE, "readwrite");
    const store = tx.objectStore(IMAGE_CACHE_STORE);
    const now = Date.now();
    store.put({ map, savedAt: now }, key);
    const index = (await imageCacheGet(store, IMAGE_CACHE_INDEX)) || {};
    index[key] = now;
    const keys = Object.keys(index).sort((a, b) => index[b] - index[a]);
    for (const old of keys.slice(IMAGE_CACHE_MAX_ENTRIES)) { store.delete(old); delete index[old]; }
    store.put(index, IMAGE_CACHE_INDEX);
  } catch (e) { /* a full or blocked store just means no cache */ }
}

function sameImageMap(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// The scene's image map: the cached copy first, then the live query's result once it arrives.
function useCachedImageMap(imagesQ) {
  const key = SCENE.images ? imageCacheKey(SCENE.images.sql) : null;
  const [cached, setCached] = useState(null);
  const fresh = useMemo(() => {
    if (imagesQ.error || !Array.isArray(imagesQ.data)) return null; // still loading, or failed: keep the cache
    const m = {};
    for (const r of imagesQ.data) if (r.name != null && r.src != null) m[String(r.name)] = String(r.src);
    return m;
  }, [imagesQ.data, imagesQ.error]);
  const freshRef = useRef(null);
  freshRef.current = fresh;
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    imageCacheRead(key).then((m) => { if (live && m && !freshRef.current) setCached(m); });
    return () => { live = false; };
  }, [key]);
  useEffect(() => {
    if (!key || !fresh) return;
    imageCacheRead(key).then((old) => { if (!sameImageMap(old, fresh)) imageCacheWrite(key, fresh); });
  }, [key, fresh]);
  return fresh || cached || EMPTY_IMAGE_MAP;
}

function ImageContent({ el, imageMap, crop }) {
  const src = imageMap[el.imageKey];
  if (!src) {
    return (
      <div className="flex flex-col items-center justify-center gap-1" style={{ width: "100%", height: "100%", background: "#eceff3", borderRadius: el.radius || 0, color: "#9aa1aa" }}>
        <ImageIcon size={20} style={{ opacity: 0.5 }} />
        <span style={{ fontSize: 11 }}>{el.imageKey ? `missing: ${el.imageKey}` : "no image"}</span>
      </div>
    );
  }
  const fit = el.fit || "cover";
  if (!crop) {
    return (
      <img src={src} alt={el.alt || ""} draggable={false}
        style={{ width: "100%", height: "100%", objectFit: fit, borderRadius: el.radius || 0, display: "block" }} />
    );
  }
  const pos = `${crop.ox * 100}% ${crop.oy * 100}%`;
  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden", borderRadius: el.radius || 0 }}>
      <img src={src} alt={el.alt || ""} draggable={false}
        style={{
          width: "100%", height: "100%", objectFit: fit, display: "block",
          objectPosition: fit === "cover" ? pos : undefined,
          transform: crop.zoom !== 1 ? `scale(${crop.zoom})` : undefined,
          transformOrigin: pos,
        }} />
    </div>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────
// A basic grid: hand-typed cells, edited on the canvas like a text element.
//
// THE MODEL. `cells` is a rectangular row-major array of cell records `{ t, ...style }`,
// where the style keys are exactly the ones TextStyleControls speaks (fontSize, bold, italic,
// underline, align, color, highlight) so the inspector reuses that control verbatim.
//
// `colWidths` / `rowHeights` are relative WEIGHTS, not pixels. Each track renders as its share
// of the element box (weight / sum), so dragging the element's resize handles scales the whole
// grid and there is no second source of truth to keep in sync with w/h. A table with no
// weights is uniform. Weights are what a column-width drag edits.
const TABLE_CELL_STYLE_KEYS = ["fontSize", "bold", "italic", "underline", "align", "color", "highlight"];
const TABLE_DEFAULTS = { fontSize: 13, color: "#231f20", align: "left", border: { color: "#d6d9de", width: 1 } };
const TABLE_MIN_WEIGHT = 0.06;

const tableCellText = (cell) => (cell && typeof cell.t === "string" ? cell.t : "");

// Every write of a weight track goes through this: renormalize to sum 1, round off float
// noise (0.26666666666666666 costs 18 bytes of a 64KB budget), and collapse a uniform track
// to null so a plain grid stores no track at all.
function tableTrack(list) {
  const total = list.reduce((sum, entry) => sum + entry, 0);
  if (!(total > 0)) return null;
  const fracs = list.map((entry) => Math.round((entry / total) * 1e4) / 1e4);
  const uniform = fracs.every((f) => Math.abs(f - 1 / fracs.length) < 1e-3);
  return uniform ? null : fracs;
}

// Every read of a table goes through this, so a half-written patch from a hand-edited URL
// degrades to a sane grid instead of throwing inside the renderer.
function normTable(el) {
  const raw = Array.isArray(el.cells) ? el.cells : [];
  const rows = Math.max(1, Math.min(200, raw.length || 1));
  let cols = 1;
  for (const row of raw) if (Array.isArray(row)) cols = Math.max(cols, row.length);
  cols = Math.max(1, Math.min(40, cols));
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    const src = Array.isArray(raw[r]) ? raw[r] : [];
    const row = [];
    for (let c = 0; c < cols; c += 1) {
      const cell = src[c];
      row.push(cell && typeof cell === "object" && !Array.isArray(cell) ? cell : { t: "" });
    }
    cells.push(row);
  }
  const weights = (value, n) => {
    const list = Array.isArray(value) && value.length === n
      ? value.map((entry) => (Number.isFinite(entry) && entry > 0 ? entry : 1))
      : new Array(n).fill(1);
    const total = list.reduce((sum, entry) => sum + entry, 0);
    return total > 0 ? list.map((entry) => entry / total) : new Array(n).fill(1 / n);
  };
  return {
    cells,
    cols,
    colFracs: weights(el.colWidths, cols),
    rowFracs: weights(el.rowHeights, rows),
    border: normTableBorder(el.border),
  };
}

// `border` is one key with one meaning on BOTH table types, so it has one resolver. Sharing the
// function rather than the constant is what makes "the same settings named the same" true of the
// DEFAULTS too — a manual table and a SQL table with no border set draw the identical hairline.
function normTableBorder(border) {
  const b = border && typeof border === "object" ? border : {};
  return {
    on: b.on !== false,
    color: typeof b.color === "string" ? b.color : TABLE_DEFAULTS.border.color,
    width: Number.isFinite(b.width) && b.width > 0 ? b.width : TABLE_DEFAULTS.border.width,
  };
}

// Cell text styling reuses resolveTextStyle so a cell and a text element interpret the same
// keys the same way; only the defaults differ.
const tableCellStyle = (cell) => ({
  ...resolveTextStyle(cell || {}, {
    fontSize: TABLE_DEFAULTS.fontSize,
    fontWeight: 400,
    color: TABLE_DEFAULTS.color,
    align: TABLE_DEFAULTS.align,
  }),
  fontWeight: cell && cell.bold ? 700 : 400,
  fontFamily: T.font,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  lineHeight: 1.35,
});

// Editing a cell mirrors TextContent's contract exactly: commit once, from blur OR unmount,
// reading the node while it is still connected.
// Returns the value a cell should commit, or null for "nothing to write". Blur and unmount both
// call the committer, and a long-lived editor commits many times, so the rule is "write when the
// text actually changed" rather than "write once".
function tableCommitValue(raw, lastCommitted) {
  if (raw == null) return null;
  const next = String(raw).replace(/\n$/, "");
  return next === lastCommitted ? null : next;
}

function TableCellEditor({ cell, onCommit }) {
  const nodeRef = useRef(null);
  const latest = useRef(null);
  // The last value handed to the parent. Unlike a text element — whose editor UNMOUNTS the
  // moment it commits, because committing clears editingTextId — a cell editor OUTLIVES its
  // commits: the cursor deliberately survives so the inspector can style the cell. So a
  // one-shot "already committed" flag would silently swallow every edit after the first blur.
  // Comparing against the last committed value instead keeps blur+unmount from double-writing
  // while leaving the editor usable for the rest of the session.
  const lastCommitted = useRef(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const doCommit = useCallback(() => {
    const raw = latest.current != null ? latest.current : readEditableText(nodeRef.current);
    const next = tableCommitValue(raw, lastCommitted.current);
    if (next == null) return;
    lastCommitted.current = next;
    commitRef.current(next);
  }, []);
  useEffect(() => () => doCommit(), [doCommit]);
  // Seed and focus from an EFFECT, not from the ref callback. The ref runs inside React's commit
  // for the very pointerdown that selected this cell, so the browser's own default focus handling
  // for that same event ran afterwards and moved focus to <body>, leaving a mounted editor that
  // silently swallowed every keystroke. An effect lands after the event completes, so it sticks.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const initial = tableCellText(cell);
    node.textContent = initial;
    latest.current = initial;
    lastCommitted.current = initial;
    node.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection is best-effort */ }
  }, []);
  return (
    <div contentEditable suppressContentEditableWarning ref={nodeRef}
      style={{ ...tableCellStyle(cell), outline: "none", cursor: "text", minHeight: "1em" }}
      onInput={(event) => { const v = readEditableText(event.currentTarget); if (v != null) latest.current = v; }}
      onPointerDown={(event) => event.stopPropagation()}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
        try { document.execCommand("insertText", false, text); } catch (err) { /* noop */ }
      }}
      onBlur={doCommit} />
  );
}

function TableContent({ el, editing, activeCell, onPickCell, onEnterCell, onCommitCell, onNav, onColDrag }) {
  const t = normTable(el);
  const b = t.border;
  const line = b.on ? `${b.width}px solid ${b.color}` : "none";
  return (
    <table style={{
      width: "100%", height: "100%", borderCollapse: "collapse", tableLayout: "fixed",
      background: "#fff", border: line,
    }}>
      <colgroup>
        {t.colFracs.map((frac, c) => <col key={c} style={{ width: `${frac * 100}%` }} />)}
      </colgroup>
      <tbody>
        {t.cells.map((row, r) => (
          <tr key={r} style={{ height: `${t.rowFracs[r] * 100}%` }}>
            {row.map((cell, c) => {
              const isActive = editing && activeCell && activeCell.r === r && activeCell.c === c;
              return (
                <td key={c}
                  // preventDefault keeps the browser from running its own focus handling for this
                  // pointerdown, which would otherwise land on <body> AFTER the new cell editor
                  // mounted and leave it unfocused.
                  onPointerDown={editing && !isActive ? (event) => { event.stopPropagation(); event.preventDefault(); onPickCell(r, c); } : undefined}
                  // Entering from a double-click starts on the cell actually under the pointer.
                  // Guarded on onEnterCell, not just on `editing`: the filmstrip renders this
                  // component with NO callbacks, and a thumbnail must carry zero pointer handlers.
                  onDoubleClick={!editing && onEnterCell ? (event) => { event.stopPropagation(); onEnterCell(r, c); } : undefined}
                  onKeyDown={isActive ? (event) => {
                    event.stopPropagation();
                    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                      event.preventDefault();
                      onNav(event.key === "Tab" ? (event.shiftKey ? "prev" : "next") : "down");
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      onNav("exit");
                    }
                  } : undefined}
                  style={{
                    border: line, padding: "4px 7px", verticalAlign: "top", overflow: "hidden",
                    boxShadow: isActive ? `inset 0 0 0 2px ${T.accent}` : undefined,
                    cursor: editing ? "text" : undefined,
                  }}>
                  {isActive
                    ? <TableCellEditor key={`${r}:${c}`} cell={cell} onCommit={(text) => onCommitCell(r, c, text)} />
                    : <div style={tableCellStyle(cell)}>{tableCellText(cell) || "​"}</div>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
      {/* Column dividers are drag handles only while the table is being edited. They sit above
          the cells so a drag never lands in a contentEditable. */}
      {editing ? (
        <caption style={{ captionSide: "top", height: 0, padding: 0, margin: 0 }}>
          <div style={{ position: "relative", height: 0 }}>
            {t.colFracs.slice(0, -1).map((_, i) => {
              const left = t.colFracs.slice(0, i + 1).reduce((sum, f) => sum + f, 0);
              return (
                <div key={i} title="Drag to resize column"
                  onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); onColDrag(event, i); }}
                  style={{
                    position: "absolute", left: `${left * 100}%`, top: 0, width: 9, height: el.h || 0,
                    transform: "translateX(-50%)", cursor: "col-resize", zIndex: 3,
                  }} />
              );
            })}
          </div>
        </caption>
      ) : null}
    </table>
  );
}

// Row/column edits rebuild `cells` and the matching weight track together, so the two can never
// disagree — the shape the bake validator checks.
function tableWithRow(el, at, remove) {
  const t = normTable(el);
  const cells = t.cells.map((row) => row.slice());
  const rowFracs = t.rowFracs.slice();
  if (remove) {
    if (cells.length <= 1) return null;
    cells.splice(at, 1);
    rowFracs.splice(at, 1);
  } else {
    const share = 1 / Math.max(1, rowFracs.length);
    cells.splice(at, 0, new Array(t.cols).fill(null).map(() => ({ t: "" })));
    rowFracs.splice(at, 0, share);
  }
  return { cells, rowHeights: tableTrack(rowFracs), colWidths: tableTrack(t.colFracs) };
}

function tableWithCol(el, at, remove) {
  const t = normTable(el);
  const colFracs = t.colFracs.slice();
  if (remove) {
    if (t.cols <= 1) return null;
    colFracs.splice(at, 1);
  } else {
    colFracs.splice(at, 0, 1 / Math.max(1, colFracs.length));
  }
  const cells = t.cells.map((row) => {
    const next = row.slice();
    if (remove) next.splice(at, 1); else next.splice(at, 0, { t: "" });
    return next;
  });
  return { cells, colWidths: tableTrack(colFracs), rowHeights: tableTrack(t.rowFracs) };
}

// Writing a cell keeps every other cell object identical, so prunePatch still sees an unchanged
// scene for untouched rows and the override stays as small as the edit.
function tableWithCell(el, r, c, changes) {
  const t = normTable(el);
  const cells = t.cells.map((row, ri) => (ri === r ? row.slice() : row));
  const cell = { ...cells[r][c], ...changes };
  for (const key of Object.keys(cell)) {
    if (cell[key] == null || cell[key] === false) delete cell[key];
  }
  if (typeof cell.t !== "string") cell.t = "";
  cells[r][c] = cell;
  return cells;
}

// ── SQL data table ──────────────────────────────────────────────────────────
// The manual `table` above with the author's keyboard replaced by a query. `sql` says what the rows
// ARE; every other key says how they LOOK. Nothing about the data is stored, which is the whole
// point: the slide shows what the warehouse says today, not what it said when the deck was written.
//
// ALIGNED WITH THE MANUAL TABLE by sharing code, not by copying values:
//   • `border` is the same key with the same { on, color, width } shape, resolved by the same
//     normTableBorder, and labelled "Borders" / "Color" / "Width" in the same order in the inspector;
//   • header and body text are sparse TextStyle bags driven by the same TextStyleControls a manual
//     cell uses, defaulting to TABLE_DEFAULTS' font size and ink;
//   • per-column `align` is the same key with the same three values a cell's align takes.
//
// WHERE THEY DIFFER, and why:
//   • `format` (As-is / 1,234 / 1.2K / 12%) has no manual counterpart — a typed cell is already the
//     string the author wanted. It is named and valued after the CHART's tick Format control and
//     runs the same FMT table, so a deck has ONE number-format vocabulary rather than two.
//   • no `colWidths`/`rowHeights`. Those are POSITION-keyed weights, and these columns are whatever
//     the query returned, so a weight vector would hand the wrong width to the wrong column the
//     first time the SELECT list changed. The drawn columns divide the frame equally instead
//     (`table-layout: fixed`), which is also what makes every column the grid draws a column the
//     audience can SEE — content sizing let a twenty-column `SELECT *` draw twenty and show six.
//   • a real header row. A manual table fakes one with its first row of cells; here the first row is
//     data, so the header has to be its own thing — hence `header` rather than a styled row 0.
//
// THE CAP, on BOTH axES. `limit` is how many rows the AUTHOR asked to draw, hard-capped by the core
// at the manual table's own row ceiling; the BOX decides how many can actually be seen; and what is
// drawn is the smaller of the two, per axis (sqlTableRowCapacity / sqlTableColCapacity). Drawing
// `limit` regardless is what let a 40-px-tall grid clip ten rows in silence and a resize hide rows
// the caption never mentioned. The cap is applied to the RESULT and never spliced into the
// statement: the SQL in the editor is exactly the SQL that runs, and present mode's pool keys on
// that text, so rewriting it would fork the pool and make its deduplication a lie. A truncated grid
// SAYS SO under its last row — rows and columns both — on every surface, and the caption sits in a
// `flex-shrink: 0` row so no arithmetic error can push it out of the frame again.
const SQLTABLE_HEADER_FILL = "#f1f3f5";
const SQLTABLE_ZEBRA_FILL = "#f8f9fa";
// The manual table's cell padding, verbatim — kept as its two components because the row height and
// the column capacity below are BUILT out of them rather than out of a string.
const SQLTABLE_CELL_PAD_Y = 4;
const SQLTABLE_CELL_PAD_X = 7;
const SQLTABLE_CELL_PAD = `${SQLTABLE_CELL_PAD_Y}px ${SQLTABLE_CELL_PAD_X}px`;
// The truncation caption's ink: quieter than the data it qualifies, still legible on a projector.
const SQLTABLE_CAPTION_INK = "#6a6a6a";
const SQLTABLE_CAPTION_FS = 11;
// The manual table's cell LEADING, and the grid sets it explicitly. It used not to: the grid claimed
// "the same text metrics as a manual cell" while inheriting the ambient 1.5, so a row that the
// derived default sized at 26 px laid out at 29 and the eleventh row plus the caption fell outside
// `overflow: hidden` — the audience saw ten of forty thousand rows and was told nothing. Every
// height below is measured at THIS leading, so the number and the layout cannot disagree again.
const SQLTABLE_LINE_H = 1.35;
// One body row's CONTENT box: the body font at the leading above, plus the vertical cell padding.
// Not a look — it is the unit the row capacity counts in.
const SQLTABLE_ROW_H = Math.ceil(TABLE_DEFAULTS.fontSize * SQLTABLE_LINE_H) + 2 * SQLTABLE_CELL_PAD_Y;
// The truncation caption's own content box, built the same way. It is RESERVED in the capacity
// arithmetic whether or not the caption is drawn, so turning truncation on cannot change the layout.
const SQLTABLE_CAPTION_H = Math.ceil(SQLTABLE_CAPTION_FS * SQLTABLE_LINE_H) + 2 * SQLTABLE_CELL_PAD_Y;
// ChartSurface draws the title above the grid and sets no line-height, so the ambient leading
// applies; the gap is its marginBottom. Reserved here because the grid's box is the element's box
// MINUS the title, and a capacity measured against the element would over-count by a row.
const SQLTABLE_TITLE_LINE_H = 1.5;
const SQLTABLE_TITLE_GAP = 4;
// The narrowest a column can be and still show anything: two cell paddings plus about four glyphs at
// the body size (HL_CHAR_W is this file's one advance-width estimate, shared with the SVG highlight).
// It is the horizontal counterpart of SQLTABLE_ROW_H — the unit the column capacity counts in.
const SQLTABLE_MIN_COL_W = 2 * SQLTABLE_CELL_PAD_X + Math.ceil(TABLE_DEFAULTS.fontSize * 4 * HL_CHAR_W);
// The same argument as CHART_DEFAULT_SQL, for the same reason: a literal VALUES table touches no
// catalog, so it cannot fail on any DuckDB this dive can reach, it draws real rows on the first
// frame, and its columns fill the inspector's column list immediately. Three columns and not two,
// because the mix is what the defaults are FOR: `region` is text and left-aligns, `revenue` and
// `growth` are numeric and right-align, and `growth` is a fraction so the percent format has
// something honest to demonstrate. Four rows so the zebra striping is visible at all.
// `::DOUBLE` on the first value and not the rest: VALUES unifies the column's type from the first
// row, and an uncast decimal literal is DECIMAL, which arrives over Arrow as an object rather than a
// number. sqlTableCellText copes with that (real queries return decimals all the time), but the
// DEFAULT should not be the one place a first-time author meets the awkward type.
const SQLTABLE_DEFAULT_SQL = "SELECT * FROM (VALUES ('North',1240,0.184::DOUBLE),('South',980,0.121),('East',1510,-0.052),('West',760,0.093)) t(region,revenue,growth)";
// ONE number-format vocabulary for the whole deck. The chart's two tick-Format controls inlined this
// identical literal twice and the grid held a third copy; they all read this now, so a deck cannot
// grow two spellings of the same option list.
const SQLTABLE_FORMAT_OPTS = [["none", "As-is"], ["number", "1,234"], ["compact", "1.2K"], ["percent", "12%"]];
const SQLTABLE_ALIGN_OPTS = [{ k: "left", icon: AlignLeft, title: "Left" }, { k: "center", icon: AlignCenter, title: "Center" }, { k: "right", icon: AlignRight, title: "Right" }];
// Header is bolder than the body and nothing else: same size, same ink, same alignment rules, so a
// header and a cell cannot disagree about anything the author did not set.
const SQLTABLE_TEXT_TARGETS = ["header", "cells", "title"];
const SQLTABLE_TEXT_DEFAULTS = {
  header: { fontSize: TABLE_DEFAULTS.fontSize, fontWeight: 600, color: TABLE_DEFAULTS.color, align: TABLE_DEFAULTS.align },
  cells: { fontSize: TABLE_DEFAULTS.fontSize, fontWeight: 400, color: TABLE_DEFAULTS.color, align: TABLE_DEFAULTS.align },
  title: CHART_TEXT_DEFAULTS.title,
};

// Is this value a number as far as the rest of the framework is concerned? Extracted from
// ChartBlock's column report so the grid's default alignment and the chart inspector's numeric
// column list cannot disagree — "right-aligned" and "offered as a series" are now one predicate.
const isNumericCell = (value) =>
  typeof value === "number" || typeof value === "bigint"
  || (value != null && typeof value === "object" && !isNaN(Number(value)));
const numericColsOf = (row) => Object.keys(row || {}).filter((key) => isNumericCell(row[key]));

// Numbers right, everything else left — the data-table convention, DERIVED from the value rather
// than guessed, so a fresh grid is already readable and `align` only ever records a DEPARTURE from
// it. Shared with the inspector so the Seg shows the alignment that is actually drawn instead of
// pretending an unset column is left-aligned.
const sqlTableAlign = (configured, numeric) =>
  (configured === "left" || configured === "center" || configured === "right")
    ? configured
    : (numeric ? "right" : "left");

// ── the geometry, which the type DOES store ─────────────────────────────────
// A SQL table's rows are FIXED-height, unlike the manual table's tracks (which are weights OF the
// element box and so cannot overflow). That makes `limit` and the element's own `w`/`h` two things
// that genuinely disagree: `limit` says how many rows the author asked for, and the box says how
// many can be seen. Drawing `limit` regardless is what made a 40-px-tall grid clip ten rows in
// silence, and shrinking a box in the inspector hide drawn rows with the caption still saying
// nothing. So the drawn count is the MINIMUM of the two, on both axes, and the caption reports
// whatever was withheld regardless of which bound bit.
//
// The arithmetic below is a MODEL of the layout, and the layout is what is authoritative, so the
// grid is also built so that the model being wrong cannot hide the caption: the table sits in a
// `flex: 1; min-height: 0; overflow: hidden` box and the caption is `flex-shrink: 0`, which makes
// the caption structurally unclippable. The model buys the quality (no clipped half-row); the flex
// box buys the honesty.
const sqlTableLine = (el) => { const b = normTableBorder(el && el.border); return b.on ? b.width : 0; };
const sqlTableTitleH = (el) => (el && el.title
  ? Math.ceil((sqlTableTextStyle(el, "title").fontSize || CHART_TEXT_DEFAULTS.title.fontSize) * SQLTABLE_TITLE_LINE_H) + SQLTABLE_TITLE_GAP
  : 0);
// The grid div's own border-box, which is the element's box minus whatever ChartSurface put above it.
// `null` means "there is no box here": a validated sqltable always carries finite w and h, so this
// only happens for a partial element (a test fixture, a rail preview of a hand-edited scene). The
// capacities below then fall back to the CORE's ceilings, so "no box" bounds nothing rather than
// silently bounding everything to one row and one column.
const sqlTableBoxH = (el) => (Number.isFinite(el && el.h) ? Math.max(0, el.h - sqlTableTitleH(el)) : null);
const sqlTableBoxW = (el) => (Number.isFinite(el && el.w) ? Math.max(0, el.w) : null);

// How many BODY rows this box can show. `box-sizing: border-box` is in force, so the frame's own
// rule costs `line` at the top and the bottom; with `border-collapse: collapse` each row costs its
// content box plus one shared rule, and so does the header band. The caption row is reserved
// unconditionally (see SQLTABLE_CAPTION_H). At least one row always, so a box too small for even
// that draws one clipped row under a caption that still says how many were withheld.
function sqlTableRowCapacity(el) {
  const box = sqlTableBoxH(el);
  if (box === null) return EDITABLE_DIVE_MAX_TABLE_ROWS;
  const line = sqlTableLine(el);
  const pitch = SQLTABLE_ROW_H + line;
  const chrome = (sqlTableHeaderOn(el) ? pitch : 0) + SQLTABLE_CAPTION_H + line;
  return Math.max(1, Math.floor((box - 2 * line - chrome) / pitch));
}

// The horizontal counterpart. `table-layout: fixed` divides the frame equally between the drawn
// columns, so "drawn" and "visible" are the same set — which is what gives the column half of the
// caption something true to say. Bounded by the core's column ceiling as well, so a 200-column
// result cannot build 200 columns of DOM to show none of them.
function sqlTableColCapacity(el) {
  const box = sqlTableBoxW(el);
  if (box === null) return EDITABLE_DIVE_MAX_TABLE_COLS;
  const line = sqlTableLine(el);
  return Math.max(1, Math.min(
    EDITABLE_DIVE_MAX_TABLE_COLS,
    Math.floor((box - 2 * line) / (SQLTABLE_MIN_COL_W + line)),
  ));
}

// The drawn-row cap the AUTHOR asked for. Clamped here as well as in the core's validator, because
// the runtime also has to survive a hand-edited URL that the Save boundary would have refused.
const sqlTableLimit = (limit) => Math.max(1, Math.min(
  EDITABLE_DIVE_MAX_TABLE_ROWS,
  Number.isFinite(limit) ? Math.trunc(limit) : SQLTABLE_DEFAULT_LIMIT,
));

// The columns the RESULT has, in result order. Read as the union of the row keys rather than the
// first row's keys: one row is not the schema, and a result whose first row happens to be missing a
// key would otherwise drop that column for every other row too. (The platform's useSQLQuery hands
// the renderer rows and nothing else, so a result with ZERO rows genuinely reports no columns —
// the inspector says so as a statement instead of asking for a run that already happened.)
function sqlTableResultColumns(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// The columns to DRAW. `columns` is presentation only and keyed by name, so a query that drops a
// column simply stops consulting its entry, and one that renames a column loses that column's
// formatting instead of applying it to the neighbour that took its position. There is no hide flag
// on purpose: SELECT is the projection, and a second one here would let a slide silently disagree
// with the statement printed beside it — which is also why the box's column capacity is reported in
// the caption rather than left to be discovered.
function sqlTableColumns(el, rows) {
  const names = sqlTableResultColumns(rows);
  if (!names.length) return [];
  const cfg = el && isPlainRecord(el.columns) ? el.columns : {};
  const first = (Array.isArray(rows) ? rows : []).find((row) => row && typeof row === "object");
  const numeric = new Set(numericColsOf(first));
  return names.slice(0, sqlTableColCapacity(el)).map((key) => {
    const c = isPlainRecord(cfg[key]) ? cfg[key] : {};
    return {
      key,
      label: typeof c.label === "string" && c.label !== "" ? c.label : key,
      align: sqlTableAlign(c.align, numeric.has(key)),
      format: typeof c.format === "string" && FMT[c.format] ? c.format : null,
    };
  });
}

// The rows to draw: `limit` and the box, whichever is smaller. `cap` is what was actually applied,
// so the caption cannot report a bound the slicer did not use.
function sqlTableRows(rows, limit, el) {
  const all = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object");
  const cap = Math.min(sqlTableLimit(limit), sqlTableRowCapacity(el));
  return { shown: all.slice(0, cap), total: all.length, cap, truncated: all.length > cap };
}

// What the audience is told, on BOTH axes. Null when nothing was withheld, so the caption cannot
// become decoration that stops meaning anything. The row cap's whole argument is that clipping plus
// a caption is the honest answer; that argument now has a horizontal half, because `SELECT *` on a
// twenty-column table draws what fits and used to say nothing about the rest.
function sqlTableCaption(view, cols, totalCols) {
  const n = (value) => Number(value).toLocaleString("en-US");
  const parts = [];
  if (view && view.truncated) parts.push(`${n(view.shown.length)} of ${n(view.total)} rows`);
  const drawn = Array.isArray(cols) ? cols.length : 0;
  if (Number.isFinite(totalCols) && totalCols > drawn) parts.push(`${n(drawn)} of ${n(totalCols)} columns`);
  return parts.length ? `Showing ${parts.join(", ")}` : null;
}

// One cell's text. The ORDER of these branches is the whole function: absent first, then Date (which
// would otherwise be caught by the numeric test below), then the column's format, then the types
// that need spelling out by hand. Every path returns a string, so no cell can render as undefined.
function sqlTableCellText(value, format) {
  if (value == null) return "";
  // A Date is an object whose Number() is a finite epoch, so it would pass isNumericCell and render
  // as 1750000000000. It is intercepted HERE rather than excluded from that predicate, because the
  // predicate also fills the chart inspector's numeric-column pickers, where a date belongs.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  const fmt = fmtOf(format);
  if (fmt && isNumericCell(value)) return fmt(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    // An Arrow Decimal (and anything else with a numeric coercion) stringifies as [object Object].
    // A struct or list has no numeric coercion, so it is shown as its JSON rather than as a lie.
    if (isNumericCell(value)) return String(Number(value));
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  return String(value);
}

// The drawing decisions, out of the JSX. Each is a BRANCH a test can reach rather than a call site a
// regex can only recognise — a mutation round found seven of these surviving as inline expressions.
// They are also what makes the rail's preview and the real grid provably agree: both ask these
// functions rather than keeping a copy of the arithmetic.
const sqlTableHeaderOn = (el) => !el || el.header !== false;
// Body row index, not DOM row index. The ODD ones stripe, so the FIRST body row stays plain and the
// header band is the only tint at the top — otherwise the eye reads two headers.
// `% 2 === 1` is the whole test, and it is sufficient on its own: a negative odd index gives -1, a
// non-integer gives a fraction, and NaN gives NaN — none of which equal 1. The `Number.isInteger`
// and `>= 0` guards this used to carry were provably unreachable, so they were assertions no input
// could ever exercise.
const sqlTableStriped = (el, bodyIndex) =>
  (!el || el.zebra !== false) && bodyIndex % 2 === 1;
const sqlTableRowFill = (el, bodyIndex) => (sqlTableStriped(el, bodyIndex) ? SQLTABLE_ZEBRA_FILL : undefined);
// One cell, as text plus the alignment it is drawn with — so "the column's format reached the cell"
// and "the column's alignment reached the cell" are assertions about a function.
const sqlTableCell = (row, col) => ({
  text: sqlTableCellText(row ? row[col.key] : null, col.format),
  align: col.align,
});
// Band `i` of the rail's preview: which fill it takes, and whether it IS the header. Same policy as
// the grid, expressed once — band 0 is the header when there is one, and the bands after it are body
// rows counted from zero, which is what sqlTableStriped expects.
const sqlTableThumbBand = (el, i) => {
  const header = i === 0 && sqlTableHeaderOn(el);
  const body = header ? -1 : (sqlTableHeaderOn(el) ? i - 1 : i);
  return { header, fill: header ? SQLTABLE_HEADER_FILL : sqlTableRowFill(el, body) };
};
// How many bands the rail draws. The FILL POLICY is genuinely shared with the grid; the row COUNT is
// not, and the rail used to draw as many bands as the box could hold — twelve bands over a grid that
// `limit: 3` had cut to three. Bounded by the same drawn count the grid uses, so the preview cannot
// promise rows the grid does not draw.
const sqlTableThumbBands = (el) => Math.max(1, Math.min(
  Math.floor((Number(el && el.h) || SQLTABLE_ROW_H) / SQLTABLE_ROW_H),
  (sqlTableHeaderOn(el) ? 1 : 0) + Math.min(sqlTableLimit(el && el.limit), sqlTableRowCapacity(el)),
));

// Drop `columns` entries for columns the current query does not return. Those entries were
// UNREACHABLE: the picker only ever offers current columns, so nothing in the UI could reach one to
// clear it, and they accumulated against the 40-column ceiling until formatting one LIVE column
// failed validation at Save time with no way back but hand-editing the URL.
//
// GATED on the column list being known. `report` is what ChartBlock published: `ran` says a query
// SUCCEEDED, and `cols` is what it returned. A loading or errored query publishes neither, and
// pruning against "no columns" would wipe the author's whole configuration the moment they typed a
// bad statement. A pure function rather than a closure so the gate is a branch a test can reach.
function sqlTablePruneColumns(cfg, report) {
  const columns = isPlainRecord(cfg) ? { ...cfg } : {};
  const live = report && report.ran && Array.isArray(report.cols) ? report.cols : null;
  if (!live || !live.length) return columns;
  const keep = new Set(live);
  const out = {};
  for (const key of Object.keys(columns)) if (keep.has(key)) out[key] = columns[key];
  return out;
}

const sqlTableTextStyle = (el, target) =>
  resolveTextStyle(el && isPlainRecord(el.textStyles) ? el.textStyles[target] : null, SQLTABLE_TEXT_DEFAULTS[target]);

// DERIVED, not chosen: as many body rows as a default-height element can show under a header and
// above a caption row. It is sqlTableRowCapacity AT THE DEFAULT BOX — the very function the renderer
// slices with — so the default and the layout cannot drift apart, which is exactly how the old
// "derived" 11 came to be two rows more than the box could hold. It sits here rather than beside the
// constants because the capacity helpers are const arrows and this is evaluated at module load.
const SQLTABLE_DEFAULT_LIMIT = sqlTableRowCapacity({ h: CHART_DEFAULT_H });

// A SQL table lands in the same box a chart does, because it is the same kind of element: a
// query-shaped hole in the slide. The default limit above is derived from that height by the very
// function the renderer uses, so the two cannot be changed apart.
function newSqlTableElement(common, cx, cy, page) {
  return {
    ...common, type: "sqltable",
    ...insertRect(cx, cy, CHART_DEFAULT_W, CHART_DEFAULT_H, page),
    sql: SQLTABLE_DEFAULT_SQL,
    // `limit` is written explicitly even though sqlTableLimit would default to the same number: the
    // row cap is the one policy an author has to be able to SEE, and a key absent from the JSON is
    // a key the inspector is only guessing at. `header`/`zebra`/`border` are omitted because their
    // defaults are on, so a fresh grid costs nothing extra in the override bag.
    limit: SQLTABLE_DEFAULT_LIMIT,
  };
}

// The grid itself: no hooks, no handlers, no query. ChartSurface owns the title, the skeleton and the
// error banner (identically for both live types), so this draws rows and nothing else — which is
// also why the canvas, the v1 published page and present mode all get it for free.
function SQLTableGrid({ el, rows }) {
  const cols = sqlTableColumns(el, rows);
  const totalCols = sqlTableResultColumns(rows).length;
  const view = sqlTableRows(rows, el.limit, el);
  const b = normTableBorder(el.border);
  const line = b.on ? `${b.width}px solid ${b.color}` : "none";
  const headStyle = sqlTableTextStyle(el, "header");
  const cellStyle = sqlTableTextStyle(el, "cells");
  const caption = sqlTableCaption(view, cols, totalCols);
  const frame = {
    width: "100%", height: "100%", background: "#fff", border: line,
    // CLIPPED, not scrollable: in present mode the layer takes no pointer events, so a scrollbar
    // would be furniture nobody can use. The cap plus the caption is the honest answer instead.
    overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: T.font,
  };
  if (!cols.length) {
    return (
      <div data-sqltable="1" data-sqltable-cols={0} style={{ ...frame, alignItems: "center", justifyContent: "center" }}>
        <span style={{ ...cellStyle, color: T.textFaint }}>No rows</span>
      </div>
    );
  }
  // `whiteSpace: nowrap` plus the inner div's ellipsis is what makes per-cell truncation VISIBLE
  // rather than a value cut off mid-string at the frame's edge. It needs `table-layout: fixed` to
  // work at all, which is also what makes the drawn column count the visible one.
  const box = (align) => ({
    border: line, padding: SQLTABLE_CELL_PAD, textAlign: align, verticalAlign: "top",
    lineHeight: SQLTABLE_LINE_H, overflow: "hidden",
  });
  const clip = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <div data-sqltable="1" data-sqltable-cols={cols.length} data-sqltable-rows={view.shown.length} style={frame}>
      {/* The table is the only thing that may shrink, and it clips; the caption below never does.
          That is what makes the caption structurally unclippable rather than merely arithmetically
          expected to fit — it used to be pushed outside `overflow: hidden` entirely. */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "hidden" }}>
        {/* `fixed` layout: the drawn columns divide the frame equally, so every column the grid
            draws is a column the audience can see, and a long value ellipsizes inside its own cell
            instead of pushing its neighbours off the slide. */}
        <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse" }}>
          {sqlTableHeaderOn(el) ? (
            <thead>
              <tr data-sqltable-header="1" style={{ height: SQLTABLE_ROW_H }}>
                {cols.map((c) => (
                  <th key={c.key} style={{ ...headStyle, ...box(c.align), background: SQLTABLE_HEADER_FILL }}>
                    <div style={clip}>{c.label}</div>
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {view.shown.map((row, i) => (
              <tr key={i} data-sqltable-zebra={sqlTableStriped(el, i) ? "1" : undefined}
                style={{ height: SQLTABLE_ROW_H, background: sqlTableRowFill(el, i) }}>
                {cols.map((c) => {
                  const cell = sqlTableCell(row, c);
                  return (
                    <td key={c.key} style={{ ...cellStyle, ...box(cell.align) }}>
                      <div style={clip} title={cell.text}>{cell.text}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? (
        <div data-sqltable-truncated="1" style={{
          flexShrink: 0, padding: SQLTABLE_CELL_PAD, fontSize: SQLTABLE_CAPTION_FS,
          color: SQLTABLE_CAPTION_INK, lineHeight: SQLTABLE_LINE_H,
          borderTop: line, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden",
        }}>{caption}</div>
      ) : null}
    </div>
  );
}


function ShapeContent({ el }) {
  const kind = el.shape || "rect";
  // Rect keeps the original div: borderRadius only ever applies here.
  if (kind === "rect") {
    return (
      <div style={{
        width: "100%", height: "100%",
        background: el.fill || "transparent",
        border: el.strokeWidth ? `${el.strokeWidth}px ${dashCss(el.strokeDash)} ${el.stroke || "#231f20"}` : "none",
        borderRadius: el.radius || 0,
      }} />
    );
  }
  // Everything else: one geometry stretched to the box. `non-scaling-stroke` keeps the border
  // an even `strokeWidth` px however non-uniformly the 100×100 viewBox is scaled.
  const sw = el.strokeWidth || 0;
  const paint = {
    fill: el.fill || "transparent",
    stroke: sw ? (el.stroke || "#231f20") : "none",
    strokeWidth: sw || undefined,
    vectorEffect: "non-scaling-stroke",
    ...(sw ? dashSvg(el.strokeDash) : null),
  };
  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
      {kind === "ellipse"
        ? <ellipse cx="50" cy="50" rx="50" ry="50" {...paint} />
        : <polygon points={SHAPE_POINTS[kind] || SHAPE_POINTS.diamond} {...paint} />}
    </svg>
  );
}

// One inline SVG spanning the element box. With NO viewBox, 1 user unit = 1 CSS px, so a
// no-marker solid line is pixel-identical to the div bar it replaced: full span along the
// orientation axis, `thickness` thick, centered across the box.
function LineContent({ el, w, h }) {
  const t = el.thickness || 2;
  const color = el.color || "#231f20";
  const bw = w != null ? w : el.w;
  const bh = h != null ? h : el.h;
  const vert = el.orientation === "v";
  const len = vert ? bh : bw;
  const cross = (vert ? bw : bh) / 2;
  const m = Math.max(6, t * 3); // marker footprint, ~3× the stroke
  const inset = (cap) => (cap === "arrow" ? m * 0.6 : 0);
  const a = inset(el.capStart), b = inset(el.capEnd);
  // Along-axis coordinates; `pt` maps (along, across) into the box for either orientation.
  const pt = (u, v) => (vert ? `${cross + v},${u}` : `${u},${cross + v}`);
  const marker = (cap, at, dir) => {
    if (!cap || cap === "none") return null;
    if (cap === "arrow") return <polygon points={`${pt(at, 0)} ${pt(at - dir * m, -m / 2)} ${pt(at - dir * m, m / 2)}`} fill={color} />;
    // Circle/square sit CENTRED on the endpoint, so the line simply runs under them.
    if (cap === "circle") return vert
      ? <circle cx={cross} cy={at} r={m / 2} fill={color} />
      : <circle cx={at} cy={cross} r={m / 2} fill={color} />;
    return vert
      ? <rect x={cross - m / 2} y={at - m / 2} width={m} height={m} fill={color} />
      : <rect x={at - m / 2} y={cross - m / 2} width={m} height={m} fill={color} />;
  };
  const [x1, y1] = vert ? [cross, a] : [a, cross];
  const [x2, y2] = vert ? [cross, len - b] : [len - b, cross];
  return (
    <svg width="100%" height="100%" style={{ display: "block", overflow: "visible" }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={t} {...(dashSvg(el.dash) || {})} />
      {marker(el.capStart, 0, -1)}
      {marker(el.capEnd, len, 1)}
    </svg>
  );
}

// Each chart is its own component so it owns its useSQLQuery hook instance.
// One shared empty array so a chart with no rows yet keeps a stable `rows` identity across
// renders — the present-mode query pool publishes `rows` by reference and would otherwise
// re-publish (and re-render every chart) on every tick.
const EMPTY_ROWS = [];

// A LIVE-SQL element's presentation, given rows and a load state — title, skeleton, error, and then
// either a chart or a grid. Split out of ChartBlock so present mode can draw from the shell's
// deck-wide query pool (one query per unique SQL, all started on load) instead of owning a hook per
// element. ChartBlock keeps the hook and stays the edit-mode path; both render this.
//
// The two live types share everything ABOVE the picture — a title, a loading pulse, and one error
// banner — so they share this component and differ only in the last line. That is what makes "the
// SQL table renders on all four surfaces" a consequence rather than four separate pieces of work.
const liveTitleStyle = (el) => resolveTextStyle(
  el.type === "sqltable"
    ? (isPlainRecord(el.textStyles) ? el.textStyles.title : null)
    : (el.chart && el.chart.text && el.chart.text.title),
  CHART_TEXT_DEFAULTS.title,
);
function ChartSurface({ el, rows, isLoading, isError, error }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      {el.title ? (
        <div style={{ ...liveTitleStyle(el), marginBottom: 4, fontFamily: T.font }}>
          {el.title}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        {/* The absolute box gives ResponsiveContainer concrete dimensions on first paint. */}
        <div style={{ position: "absolute", inset: 0 }}>
          {isLoading ? (
            <div className="animate-pulse" data-chart-loading="1" style={{ width: "100%", height: "100%", background: "#ececec", borderRadius: 6 }} />
          ) : isError ? (
            <div className="flex items-center justify-center gap-2" style={{ width: "100%", height: "100%", color: "#bc1200", fontSize: 12, padding: 12, textAlign: "center" }}>
              <AlertTriangle size={14} /> {String((error && error.message) || "query failed").slice(0, 200)}
            </div>
          ) : el.type === "sqltable" ? (
            <SQLTableGrid el={el} rows={rows} />
          ) : (
            <DynamicChart rows={rows} config={el.chart} />
          )}
        </div>
      </div>
    </div>
  );
}

function ChartBlock({ el, reportCols }) {
  const q = useSQLQuery(el.sql);
  const rows = Array.isArray(q.data) ? q.data : EMPTY_ROWS;
  useEffect(() => {
    if (!q.isSuccess) return;
    // `ran: true` is the third state the inspector needs. Without it a successful query returning
    // ZERO rows is indistinguishable from a query that has never run, and the panel said "Run the
    // query to list its columns" about a run that had just finished.
    // ONE definition of "numeric" for the whole framework — see isNumericCell. The chart inspector's
    // series picker and the SQL grid's default right-alignment now cannot disagree about a column.
    // The column list is the RESULT's, read the same way the grid reads it (the union of the row
    // keys, in result order) rather than off the first row alone.
    const cols = sqlTableResultColumns(rows);
    reportCols(el.id, { ran: true, cols, numericCols: numericColsOf(rows[0]) });
  }, [q.data, q.isSuccess, el.id, el.sql, reportCols]);
  return <ChartSurface el={el} rows={rows} isLoading={q.isLoading} isError={q.isError} error={q.error} />;
}

// ── Chrome primitives ───────────────────────────────────────────────────────
function IconBtn({ icon: Icon, title, onClick, active, disabled, danger, label }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", gap: 5, padding: label ? "5px 9px" : 6,
        background: active ? T.activeRow : hov && !disabled ? T.hover : "transparent",
        border: "none", borderRadius: 6, cursor: disabled ? "default" : "pointer",
        color: danger ? T.danger : active ? T.accent : disabled ? T.textFaint : T.textMut,
        fontSize: 11.5, fontWeight: 500, fontFamily: T.font,
        transition: `background ${T.ease}, color ${T.ease}`, whiteSpace: "nowrap",
      }}>
      {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
      {label}
    </button>
  );
}

// Save is deliberately LOUD and deliberately two-step: it shows how many edits are batched, and a
// click opens a confirmation (SaveDialog) rather than writing — a save rewrites the Dive and reloads.
function SaveButton({ count, busy, onClick }) {
  const [hover, setHover] = useState(false);
  const live = count > 0 && !busy;
  return (
    <button onClick={onClick} disabled={!live} title={busy ? "Saving…" : count ? `Save ${count} batched edit${count === 1 ? "" : "s"} to this Dive` : "No unsaved edits"}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
        background: live ? (hover ? "#4aa8e6" : T.accent) : T.inputBg, border: "none", borderRadius: 6,
        cursor: live ? "pointer" : "default", color: live ? "#ffffff" : T.textFaint,
        fontSize: 11.5, fontWeight: 600, fontFamily: T.font, whiteSpace: "nowrap",
        transition: `background ${T.ease}, color ${T.ease}`,
      }}>
      <Save size={14} strokeWidth={1.75} />
      {busy ? "Saving…" : "Save"}
      {count > 0 && !busy ? (
        <span style={{ background: "rgba(255,255,255,0.22)", borderRadius: 999, padding: "0 6px", fontSize: 10.5, fontVariantNumeric: "tabular-nums" }}>{count}</span>
      ) : null}
    </button>
  );
}

function inputBaseStyle(focus) {
  return {
    background: T.inputBg, color: T.textHi, border: `1px solid ${focus ? T.accent : "transparent"}`,
    boxShadow: focus ? "0 0 0 3px rgba(61,155,217,0.25)" : "none",
    borderRadius: 4, fontSize: 12, fontFamily: T.font, padding: "4px 7px", width: "100%",
    outline: "none", transition: `border-color ${T.ease}, box-shadow ${T.ease}`,
    fontVariantNumeric: "tabular-nums",
  };
}

function NumField({ label, value, onCommit, disabled, autoText }) {
  const [txt, setTxt] = useState(value == null ? "" : String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(value == null ? "" : String(value)); }, [value, focus]);
  const commit = () => {
    const n = parseFloat(txt);
    if (!isNaN(n) && n !== value) onCommit(R(n));
    // Re-sync from the CURRENT value unconditionally. A consumer that CLAMPS what it commits (the SQL
    // table's Max rows does, at the core's 200) leaves `value` unchanged, so the effect above has
    // nothing to react to and the rejected text stayed on screen — the field read 201 while the bag
    // held 200. When the commit IS accepted, `value` changes and the effect overwrites this.
    setTxt(value == null ? "" : String(value));
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 0, position: "relative", flex: 1, minWidth: 0 }}>
      <span style={{ position: "absolute", left: 7, fontSize: 10, color: T.textFaint, fontFamily: T.font, pointerEvents: "none" }}>{label}</span>
      <input value={autoText != null ? autoText : txt} disabled={disabled || autoText != null}
        onChange={(e) => setTxt(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); commit(); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
        style={{ ...inputBaseStyle(focus), paddingLeft: 22, color: autoText != null ? T.textFaint : T.textHi }} />
    </label>
  );
}

function TextInput({ value, onCommit, placeholder }) {
  const [txt, setTxt] = useState(value || "");
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(value || ""); }, [value, focus]);
  return (
    <input value={txt} placeholder={placeholder}
      onChange={(e) => setTxt(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => { setFocus(false); if (txt !== (value || "")) onCommit(txt); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
      style={inputBaseStyle(focus)} />
  );
}

// `allowNone` adds a clear-to-none affordance: an empty value shows a slashed swatch (click it
// to start from `noneDefault`) and an X button commits null. Without it the field behaves
// exactly as before.
const NONE_HIGHLIGHT = "#ffe98a";
function ColorField({ value, onCommit, allowNone, noneDefault }) {
  const empty = !!allowNone && (value == null || value === "");
  const blank = allowNone ? "" : "#000000";
  const [txt, setTxt] = useState(value == null || value === "" ? blank : value);
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setTxt(value == null || value === "" ? blank : value); }, [value, focus, blank]);
  const safe = /^#[0-9a-fA-F]{6}$/.test(txt) ? txt : "#000000";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
      {empty ? (
        <button title="No highlight — click to add one" onClick={() => onCommit(noneDefault || NONE_HIGHLIGHT)}
          style={{
            width: 22, height: 22, padding: 0, border: `1px solid ${T.panelBorder}`, borderRadius: 4, cursor: "pointer",
            background: `linear-gradient(to top right, transparent 45%, ${T.textFaint} 45%, ${T.textFaint} 55%, transparent 55%)`,
          }} />
      ) : (
        <input type="color" value={safe} onChange={(e) => { setTxt(e.target.value); onCommit(e.target.value); }}
          style={{ width: 22, height: 22, padding: 0, border: `1px solid ${T.panelBorder}`, borderRadius: 4, background: "transparent", cursor: "pointer" }} />
      )}
      <input value={txt} placeholder={allowNone ? "none" : undefined}
        onChange={(e) => setTxt(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false);
          if (allowNone && txt.trim() === "") onCommit(null);
          else if (/^#[0-9a-fA-F]{3,8}$/.test(txt)) onCommit(txt);
          else setTxt(value == null || value === "" ? blank : value);
        }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
        style={{ ...inputBaseStyle(focus), width: allowNone ? 58 : 76, flex: "none" }} />
      {allowNone ? (
        <button title="Clear highlight" onClick={() => onCommit(null)} disabled={empty}
          style={{
            border: "none", background: "transparent", padding: 2, display: "flex", flex: "none",
            color: empty ? T.textFaint : T.textMut, cursor: empty ? "default" : "pointer",
          }}>
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function Seg({ options, value, onChange, small }) {
  return (
    <div style={{ display: "flex", background: T.inputBg, borderRadius: 4, padding: 2, gap: 1, flex: 1 }}>
      {options.map((o) => {
        const active = o.k === value;
        const Icon = o.icon;
        return (
          <button key={o.k} title={o.title || o.label} onClick={() => onChange(o.k)}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 3,
              padding: small ? "3px 4px" : "4px 6px", border: "none", borderRadius: 3, cursor: "pointer",
              background: active ? "rgba(255,255,255,0.12)" : "transparent",
              color: active ? T.textHi : T.textMut, fontSize: 11, fontWeight: 500, fontFamily: T.font,
              transition: `background ${T.ease}, color ${T.ease}`,
            }}>
            {Icon ? <Icon size={12.5} strokeWidth={1.75} /> : o.label}
          </button>
        );
      })}
    </div>
  );
}

function SelectField({ value, options, onChange, placeholder, availableOptions }) {
  const items = availableOptions === undefined
    ? (options || []).map((option) => ({ value: option, label: option, missing: false }))
    : columnOptionsWithMissing(value, options, availableOptions);
  return (
    <select value={value == null ? "" : value} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      style={{ ...inputBaseStyle(false), cursor: "pointer", appearance: "auto", paddingRight: 2 }}>
      {placeholder != null && <option value="">{placeholder}</option>}
      {items.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

function ToggleRow({ label, value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 0" }}>
      <span style={{ fontSize: 12, color: T.textMut, fontFamily: T.font }}>{label}</span>
      <button onClick={() => onChange(!value)} title={label}
        style={{
          width: 28, height: 16, borderRadius: 999, border: "none", cursor: "pointer", position: "relative",
          background: value ? T.accent : T.inputBg, transition: `background ${T.ease}`,
        }}>
        <span style={{
          position: "absolute", top: 2, left: value ? 14 : 2, width: 12, height: 12, borderRadius: 999,
          background: "#fff", transition: `left ${T.ease}`,
        }} />
      </button>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ padding: "10px 12px", borderBottom: `1px solid ${T.panelBorder}` }}>
      {title ? (
        <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textFaint, marginBottom: 8, fontFamily: T.font }}>
          {title}
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

// `labelWidth` is the label slot, 52px unless a caller needs more: the slot is fixed so every row
// in a section lines its control up with the others, which also means a label longer than the slot
// overflows into the control instead of wrapping. A section with a long label widens the slot for
// ALL of its rows (see SlideSection) rather than letting one row disagree with its neighbours.
const ROW_LABEL_W = 52;
function Row({ label, labelWidth, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label ? <span style={{ fontSize: 11.5, color: T.textMut, width: labelWidth || ROW_LABEL_W, flex: "none", fontFamily: T.font }}>{label}</span> : null}
      {children}
    </div>
  );
}

// One square B/I/U toggle. Text glyphs, not icons — the styling itself is the label.
function StyleToggle({ glyph, title, active, onClick, glyphStyle }) {
  return (
    <button title={title} onClick={onClick}
      style={{
        width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
        border: "none", borderRadius: 3, cursor: "pointer", flex: "none",
        background: active ? T.activeRow : "transparent",
        color: active ? T.accent : T.textMut,
        fontSize: 12, lineHeight: 1, fontFamily: T.font,
        transition: `background ${T.ease}, color ${T.ease}`,
      }}>
      <span style={glyphStyle}>{glyph}</span>
    </button>
  );
}

// ── The ONE text-style control set. Every text surface uses it: text elements, the chart
// title, axis labels, axis ticks. Surfaces with richer options (a text element's h1/h2/h3
// level and numeric weight, an axis's tickFormat/tickAngle) render those alongside it.
// `onPatch` is granular — one key per call — so callers can prune null/absent values.
function TextStyleControls({ value, defaults, onPatch, showAlign = true, showSize = true }) {
  const ts = value || {};
  const d = defaults || {};
  const bold = ts.bold != null ? !!ts.bold : (d.fontWeight != null && d.fontWeight >= 600);
  return (
    <>
      {showSize ? (
        <Row label="Size">
          <NumField label="px" value={ts.fontSize != null ? ts.fontSize : d.fontSize}
            onCommit={(v) => onPatch({ fontSize: v })} />
        </Row>
      ) : null}
      <Row label="Style">
        <div style={{ display: "flex", gap: 1, background: T.inputBg, borderRadius: 4, padding: 2 }}>
          <StyleToggle glyph="B" title="Bold" active={bold} glyphStyle={{ fontWeight: 700 }}
            onClick={() => onPatch({ bold: !bold })} />
          <StyleToggle glyph="I" title="Italic" active={!!ts.italic} glyphStyle={{ fontStyle: "italic", fontFamily: "Georgia, 'Times New Roman', serif" }}
            onClick={() => onPatch({ italic: ts.italic ? null : true })} />
          <StyleToggle glyph="U" title="Underline" active={!!ts.underline} glyphStyle={{ textDecoration: "underline" }}
            onClick={() => onPatch({ underline: ts.underline ? null : true })} />
        </div>
      </Row>
      {showAlign ? (
        <Row label="Align">
          <Seg small value={ts.align || d.align || "left"} onChange={(v) => onPatch({ align: v })}
            options={[{ k: "left", icon: AlignLeft }, { k: "center", icon: AlignCenter }, { k: "right", icon: AlignRight }]} />
        </Row>
      ) : null}
      <Row label="Color">
        <ColorField value={ts.color || d.color || "#231f20"} onCommit={(v) => onPatch({ color: v })} />
      </Row>
      <Row label="Highlight">
        <ColorField allowNone value={ts.highlight != null ? ts.highlight : null} onCommit={(v) => onPatch({ highlight: v })} />
      </Row>
    </>
  );
}

// ── Edit toggle: the single mode control. Rendered at the SAME fixed top-left
// position in both the published view and the editor, so it never moves between modes.
function EditToggle({ on, onChange }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={() => onChange(!on)} title={on ? "Turn editing off" : "Turn editing on"}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
        borderRadius: 999, border: "none", cursor: "pointer",
        position: "fixed", left: 12, top: 10, zIndex: 1300,
        background: "rgba(35,35,39,0.88)",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)", opacity: hov ? 1 : 0.92,
        transition: `opacity ${T.ease}`,
      }}>
      <Pencil size={13} color={on ? T.accent : "#fff"} strokeWidth={1.75} />
      <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", fontFamily: T.font, letterSpacing: "0.01em" }}>
        Edit
      </span>
      <span aria-hidden style={{
        width: 28, height: 16, borderRadius: 999, position: "relative", display: "inline-block",
        background: on ? T.accent : "rgba(255,255,255,0.28)", transition: `background ${T.ease}`,
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12,
          borderRadius: 999, background: "#fff", transition: `left ${T.ease}`,
          boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
        }} />
      </span>
    </button>
  );
}

// ── Viewport cluster: scroll-mode toggle + zoom controls ────────────────────
// Fixed to the bottom-right of the canvas area in BOTH modes; in edit mode it shifts left
// with the live inspector width. Same dark blur pill as EditToggle.
function ClusterBtn({ icon: Icon, title, onClick, label, active, disabled, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: label != null ? "4px 8px" : 5, minWidth: label != null ? 44 : undefined,
        background: hov && !disabled ? "rgba(255,255,255,0.10)" : "transparent",
        border: "none", borderRadius: 999, cursor: disabled ? "default" : "pointer",
        color: disabled ? "rgba(255,255,255,0.35)" : active ? T.accent : "#fff",
        fontSize: 11.5, fontWeight: 600, fontFamily: T.font, whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums", transition: `background ${T.ease}, color ${T.ease}`,
      }}>
      {Icon ? <Icon size={13} strokeWidth={1.75} /> : null}
      {label}
      {children}
    </button>
  );
}

// Zoom % readout: double-click to type an exact percentage (Enter commits, Esc cancels).
function ZoomReadout({ zoom, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [txt, setTxt] = useState("");
  if (!editing) {
    return (
      <button title="Zoom — double-click to type a %"
        onDoubleClick={() => { setTxt(String(Math.round(zoom * 100))); setEditing(true); }}
        style={{
          border: "none", background: "transparent", color: T.textMut, cursor: "text",
          fontSize: 11, fontFamily: T.font, fontVariantNumeric: "tabular-nums",
          padding: "4px 6px", borderRadius: 6, minWidth: 40, textAlign: "center",
        }}>
        {Math.round(zoom * 100)}%
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const n = parseFloat(txt);
    if (isFinite(n) && n > 0) onCommit(n);
  };
  return (
    <input autoFocus value={txt}
      onChange={(e) => setTxt(e.target.value.replace(/[^0-9.]/g, ""))}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      onBlur={commit}
      style={{
        width: 44, border: `1px solid ${T.accent}`, background: T.inputBg, color: T.textHi,
        fontSize: 11, fontFamily: T.font, fontVariantNumeric: "tabular-nums",
        padding: "3px 4px", borderRadius: 4, textAlign: "center", outline: "none",
      }} />
  );
}

// FIXED to the viewport's bottom right, inside the right pane's edge. `bottomInset` is the height
// of whatever else owns the bottom of the canvas column — the speaker-notes strip, open or closed.
// Without it the cluster sat ON the notes field (a 245 x 30 px overlap, with the Fit-all button
// winning the hit test over the textarea) and, with the strip closed, on its slide label. Moving
// the cluster rather than padding the strip keeps the strip's full width usable and costs the
// canvas nothing at small viewport heights, where reserving a cluster-shaped hole inside a 26px
// header row is not possible anyway.
function ViewportCluster({ editMode, inspectorWidth, bottomInset, zoom, scrollZoom, onToggleScrollZoom, onZoomIn, onZoomOut, onSetZoomPct, onPreset }) {
  return (
    <div data-viewport-cluster="1" style={{
      position: "fixed", right: editMode ? inspectorWidth + 12 : 12, bottom: 12 + (bottomInset || 0), zIndex: 1300,
      display: "flex", alignItems: "center", gap: 1, padding: "3px 5px",
      borderRadius: 999, background: "rgba(35,35,39,0.88)",
      backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
    }}>
      <ClusterBtn icon={Mouse} title="Scroll wheel zooms (off: scrolls)" active={scrollZoom} onClick={onToggleScrollZoom}>
        <span aria-hidden style={{
          width: 22, height: 12, borderRadius: 999, position: "relative", display: "inline-block", flex: "none",
          background: scrollZoom ? T.accent : "rgba(255,255,255,0.28)", transition: `background ${T.ease}`,
        }}>
          <span style={{
            position: "absolute", top: 2, left: scrollZoom ? 12 : 2, width: 8, height: 8,
            borderRadius: 999, background: "#fff", transition: `left ${T.ease}`,
          }} />
        </span>
      </ClusterBtn>
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.18)", margin: "0 4px" }} />
      <ClusterBtn icon={Minus} title="Zoom out" onClick={onZoomOut} disabled={zoom <= ZOOM_MIN + 1e-6} />
      <ZoomReadout zoom={zoom} onCommit={onSetZoomPct} />
      <ClusterBtn icon={Plus} title="Zoom in" onClick={onZoomIn} disabled={zoom >= ZOOM_MAX - 1e-6} />
      <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.18)", margin: "0 4px" }} />
      <ClusterBtn icon={MoveHorizontal} title="Fit width (used space)" onClick={() => onPreset("w")} />
      <ClusterBtn icon={MoveVertical} title="Fit height (used space)" onClick={() => onPreset("h")} />
      <ClusterBtn icon={Maximize} title="Fit all content" onClick={() => onPreset("all")} />
    </div>
  );
}

// ── TopBar ──────────────────────────────────────────────────────────────────
function ByteMeter({ bytes }) {
  const kb = bytes / 1024;
  const pct = Math.min(100, (bytes / 65536) * 100);
  const color = bytes >= 49152 ? T.danger : bytes >= 16384 ? "#e8a13c" : T.accent;
  return (
    <div title="Overrides size vs the 64 KB dive-state limit" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 60, height: 4, background: T.inputBg, borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, transition: `width ${T.ease}` }} />
      </div>
      <span style={{ fontSize: 10.5, color: T.textFaint, fontVariantNumeric: "tabular-nums", fontFamily: T.font, whiteSpace: "nowrap" }}>
        {kb < 1 ? bytes + " B" : kb.toFixed(1) + " KB"} / 64 KB
      </span>
    </div>
  );
}

// Compact icon-only segmented control for the toolbar (the inspector's `Seg` stretches to fill).
function ToolSeg({ value, onChange, options }) {
  return (
    <div style={{ display: "flex", background: T.inputBg, borderRadius: 6, padding: 2, gap: 1, flex: "none" }}>
      {options.map((o) => {
        const active = o.k === value;
        const Icon = o.icon;
        return (
          <button key={o.k} title={o.title} onClick={() => onChange(o.k)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 22, border: "none", borderRadius: 4, cursor: "pointer",
              background: active ? "rgba(255,255,255,0.12)" : "transparent",
              color: active ? T.accent : T.textMut,
              transition: `background ${T.ease}, color ${T.ease}`,
            }}>
            <Icon size={13.5} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

// The Shape button opens a small anchored menu instead of inserting a rectangle outright.
// It stops its own pointer events so a click never reaches the canvas, and closes on pick,
// outside pointerdown or Escape.
function ShapeMenu({ onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const [hov, setHov] = useState(null);
  const [at, setAt] = useState(null); // viewport coords of the anchor's bottom-left, while open
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current || !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "none" }} onPointerDown={(e) => e.stopPropagation()}>
      <IconBtn icon={Square} label="Shape" title="Add shape" active={open} disabled={disabled}
        onClick={(e) => {
          // The menu is FIXED, not absolute, so the top bar's scrolling middle cannot clip it: an
          // absolutely positioned popup hanging 6px below a 48px bar is entirely outside that bar's
          // content box, and a scroll container clips exactly that. Fixed means the anchor has to be
          // measured, which is this one rect read on open.
          const box = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
          setAt(box ? { left: box.left, top: box.bottom + 6 } : null);
          setOpen((v) => !v);
        }} />
      {open && !disabled ? (
        <div style={{
          position: at ? "fixed" : "absolute", top: at ? at.top : "calc(100% + 6px)", left: at ? at.left : 0,
          minWidth: 152, padding: 4, zIndex: 1400,
          background: "rgba(29,31,36,0.96)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          border: `1px solid ${T.panelBorder}`, borderRadius: 8, boxShadow: T.panelShadow,
        }}>
          {SHAPE_KINDS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.k} title={s.label}
                onMouseEnter={() => setHov(s.k)} onMouseLeave={() => setHov((h) => (h === s.k ? null : h))}
                onClick={() => { setOpen(false); onPick(s.k); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px",
                  background: hov === s.k ? T.hover : "transparent", border: "none", borderRadius: 5,
                  cursor: "pointer", color: hov === s.k ? T.textHi : T.textMut,
                  fontSize: 11.5, fontWeight: 500, fontFamily: T.font, textAlign: "left",
                  transition: `background ${T.ease}, color ${T.ease}`,
                }}>
                {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
                {s.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Panel toggles ───────────────────────────────────────────────────────────
// One button per side panel, and THE ICON NEVER CHANGES: the icon names the PANEL (Film = the slide
// rail, Layers = the layers tree, PanelRight = the inspector) and the button's ACTIVE styling — the
// accent glyph on the tinted active row, the same idiom the Select/Hand segment and the wheel-zoom
// switch already use in this editor — says whether that panel is on screen right now.
//
// A swapped icon (Eye/EyeOff, or a chevron that flips) was rejected on two counts. It names the
// ACTION, so "does this eye mean the panel is visible, or that clicking makes it visible?" is
// genuinely ambiguous with nothing on screen to disambiguate it; and `EyeOff` already means "this
// SLIDE is marked hidden" in this file (the rail badge, the slide menu), so reusing it here would
// hang two unrelated meanings on one glyph. So: a fixed icon for identity, fill for state,
// `aria-pressed` for the same fact non-visually, and one NAME (title and aria-label, always equal)
// that spells out what the click does.
//
// `holds` is the one extra signal, and it exists for exactly one situation: this panel is hidden and
// it is the only place something can be reached from (see inspectorHiddenHolds). It carries BOTH
// halves — the accent dot, and the words. The dot is `aria-hidden` and can only ever be decoration,
// so the phrase goes into the button's own name; the earlier version's name was byte-identical with
// and without the dot, which left a screen-reader user with no equivalent at all.
function PanelToggle({ icon: Icon, panelKey, label, shown, onClick, holds }) {
  const [hov, setHov] = useState(false);
  const dot = !shown && !!holds;
  const name = (shown ? "Hide" : "Show") + " the " + label + " panel"
    + (dot ? " — it is the only place to reach " + holds : "");
  return (
    <button data-panel-toggle={panelKey} aria-pressed={shown} aria-label={name} title={name}
      onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
        padding: 6, border: "none", borderRadius: 6, cursor: "pointer", flex: "none",
        background: shown ? T.activeRow : hov ? T.hover : "transparent",
        color: shown ? T.accent : T.textMut,
        transition: `background ${T.ease}, color ${T.ease}`,
      }}>
      <Icon size={14} strokeWidth={1.75} />
      {dot ? (
        <span data-panel-toggle-dot={panelKey} aria-hidden style={{
          position: "absolute", right: 3, top: 3, width: 5, height: 5, borderRadius: 999,
          background: T.accent, pointerEvents: "none",
        }} />
      ) : null}
    </button>
  );
}

// THE BAR IS THREE REGIONS, and that is a fix rather than a tidy-up. It is `flex` / `nowrap` inside
// a `position: fixed` root that cannot scroll, and its content pins at ~1224px, so below that the
// right end was simply CLIPPED — no scroll, no wrap. The Inspector toggle is the bar's last child,
// so it went first, and it is the ONLY affordance for a panel that can be hidden: at 1224 the one
// control that brings the inspector back was off screen (and, being clipped rather than unmounted,
// still Tab-focusable — focus landing on an invisible button). A dive runs in an iframe narrower
// than the window, so this is a width real viewers hit.
//
// So: an unshrinkable group at each end for the panel toggles — the two controls that change what
// the rest of the window IS, and the two whose loss is unrecoverable — and a `flex: 1, minWidth: 0`
// middle that scrolls horizontally for everything else. Chosen over the two alternatives because
// `flexShrink: 0` alone does not help (nothing here shrinks; the bar overflows and the tail is cut)
// and folding Save/Copy/Reset into a menu needs a measured width threshold, a new component, and a
// judgement about which controls are second-class. Scrolling costs nothing at full width, needs no
// threshold, and leaves nothing unreachable at ANY width: a clipped control inside a scroll
// container is scrolled into view when it takes focus, which is the half `overflow: visible` could
// not give. ShapeMenu's dropdown had to become `position: fixed` for this — an absolutely positioned
// popup inside a scroll container is clipped by it.
function TopBar({ onAdd, addDisabled, onUndo, onRedo, canUndo, canRedo, bytes, onSave, saveCount, saveBusy, onCopy, onReset, stale, onClearStale, onPresent, tool, onToolChange, panelsShown, onTogglePanel, isDeck, inspectorHolds, layersHolds, insetLeft }) {
  const [resetArmed, setResetArmed] = useState(false);
  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), 2500);
    return () => clearTimeout(t);
  }, [resetArmed]);
  const divider = <div style={{ width: 1, height: 18, background: T.panelBorder, margin: "0 4px" }} />;
  return (
    <div style={{
      // `insetLeft` clears a fixed top-left pill where one exists. A DECK has none any more (the
      // floating Edit toggle went with the reading view), so its bar starts at the panel toggles —
      // which is the point of putting them here: the first thing in the header is what the header is
      // sitting next to. A v1 scene still carries the Edit pill, so it still needs the gutter.
      height: 48, flex: "none", display: "flex", alignItems: "center", gap: 4,
      padding: "0 12px", paddingLeft: insetLeft,
      background: "rgba(29,31,36,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      borderBottom: `1px solid ${T.panelBorder}`, zIndex: 1200, position: "relative",
    }}>
      {/* LEFTMOST, because they are the only controls that change what the rest of the window is.
          Slides first, then Layers — the same left-to-right order as the panels themselves, so the
          button that hides a column sits over the column it hides. ANCHORED: outside the scrolling
          middle, and unshrinkable, so no amount of content can push them out of the bar. */}
      <div data-topbar-anchor="left" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
        {isDeck ? (
          <PanelToggle icon={Film} panelKey="rail" label="Slides" shown={panelsShown.rail}
            onClick={() => onTogglePanel("rail")} />
        ) : null}
        <PanelToggle icon={Layers} panelKey="left" label="Layers" shown={panelsShown.left}
          holds={layersHolds} onClick={() => onTogglePanel("left")} />
      </div>
      {/* THE COLLAPSIBLE MIDDLE. Everything here is recoverable — a tool, an insert, undo, the save
          cluster — so this is what gives when the bar runs out of room, and it gives by SCROLLING
          rather than by being cut off the end. `ed-scroll` is the same 8px thumb the panes use. */}
      <div className="ed-scroll" data-topbar-scroll="1" style={{
        flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4,
        overflowX: "auto", overflowY: "hidden",
      }}>
      {divider}
      <ToolSeg value={tool} onChange={onToolChange}
        options={[
          { k: "select", icon: MousePointer2, title: "Select (V)" },
          { k: "hand", icon: Hand, title: "Hand — drag to pan (H, or hold Space)" },
        ]} />
      {divider}
      {/* `addDisabled` is the deck-with-no-live-slide state: there is no slide to stamp, so the
          Add controls go inert rather than minting an element that belongs to nowhere. */}
      <IconBtn icon={Type} label="Text" title="Add text" disabled={addDisabled} onClick={() => onAdd("text")} />
      <ShapeMenu onPick={(kind) => onAdd("shape", { shape: kind })} disabled={addDisabled} />
      <IconBtn icon={Minus} label="Line" title="Add line" disabled={addDisabled} onClick={() => onAdd("line")} />
      <IconBtn icon={TableIcon} label="Table" title="Add table" disabled={addDisabled} onClick={() => onAdd("table")} />
      {/* Live-data slides are the reason this product exists, so a chart is a first-class insert
          and not something you can only inherit from the baked scene or paste from another slide.
          It lands with a runnable query already in it — see newChartElement. */}
      <IconBtn icon={BarChart3} label="Chart" title="Add chart" disabled={addDisabled} onClick={() => onAdd("chart")} />
      {/* Its own insert, next to Chart and not folded into Table: a SQL table is a different element
          type from the hand-typed one, and the whole point of the product is that this is a
          first-class thing to put on a slide. It lands with a runnable query already in it. */}
      <IconBtn icon={Database} label="SQL table" title="Add a SQL data table — rows come from a live query" disabled={addDisabled} onClick={() => onAdd("sqltable")} />
      {divider}
      <IconBtn icon={Undo2} title="Undo (⌘Z)" onClick={onUndo} disabled={!canUndo} />
      <IconBtn icon={Redo2} title="Redo (⇧⌘Z)" onClick={onRedo} disabled={!canRedo} />
      {/* Deck only: a v1 scene has no slides to present. Starts on the slide being edited, which is
          the whole point of the button — "does this land?" is a question about THIS slide. */}
      {onPresent ? (
        <>
          {divider}
          <IconBtn icon={Play} label="Present" title="Present from this slide" onClick={onPresent} />
        </>
      ) : null}
      {stale ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 10, padding: "4px 10px", background: "rgba(232,161,60,0.15)", borderRadius: 6 }}>
          <AlertTriangle size={13} color="#e8a13c" />
          <span style={{ fontSize: 11.5, color: "#e8a13c", fontFamily: T.font }}>Edits from an older version are being ignored</span>
          <button onClick={onClearStale} style={{ border: "none", background: "transparent", color: T.accent, fontSize: 11.5, cursor: "pointer", fontFamily: T.font, padding: 0 }}>
            Clear stale edits
          </button>
        </div>
      ) : null}
      <div style={{ flex: 1 }} />
      <ByteMeter bytes={bytes} />
      {divider}
      <IconBtn icon={Copy} label="Copy JSON" title="Copy overrides JSON (for bake-back)" onClick={onCopy} />
      <IconBtn icon={RotateCcw} label={resetArmed ? "Really reset?" : "Reset edits"} danger={resetArmed}
        title="Discard all overrides and return to the saved scene"
        onClick={() => { if (resetArmed) { setResetArmed(false); onReset(); } else setResetArmed(true); }} />
      </div>
      {/* FAR RIGHT, over the panel it hides — the mirror of Slides/Layers on the left, and anchored
          for the same reason: this button is the only way an inspector the author hid comes back, so
          it is the one control in the bar that must never be the thing that gets cut. `holds` is the
          "there is something in there you cannot reach any other way" signal, in a dot and in the
          button's name; hiding the inspector deliberately does NOT re-open it (see the root). */}
      <div data-topbar-anchor="right" style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
        {divider}
        {/* Anchored with the Inspector toggle so the one control that writes is never scrolled away. */}
        <SaveButton count={saveCount} busy={saveBusy} onClick={onSave} />
        {divider}
        <PanelToggle icon={PanelRight} panelKey="right" label="Inspector" shown={panelsShown.right}
          onClick={() => onTogglePanel("right")} holds={inspectorHolds} />
      </div>
    </div>
  );
}

// Zero-layout-width separator overlaid on a pane's inner edge. Pointer capture keeps the whole
// drag on this handle, so it cannot start a canvas marquee, pan, or element gesture.
function PaneResizeHandle({ side, width, onResize, onReset, label, min = PANE_MIN_WIDTH, max = PANE_MAX_WIDTH }) {
  const dragRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);
  const direction = side === "left" ? 1 : -1;
  const finish = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    setActive(false);
    const node = event && event.currentTarget;
    if (node && node.hasPointerCapture && node.hasPointerCapture(drag.pointerId)) node.releasePointerCapture(drag.pointerId);
  }, []);
  return (
    <div style={{ width: 0, flex: "none", position: "relative", zIndex: 1250 }}>
      <div role="separator" aria-orientation="vertical" aria-label={"Resize the " + (label || side) + " panel"}
        aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(width)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setActive(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || event.pointerId !== drag.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          onResize(drag.startWidth + direction * (event.clientX - drag.startX));
        }}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { dragRef.current = null; setActive(false); }}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onReset(); }}
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
        style={{
          position: "absolute", top: 0, bottom: 0, left: -3, width: 6,
          cursor: "col-resize", touchAction: "none", userSelect: "none",
          background: active ? "rgba(61,155,217,0.5)" : hovered ? "rgba(61,155,217,0.22)" : "transparent",
          boxShadow: active ? "0 0 0 1px rgba(61,155,217,0.18)" : "none",
          transition: active ? "none" : `background ${T.ease}`,
        }} />
    </div>
  );
}

// ── Filmstrip (the slide rail) ──────────────────────────────────────────────
// The deck's navigator: one numbered thumbnail per slide, left of the layers tree, full height,
// its own scroll. It holds NO slide logic — every operation is one call into the root's glue, which
// is one call into a pure op (buildNewSlide / buildDuplicatedSlide / buildDeletedSlide /
// buildSlidePatched / buildReorderedSlides). That is why reorder needed no new op: a drag ends in
// one `moveSlide(toIndex, slideId)`.
//
// Query-backed element types never mount here. A thumbnail is 70px wide: a live ChartBlock there
// would draw an unreadable Recharts tree AND open one useSQLQuery per OFF-SCREEN slide, so a
// 200-slide deck would fire 200 queries to render nothing legible. Every other type goes through
// the same pure content renderers the canvas uses.
//
// Both live types are therefore drawn as INERT CHROME instead — the parts of them that are authored
// rather than queried. A SQL table's structure is authored: a header band over striped rows inside
// its own border, so ThumbSqlTable draws the real grid with the cells left empty. A chart's SHAPE is
// its data, so ThumbChart draws no shape: it draws the frame, the gridlines, the legend and the
// series colours the author configured, plus a uniform kind glyph that is a pictogram no dataset
// could produce. Neither issues a query — a preview rather than a placeholder, and the only reason
// an author can tell which slide holds which picture.
//
// There is consequently NO set of stubbed types any more (the old THUMB_STUBBED). The last entry in
// it was `chart`; `sqltable` had already stopped being one and lingered as dead code with a comment
// that said the opposite of what the code did. The guardrail that actually holds is ThumbElement's
// final branch: a type this build does not know draws a grey block and issues nothing.
// One shared empty array so a slide with no elements does not break the thumbnail memo.
const EMPTY_LEAVES = [];

// A thumbnail element is a picture: no hooks, no pointer handlers, no editing. TableContent is
// reused with NO callbacks, which is what leaves it handler-free (its onDoubleClick is guarded on
// onEnterCell for exactly this caller); everything else here is already a pure render.
// `surface` is opt-in here for the same reason it is in TextContent: "the rail shows ghosts" was
// true only by accident of the rail being this renderer's only caller. Now it is declared.
// The one exception to "no hooks" above, and it buys what a rail cannot fake: a thumbnail drawing a
// fixed box at its authored size would show text overflowing a slide that does not. The module-level
// cache means the rail usually gets the canvas's answer for free.
function ThumbText({ el, surface }) {
  const fit = useAutofit(el, el.w, el.h, null);
  return (
    <>
      {fit.probe}
      <TextBody el={el} scale={fit.scale} ghost={ghostVisible(el, surface)} copyLive={false} />
    </>
  );
}

// The rail's SQL table: the grid's own chrome, no text and no query. Drawn from the same border
// resolver, the same fills and the same row height the real grid uses, so the preview cannot drift
// away from the thing it is previewing.
function ThumbSqlTable({ el }) {
  const b = normTableBorder(el.border);
  const line = b.on ? `${b.width}px solid ${b.color}` : "none";
  const bands = sqlTableThumbBands(el);
  return (
    <div data-thumb-stub="sqltable" style={{ width: "100%", height: "100%", background: "#fff", border: line, overflow: "hidden" }}>
      {new Array(bands).fill(null).map((_, i) => {
        const band = sqlTableThumbBand(el, i);
        return <div key={i} data-thumb-band={band.header ? "header" : band.fill ? "zebra" : "plain"}
          style={{ height: SQLTABLE_ROW_H, borderBottom: line, background: band.fill || "transparent" }} />;
      })}
    </div>
  );
}

// The rail's chart, and the answer to "which slide holds which chart" — which a single grey block
// could not give. Two rules make it honest:
//
//   1. NOTHING HERE IS INVENTED. Every mark comes off `el.chart`: the frame and its gridlines exist
//      because `grid.show` says so, the swatch row exists (and sits where it sits) because
//      `legend.show` / `legend.position` say so, and every colour is the series' own authored
//      `color`, falling back to PALETTE by index exactly as DynamicChart does. A chart with no
//      series declared gets the frame and no glyph, because there is nothing yet to draw.
//   2. THE GLYPH IS UNIFORM BY CONSTRUCTION. A bar chart's shape IS its data, so the rail draws no
//      shape: equal-height bars, evenly spaced parallel diagonals, dots at fixed stops. A real
//      dataset does not come out uniform, so the glyph cannot be misread as this chart's numbers —
//      it says "bars" / "lines" / "dots", which is the kind, which IS authored (`chart.kind`).
//
// One SVG, no hooks, no query, no Recharts. viewBox 0-100 with preserveAspectRatio="none" is what
// makes it survive the rail: every length is a PERCENTAGE of the element, so the glyph keeps its
// proportions from a 46x26 thumbnail up to a 214x120 one, where a px length would vanish under the
// page-to-thumbnail scale the way a 2px Recharts stroke would.
const THUMB_CHART_SERIES_MAX = 5;   // past this the glyph is mush at 46px; the colours still lead
const THUMB_CHART_LEGEND_H = 13;    // the swatch band, in the same 0-100 units
const THUMB_CHART_AXIS = "#b6bcc4"; // the frame: a step darker than the grid, so it reads as chrome
const THUMB_CHART_GRID = "#e4e4e4"; // the stroke DynamicChart's CartesianGrid uses
function ThumbChart({ el }) {
  const c = (el && el.chart) || {};
  const kind = c.kind || "bar";
  const all = Array.isArray(c.series) ? c.series : [];
  const colors = all.slice(0, THUMB_CHART_SERIES_MAX).map((s, i) => (s && s.color) || PALETTE[i % PALETTE.length]);
  // The same default DynamicChart applies: a legend appears unasked only for a multi-series chart.
  const legend = c.legend || { show: all.length > 1, position: "top" };
  const legendOn = !!legend.show && colors.length > 0;
  const atBottom = legend.position === "bottom";
  const bandTop = legendOn && !atBottom ? THUMB_CHART_LEGEND_H : 0;
  const bandBot = legendOn && atBottom ? 100 - THUMB_CHART_LEGEND_H : 100;
  // The plot frame: room on the left and below for the axes the real chart reserves ticks for.
  const x0 = 9, x1 = 98, y0 = bandTop + 3, y1 = bandBot - 6;
  const pw = x1 - x0, ph = y1 - y0;
  const n = colors.length;
  const horizontal = kind === "barH";
  const marks = [];
  if (kind === "bar" || horizontal) {
    // Bars are drawn as a fixed handful of marks CYCLING the authored colours, not one mark per
    // series: one series drawn as one bar is a solid block, which is the grey rectangle this whole
    // component exists to escape. The count is part of the pictogram; the HEIGHTS are all equal,
    // which is the part that matters — unequal ones would be this chart's numbers, invented.
    const reps = n <= 2 ? 3 : n <= 4 ? 2 : 1;
    const slots = n * reps;
    const across = horizontal ? ph : pw;
    for (let j = 0; j < slots; j++) {
      const a = (horizontal ? y0 : x0) + across * (j / slots) + across / slots * 0.19;
      const thick = across / slots * 0.62;
      marks.push(horizontal
        ? <rect key={j} x={x0} y={a} width={pw * 0.82} height={thick} fill={colors[j % n]} />
        : <rect key={j} x={a} y={y1 - ph * 0.82} width={thick} height={ph * 0.82} fill={colors[j % n]} />);
    }
  } else for (let i = 0; i < n; i++) {
    // One lane per series, stacked down y, and inside it one diagonal of the SAME slope as every
    // other lane's: parallel is the tell that these are symbols and not a plotted path.
    const fill = colors[i];
    const laneTop = y0 + ph * (i / n) + ph / n * 0.19;
    const laneBot = laneTop + ph / n * 0.62;
    const at = (t) => [x0 + pw * t, laneBot - (laneBot - laneTop) * t];
    if (kind === "scatter") {
      for (const t of [0.08, 0.36, 0.64, 0.92]) {
        const [cx, cy] = at(t);
        marks.push(<circle key={i + "-" + t} cx={cx} cy={cy} r={2.8} fill={fill} />);
      }
    } else {
      if (kind === "area") {
        marks.push(<polygon key={i + "f"} fill={fill} fillOpacity={0.25}
          points={`${x0},${laneBot} ${x1},${laneTop} ${x1},${laneBot}`} />);
      }
      marks.push(<line key={i} x1={x0} y1={laneBot} x2={x1} y2={laneTop} stroke={fill} strokeWidth={3} />);
    }
  }
  return (
    <svg data-thumb-chart={kind} width="100%" height="100%" viewBox="0 0 100 100"
      preserveAspectRatio="none" style={{ display: "block", overflow: "hidden" }}>
      {legendOn ? colors.map((fill, i) => (
        <rect key={"L" + i} x={x0 + i * 11} y={atBottom ? bandBot + 3 : 3} width={7} height={7} fill={fill} />
      )) : null}
      {c.grid && c.grid.show === false ? null : [1, 2].map((k) => (horizontal
        ? <line key={k} x1={x0 + pw * (k / 3)} y1={y0} x2={x0 + pw * (k / 3)} y2={y1} stroke={THUMB_CHART_GRID} strokeWidth={1} />
        : <line key={k} x1={x0} y1={y0 + ph * (k / 3)} x2={x1} y2={y0 + ph * (k / 3)} stroke={THUMB_CHART_GRID} strokeWidth={1} />
      ))}
      {marks}
      <path d={`M ${x0} ${y0} L ${x0} ${y1} L ${x1} ${y1}`} fill="none" stroke={THUMB_CHART_AXIS} strokeWidth={1.4} />
    </svg>
  );
}

function ThumbElement({ el, imageMap, surface }) {
  const h = el.h === "auto" ? undefined : el.h;
  const content = el.type === "sqltable"
    ? <ThumbSqlTable el={el} />
    : el.type === "chart"
    ? <ThumbChart el={el} />
    // The rail is edit-mode chrome, so it passes surface="thumb" and ghosts: a slide freshly
    // stamped from a layout would otherwise have a completely blank thumbnail and hide the layout
    // the author just picked.
    : el.type === "text" ? <ThumbText el={el} surface={surface} />
    : el.type === "shape" ? <ShapeContent el={el} />
    : el.type === "line" ? <LineContent el={el} w={el.w} h={h} />
    : el.type === "image" ? <ImageContent el={el} imageMap={imageMap} crop={normCrop(el.crop)} />
    : el.type === "table" ? <TableContent el={el} editing={false} />
    // An unknown type is a future element this build cannot draw; a grey block says "something is
    // here" instead of silently dropping it out of the preview.
    : <div data-thumb-stub={el.type} style={{ width: "100%", height: "100%", background: "#d8dade", borderRadius: 2 }} />;
  return (
    <div style={{
      position: "absolute", left: el.x, top: el.y, width: el.w, height: h,
      opacity: el.opacity != null ? el.opacity : 1,
    }}>{content}</div>
  );
}

// The slide, drawn at page size and scaled down — so every element keeps the geometry it has on the
// canvas and nothing needs a second layout path. Clipped, unlike the canvas: a thumbnail is a
// preview of the SLIDE, so what hangs off the page edge does not belong in it.
//
// Memoized on the leaf ARRAY identity, which groupLeavesBySlide keeps stable for every slide an
// edit did not touch. This is the memo that matters: it is why editing the active slide re-renders
// exactly one thumbnail instead of the whole deck's.
const SlideThumb = memo(function SlideThumb({ els, background, w, h, scale, pageW, pageH, imageMap, surface }) {
  return (
    <div style={{ width: w, height: h, overflow: "hidden", position: "relative", background: background || "#ffffff" }}>
      <div style={{
        position: "absolute", left: 0, top: 0, width: pageW, height: pageH,
        transform: "scale(" + scale + ")", transformOrigin: "top left",
      }}>
        {els.map((el) => <ThumbElement key={el.id} el={el} imageMap={imageMap} surface={surface} />)}
      </div>
    </div>
  );
});

// ONE menu with TWO openers: right-click anywhere on a row, and a ⋮ button that is a real <button>
// in the tab order. Four inline buttons cannot be legible in a 96px rail, and a hover-only
// affordance is invisible to a keyboard — so neither alone was enough. No confirmation dialog
// anywhere: `confirm()` freezes the automation channel, and the refusals are already toasts.
const FILM_MENU_W = 152;
const FILM_LAYOUT_MENU_W = 178;  // "Title and content" needs the room; the slide-op menu does not
const FILM_MENU_PAD = 4;  // margin kept between the popup and every viewport edge

// The popup SHELL both rail menus use — the slide-op menu and the layout picker. Measured
// positioning, four-sided clamping, dismiss on outside-pointerdown or Escape: one copy, because a
// second hand-rolled one would have drifted from this the first time either grew an item.
// `data-film-menu` is what the editor's global key handler looks for when it refuses to let a
// focused menu button's Backspace reach the canvas selection, so wearing it is not cosmetic.
function FilmPopup({ at, sig, tag, width, onClose, children }) {
  const ref = useRef(null);
  // The position is MEASURED, never a hand-maintained height constant: the item list is
  // conditional (Move up is absent on the first slide, Move down on the last), so any constant
  // desyncs the moment the menu grows or shrinks. Clamped on all four sides — clamping x only
  // upward let the popup run off the right edge of a narrow viewport.
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof window === "undefined") return;
    const box = node.getBoundingClientRect();
    const vw = window.innerWidth || box.width;
    const vh = window.innerHeight || box.height;
    setPos({
      x: Math.max(FILM_MENU_PAD, Math.min(at.x, vw - box.width - FILM_MENU_PAD)),
      y: Math.max(FILM_MENU_PAD, Math.min(at.y, vh - box.height - FILM_MENU_PAD)),
    });
  }, [at.x, at.y, sig]);
  useEffect(() => {
    // Capture phase, so Escape closes the menu instead of reaching the editor's global handler and
    // stepping the selection out of a group behind it.
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest("[data-film-menu-btn]")) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" data-film-menu={tag}
      style={{
        position: "fixed", left: pos ? pos.x : at.x, top: pos ? pos.y : at.y,
        width: width || FILM_MENU_W, zIndex: 1400,
        background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 6,
        boxShadow: T.panelShadow, padding: "4px 0",
      }}>
      {children}
    </div>
  );
}

function FilmMenuItem({ icon: Icon, label, danger, first, onClick }) {
  return (
    <button role="menuitem" autoFocus={first} onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "5px 9px",
        border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
        color: danger ? T.danger : T.textHi, fontSize: 11.5, fontFamily: T.font,
      }}>
      <Icon size={12} /> {label}
    </button>
  );
}

function FilmstripMenu({ at, index, count, hidden, onPick, onClose }) {
  const item = (key, Icon, label, danger, first) => (
    <FilmMenuItem key={key} icon={Icon} label={label} danger={danger} first={first}
      onClick={() => { onClose(); onPick(key); }} />
  );
  return (
    <FilmPopup at={at} sig={index + ":" + count + ":" + hidden} tag={String(index + 1)} onClose={onClose}>
      {/* "…" because this one opens a second menu (the layout picker) rather than committing —
          the layout IS the choice a new slide is really about, and Blank is its first, focused
          item, so the old one-click blank slide is still one keystroke away. */}
      {item("new", Plus, "New slide after…", false, true)}
      {item("duplicate", Copy, "Duplicate")}
      {item("rename", Pencil, "Rename")}
      {/* Reorder WITHOUT a pointer. The drag is the fast path, but the nav this rail replaced had
          "Move slide earlier/later" and the rail shipped with neither those nor arrow-key reorder —
          which made reorder pointer-only. Hidden rather than disabled at the ends: "move slide 1
          up" is not a thing the author should have to read as greyed out. */}
      {index > 0 ? item("moveUp", ArrowUp, "Move up") : null}
      {index >= 0 && index < count - 1 ? item("moveDown", ArrowDown, "Move down") : null}
      {item("hidden", hidden ? Eye : EyeOff, hidden ? "Show slide" : "Hide slide")}
      {item("delete", Trash2, "Delete slide", true)}
    </FilmPopup>
  );
}

// THE LAYOUT PICKER — a MENU, not a thumbnail palette, and that is a choice worth naming.
// A palette of five little previews is what Slides shows, and it would need a floating panel of
// its own plus a renderer for layout SPECS (SlideThumb eats merged elements with ids and z, which
// a layout definition does not have until buildNewSlide mints them) — a second preview path to
// keep honest, in the app's only modal-ish surface. A menu instead reuses the shell above
// verbatim: measured, edge-clamped, Escape/outside-click dismissal, one autofocused first item,
// arrow-key reachable, and already covered by the global key handler's `[data-film-menu]` guard.
// Five short names are also self-describing in a way five 60px thumbnails are not.
function LayoutMenu({ at, onPick, onClose }) {
  return (
    <FilmPopup at={at} sig="layout" tag="layout" width={FILM_LAYOUT_MENU_W} onClose={onClose}>
      <div data-layout-menu="1" style={{
        padding: "2px 9px 5px", fontSize: 9.5, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.07em", color: T.textFaint, fontFamily: T.font,
      }}>New slide — layout</div>
      {SLIDE_LAYOUTS.map((l, i) => (
        <FilmMenuItem key={l.k} icon={i === 0 ? Square : LayoutTemplate} label={l.label} first={i === 0}
          onClick={() => { onClose(); onPick(l.k); }} />
      ))}
    </FilmPopup>
  );
}

// One row. Every prop is a primitive except the leaf array, the image map and `ops` — and `ops` is
// created once by Filmstrip over a ref, so the memo actually holds across a commit that only
// changed one slide.
const FilmstripRow = memo(function FilmstripRow({
  index, id, name, hidden, background, els, active, renaming, dragging, rowH,
  thumbW, thumbH, thumbScale, pageW, pageH, imageMap, ops,
}) {
  const [hover, setHover] = useState(false);
  const label = name || "Slide " + (index + 1);
  return (
    <div data-film-row={String(index + 1)} data-film-slide={id}
      data-film-active={active ? "1" : undefined} data-film-hidden={hidden ? "1" : undefined}
      // Roving tabindex: the ACTIVE row is the rail's only row-level tab stop, and the arrows move
      // it. Every mounted row being a tab stop cost 11 stops on a 5-slide deck and 47 on a
      // 200-slide one, and focus-driven scrolling could re-window the rail and unmount the focused
      // row out from under the caret.
      role="option" aria-selected={active} tabIndex={active ? 0 : -1}
      title={label + (hidden ? " — marked hidden" : "") + "\nClick to open · ↑↓ to move the cursor · double-click to rename · drag to reorder · right-click or Shift+F10 for more"}
      onPointerDown={(e) => ops.pointerDown(e, index, id)}
      onClick={() => ops.click(index, id)}
      onDoubleClick={(e) => { e.preventDefault(); ops.startRename(id); }}
      onContextMenu={(e) => { e.preventDefault(); ops.menu(e.clientX, e.clientY, index, id, hidden); }}
      onKeyDown={(e) => ops.rowKey(e, index, id, hidden)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute", left: 0, right: 0, top: index * rowH, height: rowH - FILM_ROW_GAP,
        display: "flex", alignItems: "flex-start", gap: FILM_NUM_GAP,
        padding: "0 " + FILM_PAD_X + "px", boxSizing: "border-box",
        cursor: "default", outline: "none", touchAction: "none",
        opacity: dragging ? 0.4 : 1,
      }}>
      <span style={{
        width: FILM_NUM_W, flex: "none", textAlign: "right", paddingTop: 1,
        fontSize: 9.5, lineHeight: 1.2, fontFamily: T.font, fontVariantNumeric: "tabular-nums",
        color: active ? T.accent : hidden ? T.textFaint : T.textMut,
        fontWeight: active ? 600 : 400,
      }}>{index + 1}</span>
      <div style={{ width: thumbW, flex: "none", position: "relative" }}>
        <div style={{
          width: thumbW, height: thumbH, position: "relative", overflow: "hidden",
          // Ring, not border: it costs no layout, so the active state cannot nudge the row.
          boxShadow: active
            ? `0 0 0 2px ${T.accent}`
            : hover ? "0 0 0 1px rgba(255,255,255,0.35)" : "0 0 0 1px rgba(255,255,255,0.14)",
          // A hidden slide LOOKS hidden — washed out, with the glyph below. Nothing skips it:
          // present mode is what consumes the flag, and that is a later task.
          opacity: hidden ? 0.35 : 1,
        }}>
          <SlideThumb els={els} background={background} w={thumbW} h={thumbH} scale={thumbScale}
            pageW={pageW} pageH={pageH} imageMap={imageMap} surface="thumb" />
        </div>
        {hidden ? (
          <span data-film-hidden-badge={String(index + 1)} title="Marked hidden"
            style={{ position: "absolute", right: 1, top: 1, display: "flex", color: "#e8a13c", pointerEvents: "none" }}>
            <EyeOff size={9} />
          </span>
        ) : null}
        <button data-film-menu-btn={String(index + 1)} title="Slide options" tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); ops.menu(r.right, r.bottom, index, id, hidden); }}
          style={{
            position: "absolute", right: 0, bottom: FILM_CAPTION_H, width: 14, height: 14,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
            border: "none", borderRadius: 3, cursor: "pointer", color: T.textHi,
            background: "rgba(0,0,0,0.45)",
            // Hidden until the row is hovered/active, and never display:none — but NOT a tab stop
            // any more (one stop per rail). Shift+F10 / the Menu key on the focused row is the
            // keyboard route to the same menu, so the ops stay reachable without a caret here.
            opacity: hover || active ? 1 : 0,
            transition: `opacity ${T.ease}`,
          }}>
          <MoreVertical size={10} />
        </button>
        <div style={{ height: FILM_CAPTION_H, overflow: "hidden" }}>
          {renaming ? (
            <input autoFocus defaultValue={name || ""} placeholder="Name" spellCheck={false}
              data-film-rename={String(index + 1)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              // stopPropagation reaches the WINDOW handler because React's root listener runs
              // first — the same guard TreePanel's rename uses. Belt and braces next to the global
              // handler's own INPUT check: typing a name must never delete an element.
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { e.currentTarget.value = name || ""; e.currentTarget.blur(); }
              }}
              onBlur={(e) => ops.endRename(id, e.target.value)}
              style={{
                ...inputBaseStyle(true), width: "100%", padding: "0 2px", fontSize: 9,
                height: FILM_CAPTION_H, lineHeight: FILM_CAPTION_H + "px",
              }} />
          ) : (
            <div style={{
              fontSize: 9, lineHeight: FILM_CAPTION_H + "px", fontFamily: T.font,
              color: active ? T.textHi : T.textFaint,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>{name || ""}</div>
          )}
        </div>
      </div>
    </div>
  );
});

// The rail. Owns exactly three pieces of local state — scroll offset, the open menu, the live drag —
// and nothing that belongs in the override bag.
function Filmstrip({ width, slides, activeSlideId, activeIndex, leavesBySlide, page, imageMap, renamingSlideId, ops }) {
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [menu, setMenu] = useState(null); // { x, y, index, id, hidden }
  // The layout picker's own anchor. Separate state, not a mode of `menu`: the two popups have
  // different item lists and the slide-op menu CLOSES before this one opens (it is the thing that
  // opens it), so one slot would have to encode "closed but about to reopen".
  const [layoutAt, setLayoutAt] = useState(null); // { x, y, afterId }
  const [drag, setDrag] = useState(null); // { id, from, slot, to } — the LIVE gesture, for painting
  const dragRef = useRef(null);
  const suppressClick = useRef(false);
  const count = slides.length;
  // ONE source of truth for "how big is a thumbnail", and it reads the LIVE rail width — so a drag
  // resizes the thumbnails, the row height, the virtual window and the drop math together.
  const thumb = useMemo(() => filmThumbBox(page.width, page.height, width), [page.width, page.height, width]);
  const rowH = filmRowHeight(thumb.h);
  const win = filmWindow(count, rowH, scrollTop, viewportH, FILM_OVERSCAN, FILM_VIRTUALIZE_FROM);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    const measure = () => setViewportH(node.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keep the ACTIVE slide on screen. Deliberately keyed on the cursor alone: scrolling is the
  // author's otherwise, and re-running this on every scroll would fight them. A virtualized rail
  // needs it — at slide 180 the active row is not mounted until the scroll offset says so.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || activeIndex < 0) return;
    const top = activeIndex * rowH;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowH > node.scrollTop + node.clientHeight) node.scrollTop = top + rowH - node.clientHeight;
  }, [activeSlideId]);

  // With one roving tab stop the caret has to travel with the cursor, or an arrow key moves the
  // active row out from under a focus that stays behind. On a virtualized rail the destination row
  // may not be MOUNTED until the scroll-into-view effect above has re-windowed the rail, so the
  // request is remembered and retried on every commit until the row exists. Set only by the keys
  // that move the cursor — clicking a row already focuses it, and an activate from the canvas or
  // an undo must not steal focus into the rail.
  const wantFocus = useRef(null);
  useEffect(() => {
    const id = wantFocus.current;
    const node = scrollRef.current;
    if (!id || !node) return;
    const rows = node.querySelectorAll("[data-film-slide]");
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].getAttribute("data-film-slide") === id) {
        wantFocus.current = null;
        rows[i].focus();
        return;
      }
    }
  });

  // ── Reorder drag ──
  // Same lifecycle as the canvas gestures: a travel threshold before it counts as a drag (so a
  // click still activates), window listeners rather than pointer capture (the row can unmount under
  // the pointer when the rail autoscrolls), Escape and pointercancel both cancel, and the commit
  // happens once on release. Nothing commits until then, so a cancelled or no-op drag writes zero.
  // The live drag's target, re-derived from the LAST pointer position against the rail's current
  // box and scroll offset. Called from pointermove AND from the rail's own scroll handler: edge
  // autoscroll and a wheel both move the rail under a held pointer with no pointermove to follow,
  // and the slot has to move with it or the release commits the index the pointer had a viewport
  // ago. Reading `count`/`rowH` from the render closure (via liveRef) rather than from pointerdown
  // is deliberate — the geometry the author is looking at is the current one.
  const applyDragTarget = (d) => {
    const node = scrollRef.current;
    if (!node) return;
    const next = filmDragTarget(d.from, count, rowH, node.getBoundingClientRect(), node.scrollTop, d.px, d.py);
    d.slot = next.slot;
    d.to = next.to;
    setDrag({ id: d.id, from: d.from, slot: next.slot, to: next.to });
  };
  const endDrag = (commit) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    d.detach();
    const out = filmDragEnd(d, commit);
    // Suppression is for a COMMITTED drag only. A cancel, or a release with no valid target (out
    // over the canvas), is followed by an ordinary click, so leaving the flag set ate the author's
    // NEXT click on a row and that slide did not open.
    suppressClick.current = out.suppress;
    if (out.commit) liveRef.current.ops.move(out.commit.to, out.commit.id);
  };
  // A deck change mid-drag invalidates the captured origin index, so cancel rather than land the
  // slide one row from the painted indicator. Runs after every commit; the signature is only built
  // while a drag is actually live.
  useEffect(() => {
    if (filmDragStale(dragRef.current, filmDeckSig(slides))) endDrag(false);
  });
  const pointerDown = (e, index, id) => {
    if (e.button !== 0 || dragRef.current) return;
    // The rename field and the ⋮ button are controls, not drag handles.
    if (e.target && e.target.closest && e.target.closest("input,button")) return;
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.x) + Math.abs(ev.clientY - d.y) < MARQUEE_THRESHOLD) return;
      d.moved = true;
      // Retained so a scroll with no pointermove behind it can re-derive the slot (FIX 7).
      d.px = ev.clientX;
      d.py = ev.clientY;
      const node = scrollRef.current;
      if (!node) return;
      // Edge autoscroll: without it a 200-slide deck can only be reordered within one viewport.
      const delta = filmAutoscrollDelta(node.getBoundingClientRect(), ev.clientX, ev.clientY);
      if (delta) node.scrollTop += delta;
      liveRef.current.applyDragTarget(d);
    };
    const onUp = () => endDrag(true);
    const onCancel = () => endDrag(false);
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); endDrag(false); } };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    dragRef.current = {
      id, from: index, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY,
      moved: false, slot: FILM_NO_DROP, to: FILM_NO_DROP, sig: filmDeckSig(slides), detach,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const rowKey = (e, index, id, hidden) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      ops.activate(id);
      return;
    }
    if (e.key === "F2") { e.preventDefault(); e.stopPropagation(); ops.startRename(id); return; }
    // Shift+F10 and the Menu key are the platform's "open the context menu for the focused thing".
    // The ⋮ button is no longer a tab stop, so this is the keyboard route to the slide ops —
    // including the Move up/down items, which are the keyboard route to REORDER.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      const box = e.currentTarget.getBoundingClientRect();
      // setMenu, not ops.menu: `ops` is the ROOT's slide glue (activate/newAfter/move/…) and owns no
      // menu; opening it is the rail's own state, the same setter the ⋮ button and right-click use.
      setMenu({ x: box.left + FILM_PAD_X + FILM_NUM_W, y: box.bottom, index, id, hidden: !!hidden });
      return;
    }
    // Arrows/Home/End move the CURSOR, listbox-style. This is the one keyboard route to a row the
    // virtual window has not mounted: the cursor scrolls into view, the row mounts, and the caret
    // follows it. Claimed even at the ends, so an arrow on the first/last row cannot fall through
    // and nudge the canvas selection instead.
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const to = step ? index + step : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
    if (to !== null) {
      e.preventDefault();
      e.stopPropagation();
      if (to >= 0 && to < count && slides[to] && slides[to].id !== id) {
        wantFocus.current = slides[to].id;
        ops.activate(slides[to].id);
      }
      return;
    }
    // A focused row swallows Delete/Backspace. The author is looking at slides, so deleting the
    // canvas selection is not what the key means here — and silently destroying elements from the
    // rail would be worse than the key doing nothing. Delete-slide lives in the menu, where it is
    // named. Undo/redo still passes through to the global handler.
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); }
  };

  // Stable for the row memo: `ops` from the root is a fresh object every render, so the rows read
  // the latest handlers through a ref instead of a changing prop. Same idiom as the root's stateRef.
  const liveRef = useRef(null);
  liveRef.current = { pointerDown, rowKey, ops, setMenu, applyDragTarget };
  const rowOps = useMemo(() => ({
    pointerDown: (e, i, id) => liveRef.current.pointerDown(e, i, id),
    rowKey: (e, i, id, hidden) => liveRef.current.rowKey(e, i, id, hidden),
    click: (i, id) => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      liveRef.current.ops.activate(id);
    },
    startRename: (id) => liveRef.current.ops.startRename(id),
    endRename: (id, value) => liveRef.current.ops.endRename(id, value),
    menu: (x, y, index, id, hidden) => liveRef.current.setMenu({ x, y, index, id, hidden }),
  }), []);

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeLayout = useCallback(() => setLayoutAt(null), []);
  const pickMenu = (key) => {
    const m = menu;
    if (!m) return;
    // The row menu's "New slide after…" hands off to the LAYOUT picker, anchored where it already
    // was, so the two menus read as one flow rather than two places new slides come from.
    if (key === "new") setLayoutAt({ x: m.x, y: m.y, afterId: m.id });
    else if (key === "duplicate") ops.duplicate(m.id);
    else if (key === "rename") ops.startRename(m.id);
    else if (key === "hidden") ops.toggleHidden(m.id);
    else if (key === "delete") ops.remove(m.id);
    // buildReorderedSlides counts in POST-REMOVAL coordinates — the list without the moved slide —
    // so one step is plainly index ± 1: up puts it before its predecessor, down after its
    // successor. The items only exist when the step is in range, so no clamping is needed here.
    else if (key === "moveUp") ops.move(m.index - 1, m.id);
    else if (key === "moveDown") ops.move(m.index + 1, m.id);
  };

  const rows = [];
  for (let i = win.start; i < win.end; i += 1) {
    const slide = slides[i];
    if (!slide) continue;
    const els = leavesBySlide.get(slide.id);
    rows.push(
      <FilmstripRow key={slide.id} index={i} id={slide.id} name={slide.name} hidden={!!slide.hidden}
        background={slide.background || page.background} els={els || EMPTY_LEAVES}
        active={slide.id === activeSlideId} renaming={renamingSlideId === slide.id}
        dragging={!!drag && drag.id === slide.id} rowH={rowH}
        thumbW={thumb.w} thumbH={thumb.h} thumbScale={thumb.scale} pageW={page.width} pageH={page.height}
        imageMap={imageMap} ops={rowOps} />,
    );
  }

  return (
    <div data-filmstrip={String(count)} style={{
      // border-box, because the panel budget subtracts exactly this width: a 96px content box plus
      // a 1px border would be a 97px column. Declared rather than inherited — the rail always said
      // so, and now all three panels do, so the budget is exact in a host page with no CSS reset
      // instead of relying on the embedder for it.
      width, boxSizing: "border-box", flex: "none",
      background: T.panelBg, borderRight: `1px solid ${T.panelBorder}`,
      display: "flex", flexDirection: "column", zIndex: 1100,
    }}>
      {/* Same section idiom as the layers header. The count lives here and nowhere else: it is the
          panel that owns slides, it costs no extra chrome, and a VIRTUALIZED rail cannot be counted
          by eye — "12" is the one thing the numbered thumbnails do not already say. */}
      <div style={{
        padding: "10px 6px 6px", fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        letterSpacing: "0.07em", color: T.textFaint, fontFamily: T.font,
        display: "flex", alignItems: "center", gap: 4,
      }}>
        <Film size={11} /> Slides
        <div style={{ flex: 1 }} />
        <span data-film-count={String(count)} title={count + (count === 1 ? " slide" : " slides")}
          style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{count}</span>
        <button title="New slide after the current one — pick a layout" data-film-new="1"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setLayoutAt({ x: r.left, y: r.bottom + 2, afterId: activeSlideId }); }}
          style={{ border: "none", background: "transparent", color: T.textFaint, cursor: "pointer", padding: 1, display: "flex", borderRadius: 4 }}>
          <Plus size={12} />
        </button>
      </div>
      <div ref={scrollRef} className="ed-scroll" role="listbox" aria-label="Slides"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // A rail that scrolls under a held pointer (edge autoscroll, or a wheel) must re-derive
          // the drop slot from the retained pointer position: no pointermove follows a scroll, so
          // without this the release commits the index the pointer had at the old offset.
          const d = dragRef.current;
          if (d && d.moved) applyDragTarget(d);
        }}
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative", paddingBottom: 10 }}>
        {count === 0 ? (
          <div style={{ padding: "20px 8px", textAlign: "center", color: T.textFaint, fontSize: 11, fontFamily: T.font }}>
            No slides
          </div>
        ) : (
          <div role="presentation" style={{ position: "relative", height: count * rowH }}>
            {rows}
            {/* The drop indicator only appears for a move that would actually commit (to >= 0), so
                the author can see when a drag has become a no-op. */}
            {drag && drag.to >= 0 ? (
              <div data-film-drop={String(drag.slot)} style={{
                position: "absolute", left: FILM_PAD_X + FILM_NUM_W + FILM_NUM_GAP, right: FILM_PAD_X,
                top: drag.slot * rowH - 1, height: 2, background: T.accent, borderRadius: 1, pointerEvents: "none",
              }} />
            ) : null}
          </div>
        )}
      </div>
      {/* The rail cap keeps the popup beside the rail rather than out over the canvas; keeping it
          INSIDE the viewport is the menu's own job, and measured there rather than guessed from an
          item count here. */}
      {menu ? (
        <FilmstripMenu at={{ x: Math.min(menu.x, width + 8), y: menu.y }}
          index={menu.index} count={count}
          hidden={menu.hidden} onPick={pickMenu} onClose={closeMenu} />
      ) : null}
      {layoutAt ? (
        <LayoutMenu at={{ x: Math.min(layoutAt.x, width + 8), y: layoutAt.y }}
          onPick={(layout) => ops.newAfter(layoutAt.afterId, layout)} onClose={closeLayout} />
      ) : null}
    </div>
  );
}

// ── The build order, in the LAYERS panel ────────────────────────────────────
// THREE surfaces, one question each, and only two of them are new.
//
//   • BuildBadges (on the slide) answers WHERE — "does the KPI row come before the chart?" — for
//     every step at once, at every zoom. It stays exactly as it was: non-interactive, ordinal-only.
//   • The MARK on each layers row (below) answers "is THIS thing built, and on which click", for the
//     one thing the author is pointing at, and is the only place a step is added or removed.
//   • The BUILD ORDER section (under the tree) answers IN WHAT ORDER, as a list of clicks — the one
//     question a spatial view genuinely cannot answer, and the surface a reorder needs, because
//     dragging step 3 above step 1 is a gesture over a sequence, not over a slide.
//
// The two new ones live in the LEFT panel because both are about the SLIDE, not the selection. The
// inspector's numeric Build field — one selection, one raw stored value, no order — is gone: it
// could only tell you the number you had already typed, and it could not answer either question
// above.
//
// EVERYTHING IT COULD DO STILL HAPPENS, and that took two routes rather than one, because the first
// draft of this comment claimed otherwise and was wrong:
//   • "select the GROUP, set one step" is the mark on a group row, which writes to every descendant
//     leaf. That is what makes four things arrive together.
//   • "select TWO LEAVES of a group, set one step" is a mark on a row that is part of a
//     MULTI-SELECTION, which writes to the whole selection's leaves (buildMarkTargets). Without it
//     an arbitrary SUBSET of a group could never share a click again — and who-deck slide 4 ships
//     one (step 2 is two of `s4-chartgrp`'s four leaves), so the example deck held a state its own
//     editor could not reproduce.
// There is still NO drag between the tree and the section: the mark is the only way across.
//
// NOTHING HERE IS DIVE STATE. Open/closed, the drag in flight, the roving caret and hover are
// viewport ephemera — `useState`, never `useDiveState` and never a bag key — for the same reason
// `notesOpen`, `activeCell` and the panel widths are not (see the notesOpen comment in the root).

const BUILD_MARK_W = 18;          // the mark's box; reserved on EVERY row so nothing shifts on hover
const BUILD_ORDER_MAX_H = 168;    // ...so the section can never crowd the tree out of the panel
const BUILD_ORDER_ROW_H = 26;

// The mark at the right edge of one layers row. Its STATE is the state of whatever it writes to —
// the row alone, or the whole selection when the row is part of one — so two marks inside one
// selection can never offer two different answers. THREE states, and the third is not decoration:
//   • in the order  → the ORDINAL (never the stored value — same number BuildBadges paints)
//   • not in it     → nothing, until the row is hovered or the mark is focused
//   • MIXED         → a dash, for a GROUP whose descendant leaves disagree. That state is reachable
//                     today (who-deck's s4-chartgrp spans steps 1, 2 and 3) and an ordinal there
//                     would be a lie. Its click RESOLVES the state by putting every leaf under the
//                     group on one new last step; the row then reads as an ordinal, and a second
//                     click takes the whole group back out. Two clicks rather than a third button:
//                     "un-build a group that is only half built" is not a thing an author asks for
//                     without first deciding what the group should do.
// On hover/focus the glyph swaps to the ACTION (✕ to remove, + to add) so one 18px box is both the
// readout and the button — at PANE_MIN_WIDTH there is no room for two.
function BuildRowMark({ state, active, focused, disabled, disabledHint, nextOrdinal, selCount, elId, onActivate, onFocus, onBlur, tabStop, markRef, onKey }) {
  // A group with no leaves has nothing to write to: a spacer, so its row still lines up.
  if (state.kind === "empty") return <span style={{ width: BUILD_MARK_W, flex: "none" }} />;
  const inOrder = state.kind === "step";
  const mixed = state.kind === "mixed";
  const show = active || focused;
  // `selCount` is non-zero only when this row is part of a multi-selection, and then the mark speaks
  // for the SELECTION — see buildMarkTargets and buildMarkText.
  const text = buildMarkText(state, selCount, nextOrdinal, disabled ? disabledHint : null);
  return (
    <button ref={markRef} data-build-mark={elId} data-build-mark-state={state.kind}
      data-build-mark-ordinal={inOrder ? String(state.ordinal) : undefined}
      data-build-mark-targets={selCount ? String(selCount) : undefined}
      type="button" title={text.title} aria-label={text.label} disabled={disabled}
      tabIndex={tabStop ? 0 : -1}
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={onFocus} onBlur={onBlur} onKeyDown={onKey}
      onClick={(e) => { e.stopPropagation(); onActivate(); }}
      style={{
        width: BUILD_MARK_W, height: BUILD_MARK_W, flex: "none", padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "none", borderRadius: BUILD_MARK_W / 2, cursor: disabled ? "default" : "pointer",
        fontSize: 10, fontWeight: 700, fontFamily: T.font, fontVariantNumeric: "tabular-nums",
        lineHeight: 1, transition: `opacity ${T.ease}, background ${T.ease}`,
        // An UNBUILT row shows NOTHING at rest — the tree would otherwise be a column of plus signs
        // — but the box is still there, so hovering never reflows the name beside it. A MIXED group
        // does show at rest: "part of this is built" is information the author cannot get anywhere
        // else, and hiding it would let the row read as unbuilt, which is the lie this state exists
        // to avoid.
        opacity: inOrder || mixed || show ? 1 : 0,
        color: inOrder && !show ? "#fff" : mixed && !show ? T.textMut : T.textHi,
        background: inOrder && !show ? T.accent : show ? "rgba(255,255,255,0.14)"
          : mixed ? "rgba(255,255,255,0.10)" : "transparent",
        boxShadow: focused ? `0 0 0 2px ${T.accent}` : "none",
      }}>
      {show ? (inOrder ? <X size={11} strokeWidth={2.5} /> : <Plus size={11} strokeWidth={2.5} />)
        : inOrder ? state.ordinal : <Minus size={10} strokeWidth={2.5} />}
    </button>
  );
}

// THE BUILD ORDER SECTION. Rows are STEPS, not elements: row n is click n, and a step with several
// members lists all of them, because "these four arrive together" is a property of the step and a
// list of elements cannot show it. (who-deck slide 4 has exactly that: `s4-note` and `s4-arrow`
// share step 2.) Members read in canvas reading order, the same order the tree sorts siblings by.
//
// Reordering here writes `build` AND NOTHING ELSE — never `z`, never `parent`. Dragging in the tree
// above writes `parent`/`z` and never `build`. The two orders are genuinely independent (paint order
// vs. reveal order) and mixing them is the one thing this panel must not do, which is also why
// there is NO drag between the two sections.
//
// Getting IN is the mark's job alone. Getting OUT has two doors — the mark, and this section's own ✕
// (or Delete on a focused row) — and that asymmetry is deliberate: "which thing?" is a question only
// the tree can answer, while "that step, gone" is one this list answers better than any row does.
function BuildOrderSection({ rows, disabled, disabledHint, onSelect, onRemove, onMove }) {
  const [open, setOpen] = useState(true);
  const [caret, setCaret] = useState(0);   // roving tabindex: ONE row-level tab stop for the section
  const [drag, setDrag] = useState(null);  // { from, slot } — slot is the gap the release would land in
  const dragRef = useRef(null);
  const rowRefs = useRef({});
  const wantFocus = useRef(null);
  const count = rows.length;
  const at = count ? Math.max(0, Math.min(count - 1, caret)) : 0;

  // Focus follows the caret only when a KEY moved it (arrow, or a reorder that carried the row with
  // it). Never on a re-render, or a commit elsewhere in the editor would steal the caret.
  useEffect(() => {
    const want = wantFocus.current;
    wantFocus.current = null;
    if (want == null) return;
    const node = rowRefs.current[want];
    if (node) node.focus();
  });

  const startDrag = (e, from) => {
    if (disabled || count < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const track = (ev) => {
      let slot = count;
      for (let i = 0; i < count; i += 1) {
        const node = rowRefs.current[i];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) { slot = i; break; }
        slot = i + 1;
      }
      dragRef.current = { from, slot };
      setDrag(dragRef.current);
    };
    const detach = () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };
    const onUp = () => {
      detach();
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      // `slot` is a GAP index. The destination index in the list AFTER the row is pulled out is one
      // less whenever the gap sits below where the row came from.
      if (!d || d.slot == null) return;
      const to = d.slot > d.from ? d.slot - 1 : d.slot;
      if (to !== d.from) onMove(d.from, to);
    };
    // Escape (and a cancelled pointer) abandon the drag without writing — the same escape hatch the
    // canvas move gesture and the filmstrip's row drag both offer.
    const onCancel = () => { detach(); dragRef.current = null; setDrag(null); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); onCancel(); } };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  // A hover-only control is invisible to a keyboard, so every row op has a key — and WHICH keys this
  // row claims is `buildStepKey`, a pure function, not a ladder in here (see the keyboard maps).
  // Everything except "pass" is claimed with preventDefault + stopPropagation BEFORE anything else
  // happens, including the ops that then decline to act because the bag is stale: Delete reaching
  // the window handler would delete the selected ELEMENTS, which is not what the key means with a
  // step row focused. ⌘Z is a "pass" and still reaches the global handler.
  const rowKey = (e, index) => {
    const action = buildStepKey(e.key, e.altKey);
    if (action === BUILD_KEY_PASS) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = () => rows[index].members.map((el) => el.id);
    if (action === "activate") { onSelect(ids()); return; }
    if (action === "remove") { if (!disabled) onRemove(ids()); return; }
    const to = action === "next" || action === "moveDown" ? index + 1
      : action === "prev" || action === "moveUp" ? index - 1
      : action === "first" ? 0 : count - 1;
    if (to < 0 || to >= count) return;
    if (action === "moveUp" || action === "moveDown") {
      if (disabled) return;
      wantFocus.current = to;   // the caret rides along with the step it moved
      setCaret(to);
      onMove(index, to);
      return;
    }
    wantFocus.current = to;
    setCaret(to);
  };

  const dropSlot = drag ? drag.slot : -1;
  return (
    <div data-build-order="1" style={{
      flex: "none", borderTop: `1px solid ${T.panelBorder}`, display: "flex", flexDirection: "column",
      minHeight: 0, maxHeight: open ? BUILD_ORDER_MAX_H : undefined,
    }}>
      <button data-build-order-toggle="1" type="button" onClick={() => setOpen((v) => !v)}
        aria-expanded={open} title={open ? "Hide the build order" : "Show the build order"}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%", flex: "none",
          padding: "8px 12px 6px", border: "none", background: "transparent", cursor: "pointer",
          fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em",
          color: T.textFaint, fontFamily: T.font, textAlign: "left",
        }}>
        {open ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
        <ListOrdered size={11} style={{ flex: "none" }} />
        {/* nowrap on both labels: at PANE_MIN_WIDTH the header would otherwise wrap to two lines and
            eat a build row's worth of the section's height. */}
        <span style={{ flex: "none", whiteSpace: "nowrap" }}>Build order</span>
        <div style={{ flex: 1, minWidth: 0 }} />
        <span style={{ flex: "none", whiteSpace: "nowrap", textTransform: "none", letterSpacing: 0, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>
          {count ? count + (count === 1 ? " step" : " steps") : "none"}
        </span>
      </button>
      {open ? (
        <div className="ed-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 6px 8px" }}>
          {disabled ? (
            <div data-build-order-stale="1" style={{ padding: "2px 6px 6px", fontSize: 11, color: T.textFaint, fontFamily: T.font, lineHeight: 1.45 }}>
              {disabledHint}
            </div>
          ) : null}
          {!count ? (
            <div data-build-order-empty="1" style={{ padding: "2px 6px 4px", fontSize: 11, color: T.textFaint, fontFamily: T.font, lineHeight: 1.45 }}>
              Nothing is built on this slide — everything appears at once. Add a step with the + at
              the right of a layer above.
            </div>
          ) : (
          // `role="option"` needs a listbox to be an option OF — an orphan role is announced wrong or
          // dropped entirely. It wraps the ROWS only, so the stale note and the empty hint above are
          // not mistaken for options.
          <div role="listbox" aria-label="Build order" aria-orientation="vertical">
          {rows.map((row, i) => {
            const names = row.members.map((el) => el.name || el.id);
            const label = row.label || names.join(", ");
            const dragging = drag && drag.from === i;
            return (
              <div key={row.step}>
                {dropSlot === i ? <div style={{ height: 2, background: T.accent, borderRadius: 1, margin: "0 4px" }} /> : null}
                <div ref={(n) => { rowRefs.current[i] = n; }}
                  data-build-step-row={String(i + 1)} data-build-step-count={String(row.members.length)}
                  role="option" aria-selected={false} tabIndex={i === at ? 0 : -1}
                  title={`Step ${i + 1} of ${count} — ${row.members.length === 1 ? "1 element appears" : row.members.length + " elements appear"} here: ${names.join(", ")}`
                    + "\nEnter to select · Alt+↑↓ to reorder · Delete to un-build · drag the grip to reorder"}
                  onKeyDown={(e) => rowKey(e, i)}
                  onFocus={() => setCaret(i)}
                  onClick={() => onSelect(row.members.map((el) => el.id))}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, height: BUILD_ORDER_ROW_H,
                    padding: "0 4px 0 2px", borderRadius: 6, cursor: "default", outline: "none",
                    opacity: dragging ? 0.4 : 1,
                  }}>
                  <span onPointerDown={(e) => startDrag(e, i)} title="Drag to reorder this step"
                    style={{ display: "flex", color: T.textFaint, flex: "none", touchAction: "none", cursor: disabled || count < 2 ? "default" : "grab" }}>
                    <GripVertical size={12} />
                  </span>
                  {/* The step NUMBER is the row's position, which after any write here is also the
                      stored value — every write normalizes to 1..N (see buildWritePlan). */}
                  <span style={{
                    width: 16, height: 16, flex: "none", borderRadius: 8, background: T.accent, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9.5, fontWeight: 700, fontFamily: T.font, fontVariantNumeric: "tabular-nums", lineHeight: 1,
                  }}>{i + 1}</span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 11.5, color: T.textMut, fontFamily: T.font,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>{label}</span>
                  {row.members.length > 1 ? (
                    <span title={`${row.members.length} elements arrive on this click`}
                      style={{ flex: "none", fontSize: 9.5, color: T.textFaint, fontFamily: T.font, fontVariantNumeric: "tabular-nums" }}>
                      ×{row.members.length}
                    </span>
                  ) : null}
                  {/* Not a tab stop: one stop per section (the row), the same rule the filmstrip's
                      ⋮ button follows. Delete on the focused row is the keyboard route here. */}
                  <button data-build-step-remove={String(i + 1)} type="button" tabIndex={-1} disabled={disabled}
                    title={disabled ? disabledHint : "Take this step out of the build order (its elements stay, visible from the start)"}
                    aria-label={`Remove build step ${i + 1}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onRemove(row.members.map((el) => el.id)); }}
                    style={{
                      width: 16, height: 16, flex: "none", padding: 0, border: "none", borderRadius: 8,
                      background: "transparent", color: T.textFaint, cursor: disabled ? "default" : "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            );
          })}
          {dropSlot === count && count ? <div style={{ height: 2, background: T.accent, borderRadius: 1, margin: "0 4px" }} /> : null}
          </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
// ── TreePanel (layers) ──────────────────────────────────────────────────────
function TreePanel({ width, elements, zOf, posOf, selection, hoverId, setHoverId, onSelect, onSelectMany, renamingId, setRenamingId, onRename, onDrop, build }) {
  const byId = useMemo(() => { const m = {}; for (const e of elements) m[e.id] = e; return m; }, [elements]);
  // Sibling order at EVERY level: canvas reading order — top-to-bottom, ties broken
  // left-to-right (re-sorted live as things move); z only as a final tiebreak.
  const kids = useMemo(() => {
    const m = {};
    for (const e of elements) {
      const k = e.parent != null ? e.parent : "";
      if (!m[k]) m[k] = [];
      m[k].push(e);
    }
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => {
        const pa = posOf(a.id), pb = posOf(b.id);
        return (pa.y - pb.y) || (pa.x - pb.x) || (zOf(b.id) - zOf(a.id));
      });
    }
    return m;
  }, [elements, zOf, posOf]);
  const [collapsed, setCollapsed] = useState(() => new Set()); // default: all groups expanded
  const isAncestor = useCallback((maybeAncestor, id) => {
    let cur = id, guard = 0;
    while (cur != null && guard++ < 64) {
      if (cur === maybeAncestor) return true;
      cur = byId[cur] ? (byId[cur].parent != null ? byId[cur].parent : null) : null;
    }
    return false;
  }, [byId]);

  // Selecting anything reveals it: auto-expand every ancestor group.
  useEffect(() => {
    if (!selection.length) return;
    setCollapsed((prev) => {
      if (!prev.size) return prev;
      let next = null;
      for (const id of selection) {
        let cur = byId[id] ? byId[id].parent : null, guard = 0;
        while (cur != null && guard++ < 64) {
          if (prev.has(cur)) { if (!next) next = new Set(prev); next.delete(cur); }
          cur = byId[cur] ? byId[cur].parent : null;
        }
      }
      return next || prev;
    });
  }, [selection, byId]);

  const rows = useMemo(() => {
    const out = [];
    const rec = (pid, depth) => {
      if (depth > 32) return;
      for (const el of (kids[pid] || [])) {
        out.push({ el, depth });
        if (el.type === "group" && !collapsed.has(el.id)) rec(el.id, depth + 1);
      }
    };
    rec("", 0);
    return out;
  }, [kids, collapsed]);

  const rowRefs = useRef({});
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null); // { id, target: {kind:"before"|"end"|"into", id?}, index }
  const listRef = useRef(null);

  // ── The build order, derived (deck only; `build` is null for a v1 scene) ──
  // Every leaf on the slide in CANVAS READING ORDER — the same comparator `kids` sorts siblings by,
  // applied flat, so a step's members list in the order the tree lists them and the two panels never
  // disagree about which of two things comes "first".
  const buildLeaves = useMemo(() => {
    if (!build) return null;
    // The `type !== "group"` filter is belt-and-braces — `build.leaves` is the root's leaf list —
    // and it is also what makes `.sort()` safe, since filter has already copied the array.
    return build.leaves.filter((el) => el && el.type !== "group").sort((a, b) => {
      const pa = posOf(a.id), pb = posOf(b.id);
      return (pa.y - pb.y) || (pa.x - pb.x) || (zOf(b.id) - zOf(a.id));
    });
  }, [build ? build.leaves : null, posOf, zOf]);
  const buildRows = useMemo(() => (buildLeaves ? buildStepRows(buildLeaves) : BUILD_NO_ROWS), [buildLeaves]);
  // buildOrderOf, not an inlined copy of its body: "the current sequence" has ONE definition, and the
  // second pass over a slide's leaves costs nothing next to a duplicate that can drift.
  const buildOrder = useMemo(() => buildOrderOf(buildLeaves), [buildLeaves]);
  // A row's leaves: itself for a leaf, every descendant leaf for a group — which is what a group
  // row's mark writes to, since the core forbids `build` on the group itself.
  const leavesUnder = useMemo(() => {
    // Object.create(null), and this is not hygiene: element ids are NOT filtered against the
    // prototype the way object keys in the bag are, so `id: "toString"` is legal and reaches here.
    // On a plain object `memo["toString"]` resolves up the chain to a FUNCTION, which is truthy, is
    // returned as if it were a leaf list, and takes the whole Layers panel down on `.map`. Same
    // reasoning as the SQL-statement bag's own-property fix.
    const memo = Object.create(null);
    const rec = (id, depth) => {
      if (memo[id]) return memo[id];
      const el = byId[id];
      if (!el) return [];
      if (el.type !== "group") { memo[id] = [el]; return memo[id]; }
      const out = [];
      if (depth < 32) for (const kid of (kids[id] || [])) out.push(...rec(kid.id, depth + 1));
      memo[id] = out;
      return out;
    };
    for (const el of elements) rec(el.id, 0);
    return memo;
  }, [elements, byId, kids]);
  // The section's rows carry a NAME as well, resolved against the tree (see buildStepLabel).
  const buildNamedRows = useMemo(() => buildRows.map((row) => ({
    ...row,
    label: buildStepLabel(row.members,
      (id) => (byId[id] ? (byId[id].name || byId[id].id) : ""),
      (id) => (leavesUnder[id] || []).length),
  })), [buildRows, byId, leavesUnder]);
  // ONE write path for all three ops, so "reordering builds never touches z or parent" is a
  // property of one function rather than of three call sites.
  const buildApply = (order) => { if (build && !build.disabled) build.apply(order); };
  // The roving tab stop among the marks: the selected row's, else the first row's — one stop for
  // the whole tree, the filmstrip's rule. `markCaret` remembers where the arrows left it.
  const [markCaret, setMarkCaret] = useState(null);
  const [markFocus, setMarkFocus] = useState(null);
  const markRefs = useRef(Object.create(null));   // keyed by ELEMENT ID — see leavesUnder
  const wantMarkFocus = useRef(null);
  useEffect(() => {
    const want = wantMarkFocus.current;
    wantMarkFocus.current = null;
    if (want == null) return;
    const node = markRefs.current[want];
    if (node) node.focus();
  });
  const markStop = (markCaret && rows.some((r) => r.el.id === markCaret)) ? markCaret
    : (rows.find((r) => selection.includes(r.el.id)) || rows[0] || { el: {} }).el.id;
  // THE WHOLE KEYBOARD STORY for the tree's marks: one Tab reaches the caret's mark, ↑↓/Home/End
  // reach every other one, Enter/Space activates. Which keys are claimed is `buildMarkKey`, a pure
  // function, so the two that MUST NOT reach the window are branches a mutant can kill rather than
  // a regex's worth of call site:
  //   • DELETE would delete the selected ELEMENT. The mark sits on the selected row, so the author
  //     asking to un-build one thing would destroy it instead — silently, and past undo's reach in
  //     the sense that nothing on screen said what happened.
  //   • SPACE is the editor's hold-for-Hand modifier. Un-claimed it flipped the tool instead of
  //     pressing the button, and a <button>'s own Space handling never got the chance.
  // Activation is performed HERE rather than left to the button, because preventDefault on keydown
  // — which is what stops the key reaching the window — is also what stops the browser synthesising
  // the click. ⌘Z is a "pass" and still reaches the global handler.
  const markKey = (e, index, activate, markDisabled) => {
    const action = buildMarkKey(e.key);
    if (action === BUILD_KEY_PASS) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "swallow") return;
    if (action === "activate") { if (!markDisabled) activate(); return; }
    const to = action === "next" ? index + 1 : action === "prev" ? index - 1
      : action === "first" ? 0 : rows.length - 1;
    if (to < 0 || to >= rows.length) return;
    wantMarkFocus.current = rows[to].el.id;
    setMarkCaret(rows[to].el.id);
  };

  const startDrag = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    const onMove = (ev) => {
      let target = { kind: "end" }, index = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const node = rowRefs.current[rows[i].el.id];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          const f = rect.height ? (ev.clientY - rect.top) / rect.height : 0;
          const row = rows[i];
          // Middle 40% of a group row = drop INTO that group.
          if (row.el.type === "group" && f >= 0.3 && f < 0.7 && !isAncestor(id, row.el.id)) {
            target = { kind: "into", id: row.el.id };
            index = i;
          } else if (f < 0.5) {
            target = { kind: "before", id: row.el.id }; index = i;
          } else {
            const nx = rows[i + 1];
            target = nx ? { kind: "before", id: nx.el.id } : { kind: "end" };
            index = i + 1;
          }
          break;
        }
        if (ev.clientY < rect.top) { target = { kind: "before", id: rows[i].el.id }; index = i; break; }
      }
      dragRef.current = { id, target, index };
      setDrag(dragRef.current);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d && d.target) onDrop(d.id, d.target);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div style={{
      // border-box: the panel budget subtracts exactly `width`, so the 1px border must come out of
      // it rather than sitting beside it (see clampPanelWidths). This is HARDENING, not a bug fix —
      // a host page with a border-box reset (Tailwind's preflight, and every reset in wide use) made
      // this true already, which is why no measurement in the harness ever showed the 2px error the
      // commit message claimed. Declaring it stops the budget depending on the embedder.
      width, boxSizing: "border-box", flex: "none", background: T.panelBg, borderRight: `1px solid ${T.panelBorder}`,
      display: "flex", flexDirection: "column", zIndex: 1100, boxShadow: T.panelShadow,
    }}>
      <div style={{ padding: "10px 12px 6px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: T.textFaint, fontFamily: T.font, display: "flex", alignItems: "center", gap: 6 }}>
        <Layers size={11} /> Layers
        <div style={{ flex: 1 }} />
        <button title="Expand all groups"
          onClick={() => setCollapsed(new Set())}
          style={{ border: "none", background: "transparent", color: T.textFaint, cursor: "pointer", padding: 2, display: "flex", borderRadius: 4 }}>
          <UnfoldVertical size={12} />
        </button>
        <button title="Collapse all groups"
          onClick={() => setCollapsed(new Set(elements.filter((e) => e.type === "group").map((e) => e.id)))}
          style={{ border: "none", background: "transparent", color: T.textFaint, cursor: "pointer", padding: 2, display: "flex", borderRadius: 4 }}>
          <FoldVertical size={12} />
        </button>
      </div>
      <div ref={listRef} className="ed-scroll" style={{ flex: 1, overflowY: "auto", padding: "2px 6px 10px", position: "relative" }}>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: T.textFaint, fontSize: 12, fontFamily: T.font }}>
            <Layers size={20} style={{ opacity: 0.25, margin: "0 auto 8px", display: "block" }} />
            No elements yet
          </div>
        ) : rows.map((row, i) => {
          const el = row.el;
          const isGroup = el.type === "group";
          const Icon = TYPE_ICONS[el.type] || Square;
          const selected = selection.includes(el.id);
          const hovered = hoverId === el.id;
          const renaming = renamingId === el.id;
          const dropInto = drag && drag.target && drag.target.kind === "into" && drag.target.id === el.id;
          const lineBefore = drag && drag.target && drag.target.kind === "before" && drag.target.id === el.id;
          const indent = row.depth * 14;
          return (
            <div key={el.id}>
              {lineBefore ? <div style={{ height: 2, background: T.accent, borderRadius: 1, margin: "0 4px 0 " + (4 + indent) + "px" }} /> : null}
              <div
                ref={(n) => { rowRefs.current[el.id] = n; }}
                onClick={() => onSelect(el.id)}
                onDoubleClick={() => setRenamingId(el.id)}
                onMouseEnter={() => setHoverId(el.id)}
                onMouseLeave={() => setHoverId(null)}
                style={{
                  display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 6px 0 " + (6 + indent) + "px",
                  borderRadius: 6, cursor: "default", position: "relative",
                  background: dropInto ? "rgba(61,155,217,0.28)" : selected ? T.activeRow : hovered ? T.hover : "transparent",
                  boxShadow: dropInto ? `inset 0 0 0 1px ${T.accent}` : "none",
                  transition: `background ${T.ease}`,
                  opacity: drag && drag.id === el.id ? 0.4 : 1,
                }}>
                {selected ? <div style={{ position: "absolute", left: 0, top: 5, bottom: 5, width: 2, borderRadius: 1, background: T.accent }} /> : null}
                <span onPointerDown={(e) => startDrag(e, el.id)} title="Drag to reorder or reparent"
                  style={{
                    cursor: "grab", display: "flex", color: T.textFaint, touchAction: "none",
                    // Grips stay hidden until the row is hovered or selected — cleaner tree.
                    opacity: hovered || selected || (drag && drag.id === el.id) ? 1 : 0,
                    pointerEvents: hovered || selected ? "auto" : "none",
                    transition: `opacity ${T.ease}`,
                  }}>
                  <GripVertical size={12} />
                </span>
                {isGroup ? (
                  <span title={collapsed.has(el.id) ? "Expand" : "Collapse"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsed((prev) => { const n = new Set(prev); if (n.has(el.id)) n.delete(el.id); else n.add(el.id); return n; });
                    }}
                    style={{ display: "flex", color: T.textMut, cursor: "pointer", flex: "none" }}>
                    <ChevronRight size={12} style={{ transform: collapsed.has(el.id) ? "none" : "rotate(90deg)", transition: `transform ${T.ease}` }} />
                  </span>
                ) : null}
                <Icon size={13} strokeWidth={1.75} color={selected ? T.accent : T.textFaint} style={{ flex: "none" }} />
                {renaming ? (
                  <input autoFocus defaultValue={el.name}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = el.name; e.currentTarget.blur(); } }}
                    onBlur={(e) => { setRenamingId(null); if (e.target.value && e.target.value !== el.name) onRename(el.id, e.target.value); }}
                    style={{ ...inputBaseStyle(true), padding: "2px 5px", fontSize: 12 }} />
                ) : (
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: selected ? T.textHi : T.textMut, fontWeight: isGroup ? 600 : 400, fontFamily: T.font, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {el.name || el.id}
                  </span>
                )}
                {/* THE BUILD MARK, at the right edge. Deck only, and never while the row is being
                    renamed — the rename input owns the row's width there. */}
                {build && !renaming ? (() => {
                  // The row alone, or the whole SELECTION when this row is part of one — which is
                  // what lets two leaves of a group share a click (buildMarkTargets).
                  const targets = buildMarkTargets(el.id, selection, (id) => leavesUnder[id]);
                  const ids = targets.map((leaf) => leaf.id);
                  const state = buildRowState(build.steps, targets);
                  const many = selection.length > 1 && selection.includes(el.id) ? targets.length : 0;
                  const act = () => buildApply(state.kind === "step"
                    ? buildOrderRemove(buildOrder, ids)
                    : buildOrderAdd(buildOrder, ids));
                  return (
                    <BuildRowMark state={state} elId={el.id} selCount={many}
                      active={hovered || selected} focused={markFocus === el.id}
                      disabled={!!build.disabled} disabledHint={build.disabledHint}
                      tabStop={el.id === markStop}
                      markRef={(n) => { markRefs.current[el.id] = n; }}
                      nextOrdinal={buildAddOrdinal(buildOrder, ids)}
                      onFocus={() => { setMarkFocus(el.id); setMarkCaret(el.id); }}
                      onBlur={() => setMarkFocus((cur) => (cur === el.id ? null : cur))}
                      onKey={(e) => markKey(e, i, act, !!build.disabled)}
                      onActivate={act} />
                  );
                })() : null}
              </div>
            </div>
          );
        })}
        {drag && drag.target && drag.target.kind === "end" ? <div style={{ height: 2, background: T.accent, borderRadius: 1, margin: "0 4px" }} /> : null}
      </div>
      {build ? (
        <BuildOrderSection rows={buildNamedRows} disabled={!!build.disabled} disabledHint={build.disabledHint}
          onSelect={onSelectMany} onRemove={(ids) => buildApply(buildOrderRemove(buildOrder, ids))}
          onMove={(from, to) => buildApply(buildOrderMove(buildOrder, from, to))} />
      ) : null}
    </div>
  );
}

// ── Inspector ───────────────────────────────────────────────────────────────
function SQLVocabularyLoader({ onReady }) {
  const keywordQ = useSQLQuery("SELECT keyword_name FROM duckdb_keywords()", { enabled: !SQL_VOCABULARY_CACHE.keywords });
  const functionQ = useSQLQuery("SELECT DISTINCT function_name FROM duckdb_functions()", { enabled: !SQL_VOCABULARY_CACHE.functions });
  useEffect(() => {
    if (SQL_VOCABULARY_CACHE.keywords || !keywordQ.isSuccess || !Array.isArray(keywordQ.data)) return;
    SQL_VOCABULARY_CACHE.keywords = new Set(keywordQ.data.map((row) => String(row.keyword_name || "").toLowerCase()).filter(Boolean));
    onReady();
  }, [keywordQ.isSuccess, keywordQ.data, onReady]);
  useEffect(() => {
    if (SQL_VOCABULARY_CACHE.functions || !functionQ.isSuccess || !Array.isArray(functionQ.data)) return;
    SQL_VOCABULARY_CACHE.functions = new Set(functionQ.data.map((row) => String(row.function_name || "").toLowerCase()).filter(Boolean));
    onReady();
  }, [functionQ.isSuccess, functionQ.data, onReady]);
  return null;
}

function SQLRunQuery({ request, onDone }) {
  const q = useSQLQuery(request.sql);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    if (q.isSuccess) {
      done.current = true;
      onDone(request, { rows: Array.isArray(q.data) ? q.data : [] });
    } else if (q.isError) {
      done.current = true;
      onDone(request, { error: String((q.error && q.error.message) || "Query failed") });
    }
  }, [q.isSuccess, q.isError, q.data, q.error, request, onDone]);
  return null;
}

const SQL_TOKEN_STYLES = {
  keyword: { color: "#ff79c6" },
  function: { color: "#50fa7b" },
  string: { color: "#f1fa8c" },
  number: { color: "#bd93f9" },
  comment: { color: "#6272a4", fontStyle: "italic" },
  operator: { color: "#ff79c6" },
  identifier: { color: "#f8f8f2" },
  plain: { color: "#f8f8f2" },
};

function SQLEditor({ el, patchSql }) {
  const initialSql = String(el.sql || "");
  const [draft, setDraft] = useState(initialSql);
  const [status, setStatus] = useState({ kind: "unchanged", text: "unchanged" });
  const [runRequest, setRunRequest] = useState(null);
  const [vocabularyVersion, setVocabularyVersion] = useState(0);
  const [lineHeights, setLineHeights] = useState([SQL_EDITOR_LINE_HEIGHT]);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const textareaRef = useRef(null);
  const mirrorRef = useRef(null);
  const runButtonRef = useRef(null);
  const draftRef = useRef(initialSql);
  const syncedSqlRef = useRef(initialSql);
  const selectedIdRef = useRef(el.id);
  const requestCounter = useRef(0);
  const runningRef = useRef(null);

  useEffect(() => {
    const next = String(el.sql || "");
    if (selectedIdRef.current !== el.id) {
      selectedIdRef.current = el.id;
      draftRef.current = next;
      syncedSqlRef.current = next;
      setDraft(next);
      setStatus({ kind: "unchanged", text: "unchanged" });
      setRunRequest(null);
      runningRef.current = null;
      return;
    }
    if (draftRef.current === syncedSqlRef.current) {
      draftRef.current = next;
      setDraft(next);
    }
    syncedSqlRef.current = next;
  }, [el.id, el.sql]);

  const tokens = useMemo(() => tokenizeSQL(
    draft,
    SQL_VOCABULARY_CACHE.keywords || new Set(),
    SQL_VOCABULARY_CACHE.functions || new Set(),
  ), [draft, vocabularyVersion]);
  const tokenLines = useMemo(() => sqlTokenLines(tokens), [tokens]);
  const gutterCells = useMemo(() => sqlGutterCells(
    tokenLines.map((_, index) => lineHeights[index] || SQL_EDITOR_LINE_HEIGHT),
  ), [tokenLines, lineHeights]);

  const measureMirror = useCallback(() => {
    const mirror = mirrorRef.current;
    const textarea = textareaRef.current;
    if (!mirror || !textarea) return;
    const measured = [...mirror.querySelectorAll("[data-sql-line]")].map((node) => node.offsetHeight || SQL_EDITOR_LINE_HEIGHT);
    setLineHeights((previous) => JSON.stringify(previous) === JSON.stringify(measured) ? previous : measured);
    const gutter = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
    setScrollbarWidth((previous) => previous === gutter ? previous : gutter);
  }, []);
  useLayoutEffect(measureMirror, [measureMirror, draft, vocabularyVersion]);
  useEffect(() => {
    if (!mirrorRef.current || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measureMirror);
    observer.observe(mirrorRef.current);
    return () => observer.disconnect();
  }, [measureMirror]);

  const applyDraft = useCallback((next, nextCaret) => {
    draftRef.current = next;
    setDraft(next);
    setStatus(next === syncedSqlRef.current
      ? { kind: "unchanged", text: "unchanged" }
      : { kind: "pending", text: "changes not run" });
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }, []);

  // KNOWN, PRE-EXISTING, and deliberately left alone: pressing Run executes the query TWICE. Once
  // here, through SQLRunQuery, to report success/failure and hand the columns to the axis pickers —
  // and once more in the chart itself, whose own useSQLQuery re-runs the moment the new `sql` is
  // committed to the bag. Collapsing them means either the editor trusting the chart's hook for its
  // status line (which cannot report a failure before the chart has mounted the bad SQL) or a
  // shared result cache across two components with different lifetimes. Neither belongs in a pass
  // about inserting charts; do not rediscover it as a new bug. (Same family: mounting this editor
  // also fires the two vocabulary queries for highlighting, and edit mode re-runs a slide's charts
  // on every revisit because only present mode keeps a query pool.)
  const runDraft = useCallback(() => {
    const sql = draftRef.current;
    if (sql === syncedSqlRef.current) {
      setStatus({ kind: "unchanged", text: "unchanged" });
      return;
    }
    if (runningRef.current && runningRef.current.sql === sql) return;
    const request = { id: ++requestCounter.current, sql };
    runningRef.current = request;
    setRunRequest(request);
    setStatus({ kind: "running", text: "running…" });
  }, []);

  const onRunDone = useCallback((request, result) => {
    if (!runningRef.current || runningRef.current.id !== request.id) return;
    runningRef.current = null;
    setRunRequest(null);
    if (result.error) {
      const message = result.error.replace(/\s+/g, " ").trim();
      setStatus({ kind: "error", text: message || "Query failed" });
      return;
    }
    const committed = patchSql(request.sql);
    if (committed === false) {
      setStatus({ kind: "error", text: "Query ran, but the edit exceeds the override budget" });
      return;
    }
    const count = result.rows.length;
    setStatus(draftRef.current === request.sql
      ? { kind: "success", text: `${count.toLocaleString()} ${count === 1 ? "row" : "rows"}` }
      : { kind: "pending", text: "changes not run" });
  }, [patchSql]);

  const onKeyDown = (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = draftRef.current.slice(0, start) + "  " + draftRef.current.slice(end);
      applyDraft(next, start + 2);
    }
  };

  const commonTextStyle = {
    fontFamily: SQL_EDITOR_FONT,
    fontSize: SQL_EDITOR_FONT_SIZE,
    lineHeight: `${SQL_EDITOR_LINE_HEIGHT}px`,
    padding: SQL_EDITOR_PADDING,
    letterSpacing: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "normal",
    tabSize: 2,
    boxSizing: "border-box",
  };
  const statusColor = status.kind === "error" ? "#ff5555"
    : status.kind === "success" ? "#50fa7b"
    : status.kind === "running" ? "#8be9fd" : T.textFaint;

  return (
    <Section title="SQL">
      <SQLVocabularyLoader onReady={() => setVocabularyVersion((version) => version + 1)} />
      {runRequest ? <SQLRunQuery key={runRequest.id} request={runRequest} onDone={onRunDone} /> : null}
      <div style={{ position: "relative", height: 205, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, background: "#282a36", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.28)" }}>
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: 5 }}>
          <div style={{ position: "absolute", inset: "0 auto 0 0", width: 36, overflow: "hidden", background: "#21222c", borderRight: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ paddingTop: 10, paddingBottom: 10, transform: `translateY(${-scrollTop}px)` }}>
              {gutterCells.map((cell) => (
                <div key={cell.line} style={{ height: cell.height, paddingRight: 7, boxSizing: "border-box", color: "#6272a4", textAlign: "right", fontFamily: SQL_EDITOR_FONT, fontSize: SQL_EDITOR_FONT_SIZE, lineHeight: `${SQL_EDITOR_LINE_HEIGHT}px`, fontVariantNumeric: "tabular-nums" }}>
                  {cell.line}
                </div>
              ))}
            </div>
          </div>
          <div style={{ position: "absolute", left: 36, top: 0, right: 0, bottom: 0, overflow: "hidden" }}>
            <pre ref={mirrorRef} aria-hidden="true" style={{
              ...commonTextStyle, position: "absolute", left: 0, top: 0, right: scrollbarWidth, minHeight: "100%",
              margin: 0, color: "#f8f8f2", background: "transparent", pointerEvents: "none", userSelect: "none",
              transform: `translateY(${-scrollTop}px)`,
            }}>
              {tokenLines.map((line, lineIndex) => (
                <div key={lineIndex} data-sql-line="" style={{ minHeight: SQL_EDITOR_LINE_HEIGHT }}>
                  {line.length ? line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={SQL_TOKEN_STYLES[token.type]}>{token.text}</span>
                  )) : "\u200b"}
                </div>
              ))}
            </pre>
            <textarea ref={textareaRef} className="sql-editor-input ed-scroll" value={draft} spellCheck={false}
              aria-label="SQL" autoCapitalize="off" autoCorrect="off"
              onBlur={(event) => {
                if (event.relatedTarget === runButtonRef.current) return;
                if (draftRef.current !== syncedSqlRef.current) runDraft();
              }}
              onChange={(event) => {
                const next = event.target.value;
                draftRef.current = next;
                setDraft(next);
                setStatus(next === syncedSqlRef.current
                  ? { kind: "unchanged", text: "unchanged" }
                  : { kind: "pending", text: "changes not run" });
              }}
              onKeyDown={onKeyDown}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{
                ...commonTextStyle, position: "absolute", inset: 0, width: "100%", height: "100%", resize: "none",
                border: "none", outline: "none", margin: 0, background: "transparent", color: "transparent",
                WebkitTextFillColor: "transparent", caretColor: "#f8f8f2", overflow: "auto",
              }} />
          </div>
        </div>
      </div>
      <button ref={runButtonRef} onClick={runDraft} disabled={!!runRequest}
        style={{
          width: "100%", padding: "6px 9px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
          background: runRequest ? "#343746" : "#44475a", color: "#f8f8f2", cursor: runRequest ? "default" : "pointer",
          fontSize: 11.5, fontWeight: 600, fontFamily: T.font,
        }}>
        {runRequest ? "Running…" : "Run"}
      </button>
      <div role="status" style={{
        minHeight: 16, display: "flex", alignItems: "center", gap: 8,
        fontSize: 10.5, lineHeight: "16px", fontFamily: T.font,
      }}>
        <span title={status.text} style={{ color: statusColor, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {status.text}
        </span>
      </div>
    </Section>
  );
}

function ChartSection({ el, patchChart, cols }) {
  const cfg = el.chart || {};
  const st = cfg.style || {};
  const [textTarget, setTextTarget] = useState("title");
  const allCols = (cols && cols.cols) || [];
  const numCols = (cols && cols.numericCols) || [];
  const series = Array.isArray(cfg.series) ? cfg.series : [];
  const mut = (fn) => patchChart(el.id, fn);
  const isBar = cfg.kind === "bar" || cfg.kind === "barH";
  const isLineArea = cfg.kind === "line" || cfg.kind === "area";
  return (
    <>
      <SQLEditor el={el} patchSql={(sql) => patchChart(el.id, null, { sql })} />
      <Section title="Chart">
        <Row label="Type">
          <SelectFieldKV value={cfg.kind || "bar"} onChange={(v) => mut((c) => { c.kind = v; })}
            options={[["line", "Line"], ["bar", "Bar"], ["barH", "Horizontal bar"], ["area", "Area"], ["scatter", "Scatter"]]} />
        </Row>
        {cfg.kind !== "scatter" ? <ToggleRow label="Stacked" value={!!cfg.stacked} onChange={(v) => mut((c) => { c.stacked = v; if (!v) c.stackOffset = "none"; })} /> : null}
        {cfg.stacked && cfg.kind !== "scatter" ? (
          <ToggleRow label="100% stacked" value={cfg.stackOffset === "expand"} onChange={(v) => mut((c) => { c.stackOffset = v ? "expand" : "none"; })} />
        ) : null}
      </Section>
      <Section title="X axis">
        <Row label="Column">
          <SelectField value={(cfg.x && cfg.x.key) || null} options={allCols} availableOptions={allCols} placeholder="pick column"
            onChange={(v) => mut((c) => { c.x = { ...(c.x || {}), key: v }; })} />
        </Row>
        {cfg.kind !== "scatter" && cfg.kind !== "barH" ? (
          <Row label="Scale">
            <Seg small value={(cfg.x && cfg.x.type) || "category"} onChange={(v) => mut((c) => { c.x = { ...(c.x || {}), type: v }; })}
              options={[{ k: "category", label: "Cat" }, { k: "number", label: "Num" }, { k: "time", label: "Time" }]} />
          </Row>
        ) : null}
        <Row label="Label"><TextInput value={(cfg.x && cfg.x.label) || ""} placeholder="axis label" onCommit={(v) => mut((c) => { c.x = { ...(c.x || {}), label: v }; })} /></Row>
        <Row label="Angle">
          <SelectFieldKV value={String((cfg.x && cfg.x.tickAngle) || 0)} onChange={(v) => mut((c) => { c.x = { ...(c.x || {}), tickAngle: Number(v) }; })}
            options={[["0", "0°"], ["-30", "-30°"], ["-45", "-45°"], ["-90", "-90°"]]} />
        </Row>
        <Row label="Format">
          <SelectFieldKV value={(cfg.x && cfg.x.tickFormat) || "none"} onChange={(v) => mut((c) => { c.x = { ...(c.x || {}), tickFormat: v }; })}
            options={SQLTABLE_FORMAT_OPTS} />
        </Row>
      </Section>
      <Section title="Y axis">
        <Row label="Label"><TextInput value={(cfg.y && cfg.y.label) || ""} placeholder="axis label" onCommit={(v) => mut((c) => { c.y = { ...(c.y || {}), label: v }; })} /></Row>
        <Row label="Domain">
          <Seg small value={(cfg.y && cfg.y.domain) || "auto"} onChange={(v) => mut((c) => { c.y = { ...(c.y || {}), domain: v }; })}
            options={[{ k: "auto", label: "Auto" }, { k: "zero", label: "From 0" }]} />
        </Row>
        <Row label="Format">
          <SelectFieldKV value={(cfg.y && cfg.y.tickFormat) || "none"} onChange={(v) => mut((c) => { c.y = { ...(c.y || {}), tickFormat: v }; })}
            options={SQLTABLE_FORMAT_OPTS} />
        </Row>
      </Section>
      <Section title="Series">
        {series.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SelectField value={s.key || null} options={numCols.length ? numCols : allCols} availableOptions={allCols} placeholder="column"
                onChange={(v) => mut((c) => { c.series[i] = { ...c.series[i], key: v }; })} />
            </div>
            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(s.color || "") ? s.color : PALETTE[i % PALETTE.length]}
              onChange={(e) => mut((c) => { c.series[i] = { ...c.series[i], color: e.target.value }; })}
              title="Series color"
              style={{ width: 20, height: 20, padding: 0, border: `1px solid ${T.panelBorder}`, borderRadius: 4, background: "transparent", cursor: "pointer", flex: "none" }} />
            <button title="Remove series" onClick={() => mut((c) => { c.series.splice(i, 1); })}
              style={{ border: "none", background: "transparent", color: T.textFaint, cursor: "pointer", padding: 2, display: "flex" }}>
              <X size={12} />
            </button>
          </div>
        ))}
        {series.map((s, i) => (
          <Row key={"lbl" + i} label={`Label ${i + 1}`}>
            <TextInput value={s.label || ""} placeholder={s.key || "series label"} onCommit={(v) => mut((c) => { c.series[i] = { ...c.series[i], label: v }; })} />
          </Row>
        ))}
        <IconBtn icon={Plus} label="Add series" onClick={() => mut((c) => {
          c.series = c.series || [];
          const used = new Set(c.series.map((s) => s.key));
          const next = (numCols.length ? numCols : allCols).find((k) => !used.has(k) && k !== (c.x && c.x.key));
          c.series.push({ key: next || "", color: PALETTE[c.series.length % PALETTE.length] });
        })} />
      </Section>
      <Section title="Style">
        {isLineArea ? (
          <Row label="Curve">
            <Seg small value={st.lineType || "linear"} onChange={(v) => mut((c) => { c.style = { ...(c.style || {}), lineType: v }; })}
              options={[{ k: "linear", label: "Line" }, { k: "monotone", label: "Curve" }, { k: "step", label: "Step" }]} />
          </Row>
        ) : null}
        {isLineArea ? <Row label="Stroke"><NumField label="px" value={st.strokeWidth != null ? st.strokeWidth : 2} onCommit={(v) => mut((c) => { c.style = { ...(c.style || {}), strokeWidth: v }; })} /></Row> : null}
        {isLineArea ? <ToggleRow label="Dots" value={!!st.dot} onChange={(v) => mut((c) => { c.style = { ...(c.style || {}), dot: v }; })} /> : null}
        {cfg.kind === "area" ? <Row label="Fill α"><NumField label="%" value={R((st.fillOpacity != null ? st.fillOpacity : 0.25) * 100)} onCommit={(v) => mut((c) => { c.style = { ...(c.style || {}), fillOpacity: Math.max(0, Math.min(1, v / 100)) }; })} /></Row> : null}
        {isBar ? <Row label="Bar size"><NumField label="px" value={st.barSize || 0} onCommit={(v) => mut((c) => { c.style = { ...(c.style || {}), barSize: v > 0 ? v : null }; })} /></Row> : null}
        {isBar ? <Row label="Radius"><NumField label="px" value={st.radius || 0} onCommit={(v) => mut((c) => { c.style = { ...(c.style || {}), radius: v }; })} /></Row> : null}
        {cfg.kind === "scatter" ? (
          <Row label="Size by">
            <SelectField value={(cfg.scatter && cfg.scatter.sizeKey) || null} options={numCols} availableOptions={allCols} placeholder="uniform"
              onChange={(v) => mut((c) => { c.scatter = { ...(c.scatter || {}), sizeKey: v }; })} />
          </Row>
        ) : null}
        {isLineArea ? <ToggleRow label="Connect nulls" value={!!cfg.connectNulls} onChange={(v) => mut((c) => { c.connectNulls = v; })} /> : null}
      </Section>
      <Section title="Chrome">
        <ToggleRow label="Grid" value={!cfg.grid || cfg.grid.show !== false} onChange={(v) => mut((c) => { c.grid = { ...(c.grid || {}), show: v }; })} />
        <ToggleRow label="Legend" value={cfg.legend ? !!cfg.legend.show : series.length > 1} onChange={(v) => mut((c) => { c.legend = { ...(c.legend || {}), show: v }; })} />
        {(cfg.legend ? cfg.legend.show : series.length > 1) ? (
          <Row label="Position">
            <Seg small value={(cfg.legend && cfg.legend.position) || "top"} onChange={(v) => mut((c) => { c.legend = { ...(c.legend || {}), show: true, position: v }; })}
              options={[{ k: "top", label: "Top" }, { k: "bottom", label: "Bottom" }]} />
          </Row>
        ) : null}
        <ToggleRow label="Tooltip" value={!cfg.tooltip || cfg.tooltip.show !== false} onChange={(v) => mut((c) => { c.tooltip = { ...(c.tooltip || {}), show: v }; })} />
        <Row label="Title"><TextInput value={el.title || ""} placeholder="chart title" onCommit={(v) => patchChart(el.id, null, { title: v })} /></Row>
      </Section>
      <Section title="Text">
        <Seg small value={textTarget} onChange={setTextTarget}
          options={[{ k: "title", label: "Title" }, { k: "labels", label: "Axis labels" }, { k: "ticks", label: "Ticks" }]} />
        <TextStyleControls
          value={(cfg.text && cfg.text[textTarget]) || null}
          defaults={CHART_TEXT_DEFAULTS[textTarget]}
          showAlign={textTarget === "title"}
          onPatch={(p) => mut((c) => {
            const text = { ...(c.text || {}) };
            const cur = { ...(text[textTarget] || {}) };
            // Granular patch: a null value clears the key, so an untouched target leaves no
            // trace and `chart` prunes back to the baked value.
            for (const k of Object.keys(p)) { if (p[k] == null) delete cur[k]; else cur[k] = p[k]; }
            if (Object.keys(cur).length) text[textTarget] = cur; else delete text[textTarget];
            if (Object.keys(text).length) c.text = text; else delete c.text;
          })} />
      </Section>
    </>
  );
}

function SelectFieldKV({ value, options, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputBaseStyle(false), cursor: "pointer", appearance: "auto" }}>
      {options.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
    </select>
  );
}

// Header shown for a single selected element (leaf or group): icon + name + delete.
// The name renames in place on double-click, mirroring the layers tree.
function TableSection({ el, patch, table }) {
  const t = normTable(el);
  const rows = t.cells.length;
  const cell = table.cell && table.cell.id === el.id ? t.cells[table.cell.r][table.cell.c] : null;
  const at = table.cell && table.cell.id === el.id ? table.cell : null;
  const b = t.border;
  const setBorder = (changes) => patch(el.id, { border: { ...b, ...changes } });
  return (
    <>
      <Section title="Table">
        <Row label="Rows">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconBtn icon={Plus} title={at ? "Add a row below the selected cell" : "Add a row at the bottom"}
              onClick={() => table.rowCol(el.id, "row", at ? at.r + 1 : rows, false)} />
            <IconBtn icon={Trash2} title={at ? "Remove the selected cell's row" : "Remove the last row"} disabled={rows <= 1}
              onClick={() => table.rowCol(el.id, "row", at ? at.r : rows - 1, true)} />
            <span style={{ fontSize: 11.5, color: T.textMut, fontFamily: T.font }}>{rows}</span>
          </div>
        </Row>
        <Row label="Columns">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconBtn icon={Plus} title={at ? "Add a column right of the selected cell" : "Add a column at the end"}
              onClick={() => table.rowCol(el.id, "col", at ? at.c + 1 : t.cols, false)} />
            <IconBtn icon={Trash2} title={at ? "Remove the selected cell's column" : "Remove the last column"} disabled={t.cols <= 1}
              onClick={() => table.rowCol(el.id, "col", at ? at.c : t.cols - 1, true)} />
            <span style={{ fontSize: 11.5, color: T.textMut, fontFamily: T.font }}>{t.cols}</span>
          </div>
        </Row>
        <ToggleRow label="Borders" value={b.on} onChange={(v) => setBorder({ on: v })} />
        {b.on ? (
          <>
            <Row label="Color"><ColorField value={b.color} onCommit={(v) => setBorder({ color: v })} /></Row>
            <Row label="Width"><NumField label="px" value={b.width} onCommit={(v) => setBorder({ width: Math.max(1, Math.min(8, v)) })} /></Row>
          </>
        ) : null}
      </Section>
      {/* The cell block only appears once a cell is the cursor — double-click the table on the
          canvas to place it. Its controls are the SAME TextStyleControls every other text
          surface uses, so a cell and a heading offer the identical vocabulary. */}
      <Section title="Cell">
        {cell ? (
          <>
            <Row label="Cell">
              <span style={{ fontSize: 11.5, color: T.textMut, fontFamily: T.font }}>
                {`row ${at.r + 1}, col ${at.c + 1}`}
              </span>
            </Row>
            <TextStyleControls value={cell} defaults={{ fontSize: TABLE_DEFAULTS.fontSize, fontWeight: 400, color: TABLE_DEFAULTS.color, align: TABLE_DEFAULTS.align }}
              onPatch={(p) => table.cellPatch(el.id, at.r, at.c, p)} />
            <Row label="Col width">
              <NumField label="%" value={Math.round(t.colFracs[at.c] * 100)}
                onCommit={(v) => table.setTrack(el.id, "col", at.c, v)} />
            </Row>
            <Row label="Row height">
              <NumField label="%" value={Math.round(t.rowFracs[at.r] * 100)}
                onCommit={(v) => table.setTrack(el.id, "row", at.r, v)} />
            </Row>
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: T.textFaint, fontFamily: T.font, lineHeight: 1.5 }}>
            Double-click the table to edit cells. The selected cell&apos;s text and size settings appear here.
          </div>
        )}
      </Section>
    </>
  );
}

// The SQL table's inspector. The SAME shape as TableSection above wherever the two overlap — the
// Borders / Color / Width block is the same three controls in the same order writing the same key —
// and the SAME shape as ChartSection where the live-SQL half overlaps: SQLEditor first, then the
// element's own settings, with the column list playing the part the chart's Series list plays.
//
// The column list is driven by what the QUERY reported (`cols`), not by what `columns` happens to
// hold, so a column the author never touched is still offered and a formatting entry left behind by
// an older query simply stops appearing. One column at a time, like ChartSection's Text target: a
// 40-column result must not turn the panel into a mile of rows.
function SqlTableSection({ el, patch, cols }) {
  const [pick, setPick] = useState(null);
  const allCols = (cols && cols.cols) || [];
  const numericCols = (cols && cols.numericCols) || [];
  // The picker falls back to the FIRST reported column rather than to nothing, so the controls below
  // are never a row of dead inputs, and it re-falls-back when a query drops the column that was
  // picked — the same posture the chart's column pickers take.
  const column = pick && allCols.includes(pick) ? pick : (allCols[0] || null);
  const cfg = isPlainRecord(el.columns) ? el.columns : {};
  const entry = (column && isPlainRecord(cfg[column])) ? cfg[column] : {};
  const b = normTableBorder(el.border);
  const setBorder = (changes) => patch(el.id, { border: { ...b, ...changes } });
  // A granular write: a value equal to the default clears the key, and an emptied entry clears the
  // column, so a column the author reset leaves no trace in the URL. Same rule as ChartSection's
  // text targets — the reason `columns` is worth its own key is that it can prune back to nothing.
  //
  // Every write also DROPS entries for columns the current query does not return. Those entries were
  // unreachable: the picker only ever offers current columns, so nothing in the UI could reach them
  // to clear them, and they accumulated against the 40-column ceiling until formatting one live
  // column failed validation at Save time with no way back except hand-editing the URL. Gated on
  // `ran`, because a loading or errored query reports no columns and would otherwise wipe the whole
  // configuration the moment the author typed a bad statement.
  const setColumn = (changes) => {
    if (!column) return;
    const next = { ...entry };
    for (const key of Object.keys(changes)) {
      if (changes[key] == null || changes[key] === "") delete next[key]; else next[key] = changes[key];
    }
    const columns = sqlTablePruneColumns(cfg, cols);
    if (Object.keys(next).length) columns[column] = next; else delete columns[column];
    patch(el.id, { columns: Object.keys(columns).length ? columns : null });
  };
  // The core refuses `constructor`, `prototype` and `__proto__` as object keys everywhere, so a
  // column really called one of those cannot be given an entry — and DuckDB produces all three
  // happily (`SELECT 1 AS constructor`), two of them plausibly. Told to the AUTHOR here, with the
  // remedy, rather than left to surface as an internal-sounding INVALID_OVERRIDES at Save time.
  // Detecting it beats prefixing the stored keys: a prefix would retire the collision but would also
  // silently rewrite every `columns` entry already baked into every existing dive, and the entries
  // are author-visible in the JSON.
  const reserved = allCols.filter((name) => EDITABLE_DIVE_FORBIDDEN_KEYS.has(name));
  return (
    <>
      <SQLEditor el={el} patchSql={(sql) => patch(el.id, { sql })} />
      <Section title="Table">
        {/* THE ROW CAP, as a control rather than a surprise. The maximum is the core's, so the field
            cannot ask for a grid the Save boundary would refuse. */}
        {/* Named "Max rows", not "Rows": the manual table's Rows field is how many rows EXIST, and
            this is a cap on how many are DRAWN. One label meaning two things across two table
            inspectors is the kind of thing an author only discovers by being surprised. */}
        <Row label="Max rows">
          <NumField label="n" value={sqlTableLimit(el.limit)}
            onCommit={(v) => patch(el.id, { limit: sqlTableLimit(v) })} />
        </Row>
        <ToggleRow label="Header row" value={el.header !== false} onChange={(v) => patch(el.id, { header: v ? null : false })} />
        <ToggleRow label="Zebra" value={el.zebra !== false} onChange={(v) => patch(el.id, { zebra: v ? null : false })} />
        <ToggleRow label="Borders" value={b.on} onChange={(v) => setBorder({ on: v })} />
        {b.on ? (
          <>
            <Row label="Color"><ColorField value={b.color} onCommit={(v) => setBorder({ color: v })} /></Row>
            <Row label="Width"><NumField label="px" value={b.width} onCommit={(v) => setBorder({ width: Math.max(1, Math.min(8, v)) })} /></Row>
          </>
        ) : null}
        <Row label="Title"><TextInput value={el.title || ""} placeholder="table title" onCommit={(v) => patch(el.id, { title: v || null })} /></Row>
        {/* The cap bounds the DOM, not the transfer: the statement still runs in full, and only SQL
            can change that. Saying so here is the difference between a bounded grid and a lie. */}
        <div style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font, lineHeight: 1.5 }}>
          {`Draws at most ${EDITABLE_DIVE_MAX_TABLE_ROWS} rows. The query still runs in full — add LIMIT or aggregate in SQL to move less data.`}
        </div>
      </Section>
      <Section title="Columns">
        {allCols.length ? (
          <>
            <Row label="Column">
              <SelectField value={column} options={allCols} availableOptions={allCols} placeholder="pick column"
                onChange={(v) => setPick(v)} />
            </Row>
            <Row label="Label">
              <TextInput value={entry.label || ""} placeholder={column || "column"} onCommit={(v) => setColumn({ label: v })} />
            </Row>
            <Row label="Align">
              {/* The Seg shows what is DRAWN, not what is stored — an unset numeric column reads
                  "right", because that is where its digits are. Same resolver as the grid. */}
              <Seg small options={SQLTABLE_ALIGN_OPTS}
                value={sqlTableAlign(entry.align, numericCols.includes(column))}
                onChange={(v) => setColumn({ align: v })} />
            </Row>
            <Row label="Format">
              <SelectFieldKV value={entry.format || "none"} options={SQLTABLE_FORMAT_OPTS}
                onChange={(v) => setColumn({ format: v === "none" ? null : v })} />
            </Row>
          </>
        ) : cols && cols.ran ? (
          // The query RAN and reported nothing — a statement, not an instruction to do the thing that
          // just happened. The platform's useSQLQuery hands the renderer rows and no schema, so a
          // zero-row result genuinely carries no column names; saying so is the honest answer.
          <div style={{ fontSize: 11.5, color: T.textFaint, fontFamily: T.font, lineHeight: 1.5 }}>
            The query returned no rows, so it reported no columns. Formatting is per column and keyed
            by name, so it survives everything except renaming the column.
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: T.textFaint, fontFamily: T.font, lineHeight: 1.5 }}>
            Run the query to list its columns. Formatting is per column and keyed by name, so it
            survives everything except renaming the column.
          </div>
        )}
        {reserved.length ? (
          <div style={{ fontSize: 11, color: T.danger, fontFamily: T.font, lineHeight: 1.5 }}>
            {`Cannot format ${reserved.join(", ")}: reserved name${reserved.length > 1 ? "s" : ""}. Alias the column in SQL (SELECT x AS ${reserved[0]}_col) to format it.`}
          </div>
        ) : null}
      </Section>
      <Section title="Text">
        {/* The same control the manual table styles a CELL with, and the same one the chart styles
            its title with — one text vocabulary across every surface in the deck. */}
        <SqlTableTextControls el={el} patch={patch} />
      </Section>
    </>
  );
}

// Split out only so the target Seg can hold its own state without re-rendering the whole section.
function SqlTableTextControls({ el, patch }) {
  const [target, setTarget] = useState("cells");
  const styles = isPlainRecord(el.textStyles) ? el.textStyles : {};
  return (
    <>
      <Seg small value={target} onChange={setTarget}
        options={[{ k: "cells", label: "Cells" }, { k: "header", label: "Header" }, { k: "title", label: "Title" }]} />
      <TextStyleControls
        value={styles[target] || null}
        defaults={SQLTABLE_TEXT_DEFAULTS[target]}
        showAlign={target === "title"}
        onPatch={(p) => {
          const next = { ...(styles[target] || {}) };
          for (const key of Object.keys(p)) { if (p[key] == null) delete next[key]; else next[key] = p[key]; }
          const all = { ...styles };
          if (Object.keys(next).length) all[target] = next; else delete all[target];
          patch(el.id, { textStyles: Object.keys(all).length ? all : null });
        }} />
    </>
  );
}

function InspectorHeader({ el, onRename, onDelete, onDuplicate }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [el.id]);
  const Icon = TYPE_ICONS[el.type] || Square;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 10px", borderBottom: `1px solid ${T.panelBorder}` }}>
      <Icon size={14} color={T.accent} strokeWidth={1.75} style={{ flex: "none" }} />
      {editing ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <input autoFocus defaultValue={el.name || ""}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = el.name || ""; e.currentTarget.blur(); } }}
            onBlur={(e) => { setEditing(false); if (e.target.value && e.target.value !== el.name) onRename(e.target.value); }}
            style={{ ...inputBaseStyle(true), padding: "2px 5px", fontSize: 12 }} />
        </div>
      ) : (
        <span title="Double-click to rename" onDoubleClick={() => setEditing(true)}
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: T.textHi, fontFamily: T.font, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {el.name || el.id}
        </span>
      )}
      <IconBtn icon={Copy} title="Duplicate (⌘D)" onClick={onDuplicate} />
      <IconBtn icon={Trash2} title="Delete (⌫)" danger onClick={onDelete} />
    </div>
  );
}

// Align/distribute over the selection ROOTS. Distribute needs ≥3 to have a gap to equalize.
function AlignSection({ count, onAlign, onDistribute }) {
  return (
    <Section title="Align">
      <Row>
        <IconBtn icon={AlignStartVertical} title="Align left" onClick={() => onAlign("left")} />
        <IconBtn icon={AlignCenterVertical} title="Align horizontal centers" onClick={() => onAlign("centerX")} />
        <IconBtn icon={AlignEndVertical} title="Align right" onClick={() => onAlign("right")} />
        <IconBtn icon={AlignStartHorizontal} title="Align top" onClick={() => onAlign("top")} />
        <IconBtn icon={AlignCenterHorizontal} title="Align vertical centers" onClick={() => onAlign("centerY")} />
        <IconBtn icon={AlignEndHorizontal} title="Align bottom" onClick={() => onAlign("bottom")} />
      </Row>
      <Row>
        <IconBtn icon={AlignHorizontalDistributeCenter} label="Distribute H" disabled={count < 3}
          title={count < 3 ? "Distribute horizontally — needs 3 or more" : "Distribute horizontally (equal gaps)"}
          onClick={() => onDistribute("h")} />
        <IconBtn icon={AlignVerticalDistributeCenter} label="Distribute V" disabled={count < 3}
          title={count < 3 ? "Distribute vertically — needs 3 or more" : "Distribute vertically (equal gaps)"}
          onClick={() => onDistribute("v")} />
      </Row>
    </Section>
  );
}

// The Image section has two faces. Normally: asset / fit / alt / radius + a Crop button.
// While THIS element is the one being cropped (`crop.id`), it swaps to the crop controls —
// zoom, reset, Done — because crop is a mode, not a property.
function ImageSection({ el, patch, imageKeys, crop }) {
  const cropping = !!crop && crop.id === el.id;
  const canCrop = !!crop && crop.hasSrc(el);
  if (!cropping) {
    return (
      <Section title="Image">
        <Row label="Asset">
          {/* Swapping the asset drops any crop in the SAME commit: a pan/zoom framed for one
              image means nothing on another of a different size. */}
          <SelectField value={el.imageKey || null} options={imageKeys} placeholder="pick asset"
            onChange={(v) => patch(el.id, { imageKey: v, crop: null })} />
        </Row>
        <Row label="Fit">
          <Seg small value={el.fit || "cover"} onChange={(v) => patch(el.id, { fit: v })}
            options={[{ k: "cover", label: "Cover" }, { k: "contain", label: "Contain" }, { k: "fill", label: "Fill" }]} />
        </Row>
        <Row label="Alt"><TextInput value={el.alt || ""} placeholder="alt text" onCommit={(v) => patch(el.id, { alt: v })} /></Row>
        <Row label="Radius"><NumField label="px" value={el.radius || 0} onCommit={(v) => patch(el.id, { radius: Math.max(0, v) })} /></Row>
        <Row>
          <IconBtn icon={Crop} label="Crop" disabled={!canCrop}
            title={canCrop ? "Crop — zoom and drag to reframe" : "Crop needs a resolved image asset"}
            onClick={() => crop.start(el.id)} />
          {el.crop ? <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font }}>cropped</span> : null}
        </Row>
      </Section>
    );
  }
  const v = crop.value || DEFAULT_CROP;
  return (
    <Section title="Crop">
      <Row label="Zoom">
        <input type="range" min={CROP_ZOOM_MIN * 100} max={CROP_ZOOM_MAX * 100} step={5} value={R(v.zoom * 100)}
          onChange={(e) => crop.zoomLive(el.id, Number(e.target.value) / 100)}
          onPointerUp={() => crop.zoomCommit(el.id)}
          onKeyUp={() => crop.zoomCommit(el.id)}
          onBlur={() => crop.zoomCommit(el.id)}
          style={{ flex: 1, accentColor: T.accent, cursor: "pointer" }} />
        <span style={{ fontSize: 11, color: T.textMut, width: 32, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: T.font }}>
          {v.zoom.toFixed(1)}×
        </span>
      </Row>
      <div style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font }}>Drag the image to reposition</div>
      <Row>
        <IconBtn icon={RotateCcw} label="Reset crop" title="Clear the crop from this image" onClick={() => crop.reset(el.id)} />
      </Row>
      <button onClick={() => crop.done()}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%",
          padding: "7px 10px", border: "none", borderRadius: 6, cursor: "pointer",
          background: T.accent, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: T.font,
        }}>
        <Check size={14} strokeWidth={2} />
        Done
      </button>
    </Section>
  );
}

// The three slide-level fields with an inspector home. `notes` is the fourth patchable slide key
// and lives in the strip under the canvas instead (see NotesStrip).
//
// BACKGROUND writes `null`, not the colour, when the author picks the page background — because
// "absent" is precisely what falls back to `page.background`, so absent is the canonical way to
// say it. That is what lets a per-slide background be REMOVED rather than merely overwritten, and
// buildSlidePatched then prunes the whole entry for a slide whose baked record had no background
// of its own: set it, set it back, and the bag is empty again.
const SLIDE_LABEL_W = 70;
function SlideSection({ slide }) {
  return (
    <Section title={"Slide " + (slide.index + 1) + " of " + slide.count}>
      {/* "Background" is 65px wide — 13px past the default 52px slot, where it collided with the
          swatch. Both rows get the wider slot so their controls still start at the same x. */}
      <Row label="Name" labelWidth={SLIDE_LABEL_W}>
        <TextInput value={slide.name || ""} placeholder={"Slide " + (slide.index + 1)}
          onCommit={(v) => slide.patch({ name: v.trim() || null })} />
      </Row>
      <Row label="Background" labelWidth={SLIDE_LABEL_W}>
        <ColorField value={slide.background || slide.pageBackground}
          onCommit={(v) => slide.patch({ background: slideBackgroundWrite(v, slide.pageBackground) })} />
      </Row>
      {/* Named for what it DOES — present mode skips a hidden slide, and so does every navigation
          walk that reaches one — not for the flag ("Hidden"), which leaves "hidden from whom?" open. */}
      <ToggleRow label="Skip in present" value={!!slide.hidden} onChange={(v) => slide.patch({ hidden: v })} />
    </Section>
  );
}

function Inspector({ width, selection, elements, patch, patchChart, onDelete, orderCmd, imageKeys, chartCols, getH, onGroup, onUngroup, childCount, onDuplicate, onAlign, onDistribute, crop, table, slide, fitIdx }) {
  const sel = selection.map((id) => elements.find((e) => e.id === id)).filter(Boolean);
  const el = sel.length === 1 ? sel[0] : null;
  const isGroup = !!el && el.type === "group";
  return (
    <div className="ed-scroll" style={{
      // border-box, for the same reason the layers pane is, and with the same caveat: it hardens the
      // budget against a host page with no reset rather than fixing an error anyone measured here.
      width, boxSizing: "border-box", flex: "none", background: T.panelBg, borderLeft: `1px solid ${T.panelBorder}`,
      display: "flex", flexDirection: "column", zIndex: 1100, boxShadow: T.panelShadow, overflowY: "auto",
    }}>
      {!sel.length ? (
        <>
          {/* THE SLIDE SECTION lives in the nothing-selected state, which is what the reuse table
              promises and what makes it discoverable: an author with no element selected is looking
              at the slide, so that is what the inspector should be about. It is also the only spot
              that costs no space — the panel was showing a 48px-tall shrug. Notes are deliberately
              NOT here: they are prose, and prose belongs in the strip under the canvas where it has
              a paragraph's worth of room. */}
          {slide ? <SlideSection slide={slide} /> : null}
          <div style={{ padding: slide ? "28px 24px" : "48px 24px", textAlign: "center", color: T.textFaint, fontFamily: T.font }}>
            <MousePointer2 size={22} style={{ opacity: 0.25, margin: "0 auto 10px", display: "block" }} />
            <div style={{ fontSize: 12 }}>Select an element to edit its properties</div>
          </div>
        </>
      ) : sel.length > 1 ? (
        <>
          <Section title="Group selection">
            <div style={{ fontSize: 12, color: T.textMut, fontFamily: T.font }}>{sel.length} items selected</div>
            <Row>
              <IconBtn icon={Folder} label="Group" title="Group selection (⌘G)" onClick={onGroup} />
              <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font }}>⌘G</span>
            </Row>
            <Row>
              <IconBtn icon={Copy} label="Duplicate" title="Duplicate selection (⌘D)" onClick={onDuplicate} />
              <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font }}>⌘D</span>
            </Row>
          </Section>
          <AlignSection count={sel.length} onAlign={onAlign} onDistribute={onDistribute} />
        </>
      ) : isGroup ? (
        <>
          <InspectorHeader el={el} onRename={(v) => patch(el.id, { name: v })} onDelete={() => onDelete(selection)} onDuplicate={onDuplicate} />
          <Section title="Group">
            <div style={{ fontSize: 12, color: T.textMut, fontFamily: T.font }}>
              {childCount(el.id)} {childCount(el.id) === 1 ? "child" : "children"}
            </div>
            <Row>
              <IconBtn icon={Layers} label="Ungroup" title="Ungroup (⌘⇧G)" onClick={onUngroup} />
              <span style={{ fontSize: 11, color: T.textFaint, fontFamily: T.font }}>⌘⇧G</span>
            </Row>
          </Section>
          <Section title="Arrange">
            <Row>
              <IconBtn icon={ChevronsUp} title="Bring to front (⌘])" onClick={() => orderCmd("front")} />
              <IconBtn icon={ChevronUp} title="Bring forward (])" onClick={() => orderCmd("forward")} />
              <IconBtn icon={ChevronDown} title="Send backward ([)" onClick={() => orderCmd("backward")} />
              <IconBtn icon={ChevronsDown} title="Send to back (⌘[)" onClick={() => orderCmd("back")} />
            </Row>
          </Section>
        </>
      ) : (
        <>
          <InspectorHeader el={el} onRename={(v) => patch(el.id, { name: v })} onDelete={() => onDelete(selection)} onDuplicate={onDuplicate} />
          <Section title="Position & size">
            <Row>
              <NumField label="X" value={el.x} onCommit={(v) => patch(el.id, { x: v })} />
              <NumField label="Y" value={el.y} onCommit={(v) => patch(el.id, { y: v })} />
            </Row>
            <Row>
              <NumField label="W" value={el.w} onCommit={(v) => patch(el.id, { w: Math.max(8, v) })} />
              <NumField label="H" value={el.h === "auto" ? null : el.h} autoText={el.h === "auto" ? "auto" : null}
                onCommit={(v) => patch(el.id, { h: Math.max(8, v) })} />
            </Row>
          </Section>
          <Section title="Arrange">
            <Row>
              <IconBtn icon={ChevronsUp} title="Bring to front (⌘])" onClick={() => orderCmd("front")} />
              <IconBtn icon={ChevronUp} title="Bring forward (])" onClick={() => orderCmd("forward")} />
              <IconBtn icon={ChevronDown} title="Send backward ([)" onClick={() => orderCmd("backward")} />
              <IconBtn icon={ChevronsDown} title="Send to back (⌘[)" onClick={() => orderCmd("back")} />
            </Row>
            <Row label="Opacity">
              <input type="range" min={0} max={100} value={R((el.opacity != null ? el.opacity : 1) * 100)}
                onChange={(e) => patch(el.id, { opacity: Number(e.target.value) / 100 }, { coalesce: true })}
                style={{ flex: 1, accentColor: T.accent, cursor: "pointer" }} />
              <span style={{ fontSize: 11, color: T.textMut, width: 32, textAlign: "right", fontVariantNumeric: "tabular-nums", fontFamily: T.font }}>
                {R((el.opacity != null ? el.opacity : 1) * 100)}%
              </span>
            </Row>
          </Section>
          {el.type === "text" ? (
            <Section title="Text">
              {/* ONE control for ONE key: `level` is the block type and the list kinds are two more
                  of its values, so this Seg IS the list control. See the pure section for why. */}
              <Seg value={el.level || "p"} onChange={(v) => patch(el.id, { level: v })}
                options={[{ k: "h1", label: "H1" }, { k: "h2", label: "H2" }, { k: "h3", label: "H3" }, { k: "p", label: "P" },
                  { k: "ul", icon: List, title: "Bulleted list (Tab / ⇧Tab to indent)" },
                  { k: "ol", icon: ListOrdered, title: "Numbered list (Tab / ⇧Tab to indent)" },
                  { k: "code", label: "</>", title: "Code snippet (monospace, with a copy button)" },
                  { k: "link", label: "URL", title: "Link: the text is a URL that opens in a new tab" }]} />
              {/* Text elements store style as FLAT props; the bold toggle drives the numeric
                  `weight` ladder (on => 700, off => 400) which stays available below. */}
              <TextStyleControls
                value={{
                  fontSize: el.fontSize,
                  bold: el.weight != null ? el.weight >= 600 : undefined,
                  italic: el.italic, underline: el.underline,
                  align: el.align, color: el.color, highlight: el.highlight,
                }}
                defaults={{
                  fontSize: (LEVEL_STYLES[el.level] || LEVEL_STYLES.p).size,
                  fontWeight: (LEVEL_STYLES[el.level] || LEVEL_STYLES.p).weight,
                  color: "#231f20", align: "left",
                }}
                onPatch={(p) => patch(el.id, p.bold !== undefined ? { weight: p.bold ? 700 : 400 } : p)} />
              <Row label="Weight">
                <SelectFieldKV value={String(el.weight != null ? el.weight : (LEVEL_STYLES[el.level] || LEVEL_STYLES.p).weight)}
                  onChange={(v) => patch(el.id, { weight: Number(v) })}
                  options={[["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["650", "Semibold+"], ["700", "Bold"]]} />
              </Row>
              {/* THE MUTUAL EXCLUSION, as a control rather than a warning: both options write the
                  SAME key, so the modes cannot both be on. Turning autofit ON writes the height the
                  box is drawn at now, so nothing jumps; the shrink starts when the box gets shorter.
                  This row and the H field are two views of one value. */}
              <Row label="Fit">
                <Seg small value={el.h === "auto" ? "auto" : "fit"}
                  onChange={(v) => patch(el.id, { h: v === "auto" ? "auto" : Math.max(8, R(getH(el))) })}
                  options={[
                    { k: "auto", label: "Auto height", title: "The box grows to fit the text" },
                    { k: "fit", label: "Shrink to fit", title: "The text shrinks to fit a fixed-height box" },
                  ]} />
              </Row>
              {/* Why the type got smaller, in the author's units — without it, autofit is a box
                  that silently disagrees with the Size field above. */}
              {autofitOn(el) ? (
                <Row>
                  <span data-autofit-readout="1" style={{ fontSize: 11, color: T.textMut, fontFamily: T.font }}>
                    {autofitReadout(el, fitIdx ? fitIdx[el.id] : null)}
                  </span>
                </Row>
              ) : null}
            </Section>
          ) : null}
          {el.type === "image" ? <ImageSection el={el} patch={patch} imageKeys={imageKeys} crop={crop} /> : null}
          {el.type === "shape" ? (
            <Section title="Shape">
              {/* Writing null for the default clears the override entirely, so a shape left at
                  "Rectangle" / "Solid" leaves no trace in the URL. */}
              <Row label="Shape">
                <SelectFieldKV value={el.shape || "rect"} onChange={(v) => patch(el.id, { shape: v === "rect" ? null : v })}
                  options={SHAPE_KINDS.map((s) => [s.k, s.label])} />
              </Row>
              <Row label="Fill"><ColorField value={el.fill || "#eceff3"} onCommit={(v) => patch(el.id, { fill: v })} /></Row>
              <Row label="Border"><ColorField value={el.stroke || "#231f20"} onCommit={(v) => patch(el.id, { stroke: v })} /></Row>
              <Row label="Width"><NumField label="px" value={el.strokeWidth || 0} onCommit={(v) => patch(el.id, { strokeWidth: Math.max(0, v) })} /></Row>
              <Row label="Dash">
                <Seg small value={el.strokeDash || "solid"} options={DASH_OPTS}
                  onChange={(v) => patch(el.id, { strokeDash: v === "solid" ? null : v })} />
              </Row>
              {/* Radius is a rectangle-only property. */}
              {(el.shape || "rect") === "rect" ? (
                <Row label="Radius"><NumField label="px" value={el.radius || 0} onCommit={(v) => patch(el.id, { radius: Math.max(0, v) })} /></Row>
              ) : null}
            </Section>
          ) : null}
          {el.type === "line" ? (
            <Section title="Line">
              <Row label="Direction">
                <Seg small value={el.orientation || "h"} onChange={(v) => patch(el.id, { orientation: v })}
                  options={[{ k: "h", label: "Horizontal" }, { k: "v", label: "Vertical" }]} />
              </Row>
              <Row label="Color"><ColorField value={el.color || "#231f20"} onCommit={(v) => patch(el.id, { color: v })} /></Row>
              <Row label="Weight"><NumField label="px" value={el.thickness || 2} onCommit={(v) => patch(el.id, { thickness: Math.max(1, v) })} /></Row>
              <Row label="Dash">
                <Seg small value={el.dash || "solid"} options={DASH_OPTS}
                  onChange={(v) => patch(el.id, { dash: v === "solid" ? null : v })} />
              </Row>
              <Row label="Start">
                <SelectFieldKV value={el.capStart || "none"} options={CAP_OPTS}
                  onChange={(v) => patch(el.id, { capStart: v === "none" ? null : v })} />
              </Row>
              <Row label="End">
                <SelectFieldKV value={el.capEnd || "none"} options={CAP_OPTS}
                  onChange={(v) => patch(el.id, { capEnd: v === "none" ? null : v })} />
              </Row>
            </Section>
          ) : null}
          {el.type === "chart" ? <ChartSection el={el} patchChart={patchChart} cols={chartCols[el.id]} /> : null}
          {el.type === "table" ? <TableSection el={el} patch={patch} table={table} /> : null}
          {el.type === "sqltable" ? <SqlTableSection el={el} patch={patch} cols={chartCols[el.id]} /> : null}
        </>
      )}
    </div>
  );
}

// ── Speaker notes strip ─────────────────────────────────────────────────────
// A collapsible strip UNDER THE CANVAS, in the canvas column only — not spanning the rail or the
// panes, because notes belong to the slide the author is looking at, the way Slides has it.
//
// NEVER IN PRESENT MODE, and there is no presenter view in v1: a presenter view needs a second
// window showing different content in lockstep, and the dive runs in a sandboxed cross-origin
// iframe that cannot open or coordinate one (plan §5). So `notes` has exactly one reader — this
// strip — and PresentShell never asks for it.
//
// OPEN STATE IS EPHEMERAL: `useState` in the root, not `useDiveState`, and never a bag key. It is a
// viewport preference for this session, the same class as `activeSlideId`, `activeCell` and
// `croppingId` — a panel that was open when someone saved must not make everyone who opens the URL
// see an open panel, and it must not cost URL bytes.
//
// TYPING HERE CANNOT REACH THE CANVAS. Two independent guards: the editor's global key handler
// returns early for `isTypingTarget(document.activeElement)`, which tests TEXTAREA by name, and
// this textarea also stops its own keydown from propagating (the same belt-and-braces the rail's
// rename field wears). Without either one, Backspace would delete the selected element and ⌘D
// would duplicate it while someone wrote a sentence.
const NOTES_STRIP_H = 132;      // open height of the strip, including its header row
const NOTES_HEADER_H = 26;
// `disabled` covers both states in which there is nothing to write to: no live slide, and a STALE
// bag — whose writes mergeScene throws away wholesale, so a field that looked editable would have
// swallowed a paragraph in silence. `disabledHint` says which, in the placeholder, because a
// greyed-out field with no sentence is just a broken field.
function NotesStrip({ open, onToggle, notes, onCommit, slideLabel, disabled, disabledHint }) {
  const text = notes || "";
  return (
    <div data-notes-strip={open ? "open" : "closed"} style={{
      flex: "none", height: open ? NOTES_STRIP_H : NOTES_HEADER_H,
      display: "flex", flexDirection: "column",
      background: T.panelBg, borderTop: `1px solid ${T.panelBorder}`,
      transition: `height ${T.ease}`, overflow: "hidden",
    }}>
      <button data-notes-toggle="1" onClick={onToggle}
        title={open ? "Hide speaker notes" : "Show speaker notes"}
        style={{
          flex: "none", height: NOTES_HEADER_H, display: "flex", alignItems: "center", gap: 6,
          padding: "0 10px", border: "none", background: "transparent", cursor: "pointer",
          color: T.textFaint, fontSize: 10, fontWeight: 600, textTransform: "uppercase",
          letterSpacing: "0.07em", fontFamily: T.font, textAlign: "left",
        }}>
        {open ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
        <StickyNote size={11} /> Speaker notes
        {/* A closed strip still has to say whether there ARE notes, or the author has to open it on
            every slide to find out. The dot is the cheapest honest answer. */}
        {!open && text ? (
          <span data-notes-dot="1" title="This slide has notes"
            style={{ width: 5, height: 5, borderRadius: 999, background: T.accent, flex: "none" }} />
        ) : null}
        <div style={{ flex: 1 }} />
        <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: T.textFaint }}>
          {slideLabel}
        </span>
      </button>
      {open ? (
        <textarea data-notes-input="1" value={text} spellCheck disabled={disabled}
          placeholder={disabled ? (disabledHint || "No slide") : "Notes for the presenter — never shown in present mode"}
          onChange={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            flex: 1, minHeight: 0, resize: "none", margin: "0 10px 10px", padding: "6px 8px",
            background: T.inputBg, color: T.textHi, fontSize: 12, lineHeight: 1.5,
            fontFamily: T.font, border: `1px solid ${T.panelBorder}`, borderRadius: 4, outline: "none",
          }} />
      ) : null}
    </div>
  );
}

// ── Selection overlay, guides, toast ────────────────────────────────────────
function SelectionOverlay({ selection, hoverId, elements, rectOf, editingTextId, onHandlePointerDown, marquee, croppingId }) {
  const items = [];
  const byId = {};
  for (const e of elements) byId[e.id] = e;
  const outline = (key, r) => (
    <div key={key} style={{
      position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
      boxShadow: `0 0 0 1px rgba(61,155,217,0.55)`, pointerEvents: "none", zIndex: 2,
    }} />
  );
  const hoverEl = hoverId && !selection.includes(hoverId) ? byId[hoverId] : null;
  if (hoverEl) {
    const hr = rectOf(hoverId);
    if (hr) items.push(outline("hover", hr));
  }
  // Live marquee preview: outline what a release would select.
  if (marquee && marquee.preview) {
    marquee.preview.forEach((id) => {
      if (selection.includes(id) || id === hoverId) return;
      const r = rectOf(id);
      if (r) items.push(outline("mq-" + id, r));
    });
  }
  selection.forEach((id) => {
    const el = byId[id];
    if (!el) return;
    const r = rectOf(id);
    if (!r) return;
    const single = selection.length === 1;
    const editingThis = editingTextId === id;
    const isGroup = el.type === "group";
    // Crop mode gets its own affordance — a dashed accent ring outside the solid selection
    // ring — so it is obvious that a drag inside will pan the picture, not move the element.
    const cropping = croppingId === id;
    items.push(
      <div key={id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, pointerEvents: "none", zIndex: 3 }}>
        <div style={{
          position: "absolute", inset: 0, boxShadow: `0 0 0 1.5px ${T.selection}`,
          outline: cropping ? `2px dashed ${T.accent}` : undefined,
          outlineOffset: cropping ? 3 : undefined,
        }} />
        {single || isGroup ? (
          <div style={{
            position: "absolute", top: -24, left: -1.5, display: "flex", alignItems: "center", gap: 4,
            background: "rgba(35,35,39,0.85)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            color: "#fff", fontSize: 11, fontFamily: T.font, padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap",
          }}>
            {cropping ? "Cropping — " : ""}{el.name || el.id}
          </div>
        ) : null}
        {single && !isGroup && !editingThis && !cropping ? HANDLE_DEFS
          .filter((hd) => (el.type === "text" ? hd.ay === 0 && hd.ax !== 0 : true))
          .map((hd) => (
            <div key={hd.k}
              onPointerDown={(e) => onHandlePointerDown(e, el, hd)}
              style={{
                position: "absolute",
                left: ((hd.ax + 1) / 2) * r.w - 5,
                top: ((hd.ay + 1) / 2) * r.h - 5,
                width: 10, height: 10, background: "#fff",
                border: `1px solid ${T.selection}`, borderRadius: 2,
                boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                cursor: hd.cursor, pointerEvents: "auto", touchAction: "none",
              }} />
          )) : null}
      </div>
    );
  });
  if (marquee && marquee.rect) {
    const m = marquee.rect;
    items.push(
      <div key="marquee" style={{
        position: "absolute", left: m.x, top: m.y, width: m.w, height: m.h,
        border: `1px solid ${T.accent}`, background: "rgba(61,155,217,0.08)",
        pointerEvents: "none", zIndex: 4,
      }} />
    );
  }
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 500 }}>{items}</div>;
}

// THE AUTHOR'S VIEW OF THE STEPS, and the decision the brief asked for: the numbers go ON the
// slide, one chip per built leaf, straddling its top-right corner.
//
// Why here and not a list or an ordering:
//   • Builds are FULLY VISIBLE while authoring (that is the other half of the feature — you cannot
//     lay out what you cannot see), so without the chips a built slide and an unbuilt one are
//     pixel-identical and the whole feature is invisible until you present.
//   • The question an author actually asks is spatial — "does the KPI row come before the chart?" —
//     and a chip on the thing answers it in one glance, at every zoom, for every step at once. A
//     sorted list in a panel answers a different question and costs a lookup per row.
//   • The LAYERS tree alone would be the wrong home: its rows are ordered by canvas reading order,
//     so one step's members are scattered down the list and the numbers read as noise on their own.
//     (The tree DOES carry a mark per row now — but it answers "is this one built", one row at a
//     time, which is a different question from the spatial sweep these chips give.)
// The chip carries the ORDINAL, not the stored value (buildOrdinal), and so does everything else in
// the editor: there is no longer anywhere the raw value is shown, because every write normalises it
// to the ordinal (buildWritePlan). The title still carries both, which is the only place the two can
// be seen to differ on a deck authored by hand.
//
// Nothing here is interactive — a badge that selected its element would be one more small target to
// hit by accident on a crowded slide, and clicking the element already selects it.
function BuildBadges({ leaves, steps, rectOf }) {
  const chips = [];
  for (const el of leaves) {
    const step = normBuild(el.build);
    if (step === BUILD_NONE) continue;
    const box = buildBadgeBox(rectOf(el.id));
    if (!box) continue;
    const ord = buildOrdinal(steps, step);
    chips.push(
      <div key={el.id} data-build-badge={String(ord)} data-build-badge-el={el.id}
        title={`Build step ${ord} of ${steps.length} — appears on input ${ord} of this slide (build: ${step})`}
        style={{
          position: "absolute", left: box.left, top: box.top, width: box.size, height: box.size,
          borderRadius: box.size / 2, background: T.accent, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, fontFamily: T.font, fontVariantNumeric: "tabular-nums",
          boxShadow: "0 1px 3px rgba(0,0,0,0.45)", lineHeight: 1,
        }}>{ord}</div>
    );
  }
  if (!chips.length) return null;
  // Under the selection overlay's zIndex 500 on purpose: a resize handle must stay hittable, and a
  // badge is a label, not a control.
  return <div data-build-badges="1" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 450 }}>{chips}</div>;
}

function SnapGuides({ guides, page }) {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 600 }}>
      {(guides.x || []).map((x, i) => (
        <div key={"x" + i} style={{ position: "absolute", left: x, top: 0, width: 1, height: page.height, background: T.guide }} />
      ))}
      {(guides.y || []).map((y, i) => (
        <div key={"y" + i} style={{ position: "absolute", top: y, left: 0, height: 1, width: page.width, background: T.guide }} />
      ))}
    </div>
  );
}

function Toast({ text }) {
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      background: "rgba(35,35,39,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
      color: T.textHi, fontSize: 12.5, fontFamily: T.font, padding: "9px 16px", borderRadius: 8,
      boxShadow: T.panelShadow, zIndex: 2000, maxWidth: 480, textAlign: "center",
    }}>{text}</div>
  );
}

// The Save confirmation and its outcome. One dialog, four phases, so the author sees the whole
// lifecycle of the run they asked for: confirm -> saving -> saved | failed.
function SaveDialog({ phase, count, summary, runStatus, message, onConfirm, onCancel, onReload }) {
  const btn = (primary) => ({
    border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 12.5, fontWeight: 600, fontFamily: T.font,
    cursor: "pointer", background: primary ? T.accent : T.inputBg, color: primary ? "#fff" : T.textHi,
  });
  const line = (label, n) => (n ? <div style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{n}</span></div> : null);
  const s = summary || {};
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={phase === "confirm" || phase === "failed" ? onCancel : undefined}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Save edits"
        style={{ width: 400, maxWidth: "90vw", background: T.panelBg, borderRadius: 10, boxShadow: T.panelShadow, padding: 20, color: T.textHi, fontFamily: T.font }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 650, marginBottom: 10 }}>
          {phase === "failed" ? <AlertTriangle size={16} color={T.danger} /> : phase === "saved" ? <Check size={16} color="#3ecf8e" /> : <Save size={16} color={T.accent} />}
          {phase === "confirm" ? `Save ${count} edit${count === 1 ? "" : "s"}?` : phase === "saving" ? "Saving…" : phase === "saved" ? "Saved" : "Save failed"}
        </div>
        {phase === "confirm" ? (
          <>
            <div style={{ fontSize: 12.5, color: T.textMut, lineHeight: 1.5, marginBottom: 12 }}>
              This writes version {s.newVersion} of the deck for everyone who opens it, then reloads the Dive.
            </div>
            <div style={{ fontSize: 12.5, color: T.textHi, background: T.inputBg, borderRadius: 6, padding: "8px 10px", display: "grid", gap: 3, marginBottom: 16 }}>
              {line("Elements changed", s.patched)}
              {line("Elements added", s.added)}
              {line("Elements deleted", s.deleted)}
              {line("Slides added", s.slidesAdded)}
              {line("Slides deleted", s.slidesDeleted)}
              {!s.patched && !s.added && !s.deleted && !s.slidesAdded && !s.slidesDeleted ? <span>Slide settings and order</span> : null}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btn(false)} onClick={onCancel}>Keep editing</button>
              <button style={btn(true)} onClick={onConfirm} autoFocus>Save and reload</button>
            </div>
          </>
        ) : null}
        {phase === "saving" ? (
          <div style={{ fontSize: 12.5, color: T.textMut, lineHeight: 1.5 }}>
            The save Flight is {runStatus === "RUNNING" ? "baking your edits into the Dive" : "starting"}. Keep this tab open.
          </div>
        ) : null}
        {phase === "saved" ? (
          <>
            <div style={{ fontSize: 12.5, color: T.textMut, lineHeight: 1.5, marginBottom: 16 }}>
              Version {s.newVersion} is live. Reload to keep editing on top of it.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={btn(true)} onClick={onReload} autoFocus>Reload</button>
            </div>
          </>
        ) : null}
        {phase === "failed" ? (
          <>
            <div style={{ fontSize: 12.5, color: T.textMut, lineHeight: 1.5, marginBottom: 16 }}>{message}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={btn(false)} onClick={onCancel} autoFocus>Close</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CopyModal({ text, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "90vw", background: T.panelBg, borderRadius: 10, boxShadow: T.panelShadow, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.textHi, fontFamily: T.font }}>Overrides JSON — copy manually</span>
          <div style={{ flex: 1 }} />
          <IconBtn icon={X} title="Close" onClick={onClose} />
        </div>
        <textarea readOnly value={text} onFocus={(e) => e.target.select()}
          style={{ ...inputBaseStyle(false), height: 220, resize: "none", fontSize: 11, lineHeight: 1.5 }} />
      </div>
    </div>
  );
}

// ── Present mode (the published view of a deck) ──────────────────────────────
// One slide at a time, fit to the host viewport and letterboxed. The DESIGNED-FOR case is filling
// a sandboxed iframe of whatever size the host gives us; fullscreen is a bonus that may be denied
// and never a requirement. The pure arithmetic behind all of it is in the present-mode pure
// section above.
//
// It owns ALL of its key handling and nothing else's. The editor's global handler returns
// immediately when editMode is false, and this listener exists only while PresentShell is mounted
// (which is only ever when editMode is false), so the two can never both claim an arrow key. Both
// consult the same isTypingTarget guard, so neither steals a keystroke from a field.

const PRESENT_BACKDROP = "#0f1012"; // the letterbox surround: neutral, never the slide's own colour

// Attempt, never depend. A cross-origin iframe without `allow="fullscreen"` rejects this, and the
// catch is what keeps the denial out of the console as an unhandled rejection. Called only from a
// real user gesture (the chrome's button, or the click that opened present mode from the editor) —
// a call with no user activation behind it is guaranteed to fail and Chrome logs it.
function tryFullscreen(node) {
  if (!node || typeof node.requestFullscreen !== "function") return;
  try {
    const p = node.requestFullscreen();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* denied — the viewport fill below is already the finished look */ }
}

function leaveFullscreen(node) {
  if (typeof document === "undefined" || !document.fullscreenElement) return;
  if (node && document.fullscreenElement !== node) return;
  try {
    const p = document.exitFullscreen();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* nothing to leave */ }
}

// ONE useSQLQuery, no DOM. The shell mounts one of these per ADMITTED statement (presentAdmit
// decides which and how many), so the nearest queries are in flight before the presenter touches a
// key; results land in the shell's pool and are shared by every chart that uses that SQL. The
// mounted set only ever grows — unmounting this component would abort its request. Rendering null
// is the point: a warm result costs no Recharts tree and no layout.
function PresentQuery({ sql, publish }) {
  const q = useSQLQuery(sql);
  const rows = Array.isArray(q.data) ? q.data : EMPTY_ROWS;
  useEffect(() => {
    publish(sql, { rows, isLoading: q.isLoading, isError: q.isError, error: q.error });
  }, [publish, sql, rows, q.isLoading, q.isError, q.error]);
  return null;
}

// A chart whose statement is in the want set but whose PresentQuery has not published yet — either
// the first render pass before any effect has run, or a statement still queued behind the in-flight
// budget. Membership is decided by `poolSet`, never by "has it published", because the latter would
// render an own-hook fallback for one pass and fire a SECOND copy of every query on load before
// immediately unmounting it.
const PRESENT_PENDING = { rows: EMPTY_ROWS, isLoading: true, isError: false, error: null };
const PRESENT_NO_REPORT = () => {}; // present mode has no inspector, so nothing consumes columns
// One shared empty list for the shell's two list-shaped states (the fading layers, the admitted
// statements), so "nothing yet" has a stable identity and no effect keyed on either re-runs.
const PRESENT_EMPTY = [];

// The one chart in present mode that owns its own query: SQL the pool's want set does not carry at
// all (a chart on a slide present mode cannot reach, which only a layer for the outgoing entry
// slide can put on screen). It PUBLISHES into the shell's pool, which is what makes a revisit warm:
// the parent then reads the settled entry and stops mounting this component, so the statement runs
// once per session instead of once per visit — and, unlike a hook that lives in the chart, a
// navigation away mid-flight is the only thing that can discard it.
function PresentOwnQuery({ el, publish }) {
  const q = useSQLQuery(el.sql);
  const rows = Array.isArray(q.data) ? q.data : EMPTY_ROWS;
  useEffect(() => {
    publish(el.sql, { rows, isLoading: q.isLoading, isError: q.isError, error: q.error });
  }, [publish, el.sql, rows, q.isLoading, q.isError, q.error]);
  return <ChartSurface el={el} rows={rows} isLoading={q.isLoading} isError={q.isError} error={q.error} />;
}

// The mount window needs no gate HERE: a slide outside it has no layer, so its charts have no DOM
// at all — stronger than rendering them behind a placeholder, and one less prop to keep honest.
function PresentChart({ el, pool, poolSet, publish }) {
  // Own-property for the same reason presentAdmit's `settled` is: a statement named after an
  // Object.prototype member would otherwise resolve to a function and be drawn as a settled result.
  const entry = el.sql && Object.hasOwn(pool, el.sql) ? pool[el.sql] : null;
  // SETTLED in the pool: draw from the cache with no hook of any kind. This branch is what "never
  // re-runs, never shows a second skeleton" means, and it covers a revisit by either path below.
  if (entry && !entry.isLoading) {
    return <ChartSurface el={el} rows={entry.rows} isLoading={false} isError={entry.isError} error={entry.error} />;
  }
  // In the want set: the pool owns this statement — running now, or queued behind the budget.
  // Either way the honest answer is the pulse, and navigation waits on nothing.
  if (el.sql && poolSet.has(el.sql)) {
    const pending = entry || PRESENT_PENDING;
    return <ChartSurface el={el} rows={pending.rows} isLoading={pending.isLoading} isError={pending.isError} error={pending.error} />;
  }
  if (el.sql) return <PresentOwnQuery el={el} publish={publish} />;
  // No SQL at all — a chart element mid-configuration. ChartBlock renders the same surface.
  return <ChartBlock el={el} reportCols={PRESENT_NO_REPORT} />;
}

// A present-mode element is a picture: no refs, no pointer handlers, no editing — the same shape
// as ThumbElement, but charts and tables draw for real.
//
// A leaf waiting for its build step is drawn and MOUNTED at opacity 0, never omitted: its chart's
// query has to be settled by the time the click arrives, and an element that entered the DOM on
// reveal would have nothing to transition FROM. `cut` is the slide's revealed cutoff; `revealMs` is
// 0 on a navigation commit and the one fade duration on a reveal (buildRevealMs).
function PresentElement({ el, imageMap, pool, poolSet, publish, cut, revealMs, visible }) {
  const h = el.h === "auto" ? undefined : el.h;
  const shown = buildShown(el, cut);
  const content =
    el.type === "text" ? <TextContent el={el} editing={false} copyLive={!!visible && shown} />
    : el.type === "image" ? <ImageContent el={el} imageMap={imageMap} crop={normCrop(el.crop)} />
    : el.type === "shape" ? <ShapeContent el={el} />
    : el.type === "line" ? <LineContent el={el} w={el.w} h={h} />
    : el.type === "table" ? <TableContent el={el} editing={false} />
    // Both live types go through the pool: PresentChart is named for the first one that needed it,
    // but everything in it is about a STATEMENT, and ChartSurface picks the renderer from the type.
    : isLiveSQL(el) ? <PresentChart el={el} pool={pool} poolSet={poolSet} publish={publish} />
    : null;
  return (
    <div data-elid={el.id} data-build={normBuild(el.build) || undefined}
      data-build-shown={shown ? "1" : undefined} style={{
      position: "absolute", left: el.x, top: el.y, width: el.w, height: h,
      // The author's own opacity is the element's FULL value; a hidden build step is 0 regardless.
      opacity: shown ? (el.opacity != null ? el.opacity : 1) : 0,
      transition: `opacity ${revealMs}ms linear`,
    }}>{content}</div>
  );
}

// One slide, drawn at page size inside the scaled stage. Stacking is by zIndex, not DOM order, so
// the layer list can stay in slide order across a navigation — moving a node between children
// would risk restarting the very transition this component exists to run.
//
// Memoized on the leaf ARRAY identity that groupLeavesBySlide keeps stable per slide, the same
// memo the filmstrip relies on.
const PresentLayer = memo(function PresentLayer({ slideId, els, background, page, imageMap, pool, poolSet, publish, visible, fading, cut, revealMs }) {
  return (
    <div data-present-slide={slideId} data-present-visible={visible ? "1" : undefined} style={{
      position: "absolute", left: 0, top: 0, width: page.width, height: page.height,
      background, overflow: "hidden", pointerEvents: "none",
      opacity: visible ? 1 : 0,
      zIndex: fading ? 2 : visible ? 1 : 0,
      // THE one transition. Only the OUTGOING layer animates: the incoming slide is already at
      // full opacity underneath it, so the crossfade never dips through the backdrop the way two
      // simultaneous fades would. Every other layer is an invisible pre-mount and switches hard.
      transition: `opacity ${fading ? PRESENT_FADE_MS : 0}ms linear`,
    }}>
      {els.map((el) => (
        <PresentElement key={el.id} el={el} imageMap={imageMap} pool={pool} poolSet={poolSet} publish={publish}
          cut={cut} revealMs={revealMs} visible={visible} />
      ))}
    </div>
  );
});

function PresentChromeBtn({ icon: Icon, title, onClick, disabled }) {
  const [hov, setHov] = useState(false);
  return (
    <button title={title} disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 22,
        border: "none", borderRadius: 5, background: hov && !disabled ? "rgba(255,255,255,0.12)" : "transparent",
        color: disabled ? "rgba(255,255,255,0.3)" : "#fff", cursor: disabled ? "default" : "pointer",
      }}>
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}

// THE way out, and it sits in the SAME PLACE the presentation was started from — the top of the
// window, left-aligned at the inset the editor's chrome uses, rather than tucked into the nav
// cluster in the bottom-right corner. A presenter's eye goes to the top-left for "get me out of
// here" (it is where every fullscreen player's close control and the browser's own back button
// live), and it is where the author clicked Present a moment earlier.
//
// It says where it LANDS, not what it closes — "Exit Presentation", and exiting now lands in the
// editor, on the slide that was on screen. It is also deliberately QUIETER than the pill it
// replaces, which sat at full opacity and read as part of the deck: the subtlety is carried by SIZE
// and by a resting opacity of 0.65, NOT by hiding it, because the version that hid until hover (the
// nav cluster's 0.32) left a viewer on a cold published URL with no visible exit at all. The chip is
// darker to pay for the dimming, so the LABEL still reads: measured 4.7:1 against a white slide and
// 8.3:1 against a near-black one at rest (SLEDV pins both), and full contrast the moment a pointer
// or the keyboard arrives.
function PresentExitBtn({ onClick }) {
  const [lit, setLit] = useState(false);
  return (
    <div data-present-chrome="1"
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      // Left 12 is the top bar's own inset; top 12 lands the 25px pill on the SAME 24px centreline
      // the 48px top bar centres its controls on — including the Present button that opened this.
      style={{ position: "absolute", left: 12, top: 12, zIndex: 10 }}>
      <button data-present-exit="1" title="Exit the presentation and go back to editing (Esc)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onMouseEnter={() => setLit(true)} onMouseLeave={() => setLit(false)}
        onFocus={() => setLit(true)} onBlur={() => setLit(false)}
        style={{
          display: "flex", alignItems: "center", gap: 5, padding: "4px 9px 4px 7px",
          borderRadius: 999, border: "none", cursor: "pointer", fontFamily: T.font,
          background: "rgba(16,16,18,0.9)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          opacity: lit ? 1 : 0.65, transition: `opacity ${T.ease}`,
        }}>
        <X size={11} color="#fff" strokeWidth={2} />
        <span style={{ fontSize: 11, fontWeight: 600, color: "#fff", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
          Exit Presentation
        </span>
      </button>
    </div>
  );
}

// The presenter's nav cluster: the counter and the nav/fullscreen controls, dimmed until the pointer
// is on them. The EXIT is no longer part of it — it moved to the top-left, where the presentation was
// started from (see PresentExitBtn). Speaker notes are deliberately absent — a presenter
// view needs a second window the sandbox cannot coordinate, so v1 does not pretend to have one
// (plan §5).
//
// `data-present-chrome` marks the whole cluster: the shell's key handler reads it to let a focused
// button keep the keys that ACTIVATE it (Space) instead of claiming them for the deck.
function PresentChrome({ n, total, atStart, atEnd, isFull, onPrev, onNext, onFullscreen }) {
  const [hov, setHov] = useState(false);
  return (
    <div data-present-chrome="1"
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute", right: 12, bottom: 12, zIndex: 10,
        display: "flex", alignItems: "center", gap: 8,
      }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 2, padding: "4px 6px",
        borderRadius: 999, background: "rgba(20,20,22,0.82)",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        opacity: hov ? 1 : 0.32, transition: `opacity ${T.ease}`,
      }}>
        <PresentChromeBtn icon={ChevronLeft} title="Previous slide (←)" onClick={onPrev} disabled={atStart} />
        <span data-present-counter="1" style={{
          padding: "0 6px", fontSize: 11.5, fontWeight: 600, color: "#fff", fontFamily: T.font,
          fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        }}>{(n || "–") + " / " + total}</span>
        <PresentChromeBtn icon={ChevronRight} title="Next slide (→)" onClick={onNext} disabled={atEnd} />
        <span style={{ width: 1, height: 14, background: "rgba(255,255,255,0.16)", margin: "0 3px" }} />
        <PresentChromeBtn icon={isFull ? Minimize : Maximize} title={isFull ? "Leave fullscreen" : "Fullscreen"} onClick={onFullscreen} />
      </div>
    </div>
  );
}

function PresentShell({ slides, elements, leavesBySlide, page, imageMap, entryIndex, autoFullscreen, onExit }) {
  const rootRef = useRef(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [isFull, setIsFull] = useState(false);
  // { cur, revealed, snap, fading }.
  //   cur       the live slide index.
  //   revealed  how many of THAT slide's build steps are shown. EPHEMERAL VIEWPORT STATE, exactly
  //             like `activeSlideId`, `activeCell` and the fit map: it lives here, it is never
  //             written to the override bag, and a presenter's position in a slide's builds is not
  //             something the next person to open the URL should inherit.
  //   snap      this commit is a NAVIGATION, so cutoff changes switch hard (buildRevealMs).
  //   fading    every OUTGOING slide still running its crossfade, as slide id -> the build cutoff
  //             it left with. A RECORD rather than one `prev` slot because a second navigation
  //             inside the 220 ms must not strand the layer the first one left mid-fade (a stranded
  //             layer keeps zIndex 2 over the live slide, with its whole chart tree alive, for the
  //             rest of the session) — and it carries the cutoff because a layer must not change
  //             what it is showing while it fades out (see presentSeat).
  const [nav, setNav] = useState(() => ({
    cur: presentEntrySlide(slides, entryIndex), revealed: 0, snap: true, fading: PRESENT_NO_FADE,
  }));
  // sql -> { rows, isLoading, isError, error }. The deck-wide query pool; see PresentQuery.
  const [pool, setPool] = useState({});
  // The statements actually MOUNTED, in admission order — append-only, budget-limited, and the
  // only thing that ever starts a pooled query. See presentAdmit.
  const [started, setStarted] = useState(PRESENT_EMPTY);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  // Every slide's build steps, derived from the same leaf map the layers render from. Held in a ref
  // as well because the nav transitions run inside a functional setState, where the render's
  // closure is the wrong generation to read.
  const stepsBySlide = useMemo(() => buildStepsBySlide(leavesBySlide), [leavesBySlide]);
  const stepsRef = useRef(stepsBySlide);
  stepsRef.current = stepsBySlide;

  const publish = useCallback((sql, next) => {
    setPool((prev) => {
      // …and here too: an own-property read, so a statement named after a prototype member cannot
      // compare "equal" to a function and skip its own publish.
      const cur = Object.hasOwn(prev, sql) ? prev[sql] : undefined;
      if (cur && cur.rows === next.rows && cur.isLoading === next.isLoading
        && cur.isError === next.isError && cur.error === next.error) return prev;
      return { ...prev, [sql]: next };
    });
  }, []);

  // The want set is re-derived from the LIVE cursor, which is the whole point: nearest-first from
  // where the presenter actually is, not from where they came in. Re-deriving it cannot disturb a
  // running query — `started` is append-only, so this only changes what gets admitted NEXT.
  const wantSql = useMemo(
    () => presentPrefetchSql(slides, elements, nav.cur, PRESENT_PREFETCH_MAX),
    [slides, elements, nav.cur],
  );
  // One admission pass per want-set change and per pool publish (a settled query frees its slot).
  // presentAdmit returns the previous array unchanged when nothing new fits, so this cannot loop.
  useEffect(() => {
    setStarted((prev) => presentAdmit(wantSql, prev, pool, PRESENT_INFLIGHT_MAX));
  }, [wantSql, pool]);
  // What the charts treat as "the pool owns this statement": everything mounted, plus everything
  // still queued for admission. A chart whose SQL is in neither owns its own query (PresentChart).
  const poolSet = useMemo(() => new Set([...started, ...wantSql]), [started, wantSql]);

  // Measured in a LAYOUT effect so the first painted frame already has a scale; letterbox() returns
  // scale 0 until then and the shell paints backdrop only, never a flash of an unscaled slide.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    const measure = () => {
      const r = node.getBoundingClientRect();
      setView((v) => (v.w === r.width && v.h === r.height ? v : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Fullscreen is MIRRORED, never assumed: the browser's own control and its Esc both leave
  // fullscreen without telling us, so `fullscreenchange` is the only source of truth for the icon.
  // The unmount cleanup releases fullscreen we still hold, so exiting present mode cannot leave the
  // host stuck in a fullscreen iframe.
  useEffect(() => {
    const node = rootRef.current;
    const sync = () => setIsFull(typeof document !== "undefined" && document.fullscreenElement === node);
    if (typeof document !== "undefined") document.addEventListener("fullscreenchange", sync);
    sync();
    return () => {
      if (typeof document !== "undefined") document.removeEventListener("fullscreenchange", sync);
      leaveFullscreen(node);
    };
  }, []);

  // Only ever from a gesture: `autoFullscreen` is set by the click that opened present mode, whose
  // user activation is still live when this effect runs. A cold published URL passes false, because
  // an unprovoked request is denied AND logged.
  useEffect(() => {
    if (autoFullscreen) tryFullscreen(rootRef.current);
  }, [autoFullscreen]);

  // TAKE THE KEYBOARD. In production the deck runs in a cross-origin iframe that does NOT hold
  // focus, so without this the viewer's first → goes to the host page and the deck does not move —
  // and the click that would have granted focus advances a slide, so switching the keyboard on
  // costs you one. `tabIndex={-1}` on the root is here for exactly this call. (The local harness
  // cannot show the bug: that page is same-origin and already focused, and a synthetic key event
  // is delivered straight to the document without consulting frame focus at all.)
  const hadFocusRef = useRef(true); // did the deck hold focus when this gesture began?
  useEffect(() => {
    const node = rootRef.current;
    if (node && typeof node.focus === "function") node.focus({ preventScroll: true });
    hadFocusRef.current = typeof document === "undefined" || typeof document.hasFocus !== "function"
      ? true : document.hasFocus();
  }, []);

  // TWO funnels, one per direction, and the build steps are IN them. Every advancing input (click,
  // →, ↓, Space, PageDown, the chrome's ›) goes through `advance`; every retreating one (←, ↑,
  // PageUp, the chrome's ‹) through `retreat`. Each first offers the input to THIS slide's builds
  // (presentReveal) and only falls through to the slide walk when the slide has no step left that
  // way. `jump` (Home / End) does not reveal at all — it re-seats the cursor at the far slide, which
  // is why it calls presentSeat directly and why the direction it passes is the seat rule.
  //
  // Both funnels resolve inside ONE functional setState, so the reveal-or-navigate decision reads
  // the live cursor rather than a render's closure, and the whole transition is one commit.
  const step = useCallback((dir) => {
    setNav((n) => presentStep(slidesRef.current, stepsRef.current, n, dir));
  }, []);
  const jump = useCallback((dir) => {
    setNav((n) => presentJump(slidesRef.current, stepsRef.current, n, dir));
  }, []);
  const advance = useCallback(() => step(1), [step]);
  const retreat = useCallback(() => step(-1), [step]);

  // A deck can shrink under a presenter (a stale bag cleared, an override reset): re-seat the
  // cursor rather than paint a slide the deck no longer has.
  useEffect(() => {
    setNav((n) => (n.cur >= 0 && n.cur < slides.length
      ? n
      : { cur: presentEntrySlide(slides, n.cur), revealed: 0, snap: true, fading: PRESENT_NO_FADE }));
  }, [slides]);

  // RETIRE a faded-out layer. Without this the outgoing layer stays mounted for the rest of the
  // session at opacity 0 and zIndex 2 — above the live slide — with its whole chart tree alive.
  const retire = useCallback((id) => {
    setNav((n) => {
      if (!Object.hasOwn(n.fading, id)) return n;
      const fading = {};
      for (const key of Object.keys(n.fading)) if (key !== id) fading[key] = n.fading[key];
      return { ...n, fading: Object.keys(fading).length ? fading : PRESENT_NO_FADE };
    });
  }, []);
  // Each layer's OWN transition, identified by the slide id on the event target: transitionend
  // bubbles, so one handler on the shared scaler retires every layer without a per-layer callback
  // prop (which would defeat PresentLayer's memo). The id check is what makes it identity-safe when
  // two layers are fading at once.
  const onLayerTransitionEnd = useCallback((e) => {
    if (e.propertyName !== "opacity") return;
    const node = e.target;
    const id = node && typeof node.getAttribute === "function" ? node.getAttribute("data-present-slide") : null;
    if (id) retire(id);
  }, [retire]);
  // ...and the fallback, because transitionend is not guaranteed to arrive: a hidden tab suspends
  // the rendering pipeline and may never fire one, and a fade cut short by its layer unmounting
  // fires nothing either. The timer restarts whenever the set changes, so the last layer added
  // always gets the full fade before the sweep.
  useEffect(() => {
    if (nav.fading === PRESENT_NO_FADE) return undefined;
    const t = setTimeout(
      () => setNav((n) => (n.fading === PRESENT_NO_FADE ? n : { ...n, fading: PRESENT_NO_FADE })),
      PRESENT_FADE_MS + PRESENT_FADE_GRACE_MS,
    );
    return () => clearTimeout(t);
  }, [nav.fading]);

  // Exiting reports WHICH SLIDE was on screen, so the editor opens on it. That is the whole reason
  // the old reading view existed — Esc used to land on a fixed slide that could be hidden and had no
  // way to reach any other — and it is now answered by handing the cursor back instead of by a third
  // surface. Read through a ref because both the key handler and the button are mounted once.
  const navRef = useRef(nav);
  navRef.current = nav;
  const exit = useCallback(() => {
    const n = navRef.current;
    const list = slidesRef.current;
    const at = n && n.cur;
    onExit(Number.isInteger(at) && at >= 0 && at < list.length ? list[at].id : null);
  }, [onExit]);

  const keyRef = useRef({});
  keyRef.current = { advance, retreat, jump, onExit: exit, isFull };
  useEffect(() => {
    const onKey = (e) => {
      const S = keyRef.current;
      // The SAME guard the editor's handler uses — a focused field keeps its keystrokes.
      if (isTypingTarget(document.activeElement)) return;
      // A FOCUSED CHROME BUTTON owns the keys that activate it. isTypingTarget is false for a
      // button, so without this the capture handler claimed the Space of someone who had tabbed to
      // Fullscreen or Exit Presentation, prevented the native activation, and advanced a slide
      // instead.
      // Only the activating keys are handed over: ← / → / Home / End still navigate from there,
      // which is what a presenter who left focus on the chrome expects.
      const t = e.target;
      const inChrome = !!(t && typeof t.closest === "function" && t.closest("[data-present-chrome]"));
      if (inChrome && (e.code === "Space" || e.key === "Enter")) return;
      // Modified keys belong to the browser (⌘R, ⌘←, ⌥→), so present mode never claims them.
      //
      // It cannot do better than that: a DOM event does not cross an iframe boundary, so NOT
      // preventing ⌘K here does not deliver it to the MotherDuck app around us — the host's own
      // shortcuts are simply unavailable while this iframe holds focus, and letting the key through
      // is the best available behaviour rather than a fix. A postMessage bridge would need the host
      // to implement the other end, so it is deliberately not attempted.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Unmodified nav keys are claimed COMPLETELY, including at the deck's ends: `claim()` runs
      // before the state check, so → on the last slide is swallowed rather than scrolling the host
      // page. That is deliberate (Google Slides does the same): during a presentation an arrow key
      // means "the deck", and a key that silently scrolls something behind the slide is worse than
      // one that does nothing. preventDefault also stops Space and PageDown scrolling;
      // stopPropagation stops the key reaching anything else in this document.
      const claim = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.code === "Space") { claim(); S.advance(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { claim(); S.retreat(); return; }
      if (e.key === "Home") { claim(); S.jump(1); return; }
      if (e.key === "End") { claim(); S.jump(-1); return; }
      if (e.key === "Escape") {
        claim();
        // Two-step, like every full-screen player: leave fullscreen first, leave present mode
        // second. (Chrome usually consumes the Esc that exits fullscreen itself, so this branch is
        // the fallback for the browsers that deliver it — and it must not also exit present mode.)
        if (S.isFull) leaveFullscreen(rootRef.current);
        else S.onExit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const box = letterbox(view.w, view.h, page.width, page.height);
  const count = presentCounter(slides, nav.cur);
  const mountIds = useMemo(() => presentMountWindow(slides, nav.cur, PRESENT_MOUNT_RADIUS), [slides, nav.cur]);
  const curId = nav.cur >= 0 && nav.cur < slides.length ? slides[nav.cur].id : null;
  const fadingIds = nav.fading;
  // The rendered layers — and therefore THE mount window: a slide with no layer has no charts in
  // the DOM. It is the window plus every still-fading slide, because a Home/End jump leaves the
  // window and a slide unmounting its chart halfway through its own fade is a visible glitch.
  const layers = useMemo(() => {
    const want = new Set(mountIds);
    for (const id of Object.keys(fadingIds)) want.add(id);
    return slides.filter((slide) => want.has(slide.id));
  }, [slides, mountIds, fadingIds]);

  const curSteps = buildStepsFor(stepsBySlide, curId);
  const atStart = presentArrowDead(slides, stepsBySlide, nav, -1);
  const atEnd = presentArrowDead(slides, stepsBySlide, nav, 1);

  // A click on a frame that does not hold the keyboard is the viewer GRANTING it — charging them a
  // slide for that is the other half of the FIX-1 bug, so the focusing click only focuses. Read at
  // pointerdown, ahead of the browser's own focus-on-mousedown, which is the last moment the answer
  // still describes the click that arrived.
  //
  // "Held the keyboard" is deliberately the OR of two things: the frame has system focus, or the
  // root is still the document's focused element. The second half is what keeps this from ever
  // swallowing a click it should not — with the mount focus above in place, the root holds DOM focus
  // from the first frame, so the only click that gets swallowed is one arriving at a deck that has
  // neither (a frame the host never focused, and a focus() the browser refused). A never-advancing
  // click would be a far worse bug than the one slide this is protecting.
  const onRootPointerDown = useCallback(() => {
    const node = rootRef.current;
    const doc = typeof document === "undefined" ? null : document;
    const heldDom = !!(node && doc && doc.activeElement
      && (node === doc.activeElement || node.contains(doc.activeElement)));
    hadFocusRef.current = !doc || typeof doc.hasFocus !== "function" ? true : (doc.hasFocus() || heldDom);
    if (node && typeof node.focus === "function") node.focus({ preventScroll: true });
  }, []);
  const onRootClick = useCallback(() => {
    if (hadFocusRef.current) advance();
  }, [advance]);

  return (
    <div ref={rootRef} data-present="1" tabIndex={-1}
      onPointerDown={onRootPointerDown} onClick={onRootClick}
      style={{
        position: "fixed", inset: 0, zIndex: 1500, overflow: "hidden",
        background: PRESENT_BACKDROP, fontFamily: T.font,
        // A presenter clicks to advance; a drag that selects a paragraph of the slide instead is
        // pure noise.
        userSelect: "none", WebkitUserSelect: "none", cursor: "default", outline: "none",
      }}>
      {box.scale > 0 ? (
        <div data-present-stage="1" style={{
          position: "absolute", left: box.left, top: box.top, width: box.w, height: box.h, overflow: "hidden",
        }}>
          <div data-present-scaler="1" onTransitionEnd={onLayerTransitionEnd} style={{
            position: "absolute", left: 0, top: 0, width: page.width, height: page.height,
            transform: "scale(" + box.scale + ")", transformOrigin: "top left",
          }}>
            {layers.map((slide) => (
              <PresentLayer key={slide.id} slideId={slide.id}
                els={leavesBySlide.get(slide.id) || EMPTY_LEAVES}
                background={slide.background || page.background}
                page={page} imageMap={imageMap} pool={pool} poolSet={poolSet} publish={publish}
                visible={slide.id === curId} fading={slide.id !== curId && Object.hasOwn(fadingIds, slide.id)}
                cut={presentLayerCut(nav, slide.id, curId, curSteps)}
                revealMs={buildRevealMs(nav.snap)} />
            ))}
          </div>
        </div>
      ) : null}
      {/* Zero DOM, one query each — the admitted ones only, and never unmounted once admitted. */}
      {started.map((sql) => <PresentQuery key={sql} sql={sql} publish={publish} />)}
      <PresentExitBtn onClick={exit} />
      <PresentChrome n={count.n} total={count.total} atStart={atStart} atEnd={atEnd} isFull={isFull}
        onPrev={retreat} onNext={advance}
        onFullscreen={() => { if (isFull) leaveFullscreen(rootRef.current); else tryFullscreen(rootRef.current); }} />
    </div>
  );
}

// The published view's Present pill and the reader's prev/next navigator lived here. Both belonged
// to the READING VIEW — the third surface between edit and present — and both went with it. A deck
// now has exactly two surfaces: present mode (the published view, and where the top bar's Present
// control goes) and the editor (where Esc and Exit Presentation land). There is no page left that
// needs a pill back into the presentation, and no one-slide-at-a-time reader that needs its own
// prev/next over a deck it cannot otherwise move through.

// ═══════════════════════════════════════════════════════════════════════════
// MOTHERDUCK OVERRIDE STATE — SINGLE OWNER
// Keep the platform hook, normalization, runtime merge, setter, and latest-value accessor in
// this one section. Save reads getOverrides(), never the parent URL or its possible state ref.
// The setter updates the ref synchronously so an input blur immediately followed by Save cannot
// send the previous bag while React is still scheduling the next render.
// ═══════════════════════════════════════════════════════════════════════════
function useEditableDiveOverrides() {
  const [platformOverrides, setPlatformOverrides] = useDiveState("ov", null);
  const platformValueRef = useRef(platformOverrides);
  const latestOverridesRef = useRef(platformOverrides);
  if (platformValueRef.current !== platformOverrides) {
    platformValueRef.current = platformOverrides;
    latestOverridesRef.current = platformOverrides;
  }
  const setOverrides = useCallback((next) => {
    const resolved = typeof next === "function" ? next(latestOverridesRef.current) : next;
    latestOverridesRef.current = resolved;
    setPlatformOverrides(resolved);
  }, [setPlatformOverrides]);
  const getOverrides = useCallback(() => latestOverridesRef.current, []);
  // `normOv` is the merge core's (the save Flight bakes with it) and normalizes the v1 six only. A deck's bag must
  // declare the SAME schema version as the scene (spec O1 — a v1 bag against a v2 scene is
  // INVALID_OVERRIDES) and must carry the four deck keys through every element commit, since
  // every commit is built by spreading this object. Absent keys stay absent so an element-only
  // edit costs no extra URL bytes.
  const overrides = useMemo(() => {
    const base = normOv(platformOverrides, SCENE.version);
    if (!isDeckScene(SCENE)) return base;
    const slideOv = normSlideOv(platformOverrides);
    const next = { ...base, v: 2 };
    if (Object.keys(slideOv.slidePatch).length) next.slidePatch = slideOv.slidePatch;
    if (slideOv.addedSlides.length) next.addedSlides = slideOv.addedSlides;
    if (slideOv.deletedSlides.length) next.deletedSlides = slideOv.deletedSlides;
    if (slideOv.slideOrder !== undefined) next.slideOrder = slideOv.slideOrder;
    return next;
  }, [platformOverrides]);
  const merged = useMemo(() => mergeScene(SCENE, platformOverrides), [platformOverrides]);
  return { ovRaw: platformOverrides, setOvRaw: setOverrides, getOverrides, ov: overrides, merged };
}

// ── Root ────────────────────────────────────────────────────────────────────
export default function EditableDive() {
  const [editMode, setEditMode] = useDiveState("editMode", false);
  const { ovRaw, setOvRaw, getOverrides, ov, merged } = useEditableDiveOverrides();
  const page = merged.page;

  // ── Deck ──────────────────────────────────────────────────────────────────
  // `merged.slides` is the effective deck (base slides + slidePatch/added/deleted/slideOrder),
  // resolved by the same core function the save Flight bakes with, and undefined for a v1
  // scene. `wantedSlideId` is EPHEMERAL viewport state: a cursor, not a document edit, so it
  // never enters the override bag — the same rule `activeCell` and `croppingId` follow.
  const slides = merged.slides;
  const isDeck = Array.isArray(slides);
  const [wantedSlideId, setWantedSlideId] = useState(null);
  const slideIndexRef = useRef(0); // last LIVE index, so a deleted slide falls to its neighbour
  // TWO SURFACES, NOT THREE. A deck is either being presented or being edited, and `editMode` is
  // the whole switch: `!editMode` on a deck IS present mode. A published URL carries no state, so
  // it opens presenting — which is the answer to "what does the published URL do": a published deck
  // IS a presentation. Esc and Exit Presentation set editMode, so leaving a presentation lands in
  // the editor, on the slide that was on screen.
  //
  // The reading view that used to sit between them is gone. It existed to fix a real defect — Esc
  // landed on a fixed, possibly-hidden slide in a view that could reach no other, and content parked
  // off the slide was clipped away — and edit mode answers both: the exit hands back the presented
  // slide's id, and the edit canvas is the same used-bounds plane plus a margin, never clipped, with
  // "Fit all content" in the zoom cluster and off-slide elements still selectable.
  //
  // `present` keeps the two facts that are NOT "is it on": the entry slide (`null` = a cold open,
  // which starts on the first PRESENTABLE slide; a number = "present from current", which honours the
  // author's cursor even onto a hidden slide) and whether a live user gesture is behind the open —
  // the only case where requesting fullscreen is legal. EPHEMERAL, like the slide cursor: never in
  // the override bag.
  const [present, setPresent] = useState({ entry: null, gesture: false });
  const activeSlideId = isDeck ? resolveActiveSlideId(slides, wantedSlideId, slideIndexRef.current) : null;
  const activeSlideIndex = isDeck ? slides.findIndex((s) => s.id === activeSlideId) : -1;
  // Background/name/notes/hidden of the slide being edited. `background` paints the page sheet and
  // is edited in the inspector's Slide section; `hidden` dims the sheet here and is skipped by the
  // presentable-slide walk; `notes` is read and written by the strip under the canvas.
  const activeSlide = activeSlideIndex >= 0 ? slides[activeSlideIndex] : null;
  const slideBackground = (activeSlide && activeSlide.background) || page.background;
  const slideHidden = !!(activeSlide && activeSlide.hidden);
  // The cursor is RESOLVED during render (so no frame ever paints a slide the deck lost) and
  // reconciled here, mirroring the selection-drop effect below.
  useEffect(() => {
    if (!isDeck) return;
    if (activeSlideIndex >= 0) slideIndexRef.current = activeSlideIndex;
    if (wantedSlideId !== activeSlideId) setWantedSlideId(activeSlideId);
  }, [isDeck, activeSlideId, activeSlideIndex, wantedSlideId]);

  // THE deck filter. `all` / `slideLeaves` are the ACTIVE slide's elements and are what every
  // editor subsystem below reads; `merged.all` / `merged.elements` (deck-wide) are reached for
  // only where the whole deck genuinely matters — minting a globally unique element id. Cross-
  // slide leakage anywhere else is a bug: it would let a marquee select, a group swallow, or a
  // snap line come from a slide the author cannot see.
  const all = useMemo(() => elementsOfSlide(merged.all, activeSlideId, isDeck), [merged.all, activeSlideId, isDeck]);
  const slideLeaves = useMemo(() => elementsOfSlide(merged.elements, activeSlideId, isDeck), [merged.elements, activeSlideId, isDeck]);
  // The filmstrip's read of the WHOLE deck: leaves bucketed by slide, with every untouched slide's
  // array reference carried over from the last render (groupLeavesBySlide). That identity is what a
  // memoized thumbnail compares, so a commit re-renders the edited slide's thumbnail and no other.
  const leavesRef = useRef(null);
  const leavesBySlide = useMemo(() => {
    if (!isDeck) return null;
    leavesRef.current = groupLeavesBySlide(merged.elements, leavesRef.current);
    return leavesRef.current;
  }, [merged.elements, isDeck]);
  // BASE leaves, not merged ones: the offset has to reproduce the z values the last bake wrote,
  // so it must be constant for the session. See leavesBeforeSlide for why a live count would
  // silently rewrite `z` for every leaf of every later slide the author reorders.
  const zOffset = useMemo(() => leavesBeforeSlide(SCENE.elements, slides, activeSlideId), [slides, activeSlideId]);
  // Nothing can be minted onto a deck with no live slide; this is the toast, or null. It is also
  // what DISABLES the Add controls, so it deliberately asks the narrower, permanent question.
  const noSlideRefusal = mintRefusal(isDeck, activeSlideId);
  // The full gate every mint site (add / group / paste+duplicate) consults: no live slide, OR a
  // stale bag whose additions mergeScene would throw away — an insert that grows the byte meter
  // and puts nothing on the slide. Enabled button, spoken refusal, because the way out is the
  // "Clear stale edits" button already on screen.
  const mintBlocked = mintRefusal(isDeck, activeSlideId, SCENE, ov);

  const [selection, setSelectionRaw] = useState([]);
  const [enteredGroupId, setEnteredGroupId] = useState(null); // drill state; the stack derives from parents
  const [hoverId, setHoverId] = useState(null);
  const [draft, setDraft] = useState(null); // { rects: {leafId: rect}, guides }
  const [marquee, setMarquee] = useState(null); // { rect, preview: [ids] }
  const [editingTextId, setEditingTextId] = useState(null);
  // { id, r, c } — which table cell the inspector is talking about. Deliberately NOT persisted:
  // it is a cursor, not a document edit, so it never enters the override bag or the URL.
  const [activeCell, setActiveCell] = useState(null);
  // Crop mode: ONE image element at a time (a scalar id), with a live draft that mirrors the
  // move gesture's `draft` — 60fps preview in state, one patchEl on release.
  const [croppingId, setCroppingId] = useState(null);
  const [cropDraft, setCropDraft] = useState(null); // { id, ox, oy, zoom }
  const [renamingId, setRenamingId] = useState(null);
  // Slide rename is its own cursor: slide ids and element ids are different namespaces, so sharing
  // `renamingId` would let one collision open two rename fields at once.
  const [renamingSlideId, setRenamingSlideId] = useState(null);
  // The speaker-notes strip's open state. EPHEMERAL — a session viewport preference, closed by
  // default, deliberately not in the override bag (see NotesStrip) for the same reason
  // `activeSlideId` and `activeCell` are not.
  const [notesOpen, setNotesOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [copyModal, setCopyModal] = useState(null);
  const [chartCols, setChartCols] = useState({});
  // Viewport state is EPHEMERAL — never dive-state. `fitScale` is measured (logical page width
  // -> available width); the three panel widths, which panels are SHOWN, and `zoom` are user
  // preferences for this local viewport. Same rule as `activeSlideId`, `activeCell`, the notes
  // strip's open flag and the autofit map: none of them is an edit, so none of them is in the bag.
  //
  // ONE object for the widths, keyed exactly like PANEL_LIMITS, because the budget reconciles all
  // three together and a drag on any one of them has to read the other two.
  const [panelWidths, setPanelWidths] = useState({
    rail: FILM_DEFAULT_WIDTH, left: LEFT_PANE_DEFAULT, right: RIGHT_PANE_DEFAULT,
  });
  const [panelsShownRaw, setPanelsShownRaw] = useState(PANEL_SHOWN_DEFAULT);
  const [fitScale, setFitScale] = useState(1);
  const [measured, setMeasured] = useState(false); // fitScale has been taken from the real container
  const [zoom, setZoom] = useState(1);
  const scale = fitScale * zoom;
  const [scrollZoom, setScrollZoom] = useState(false); // OFF = wheel scrolls (default)
  const [tool, setTool] = useState("select"); // "select" | "hand" (edit mode only)
  const [spaceHeld, setSpaceHeld] = useState(false); // Space-hold = temporary Hand
  const [panning, setPanning] = useState(false);
  const [, bump] = useState(0);
  // Hand behaviour is edit-mode only; in view mode drag-to-pan is always the default drag.
  const handActive = editMode && (tool === "hand" || spaceHeld);

  const nodeRefs = useRef({});
  const canvasRef = useRef(null);
  const paneRowRef = useRef(null);
  const panelWidthsRef = useRef({ rail: FILM_DEFAULT_WIDTH, left: LEFT_PANE_DEFAULT, right: RIGHT_PANE_DEFAULT });
  const panelsShownRef = useRef(PANEL_SHOWN_DEFAULT);
  const pageRef = useRef(null);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const lastCommit = useRef({ t: 0, kind: null });
  const gestureCancel = useRef(false);
  const gestureActive = useRef(false);
  const stateRef = useRef({});
  const pendingAnchor = useRef(null); // scroll fix-up applied after a zoom renders
  const pendingCenter = useRef(null); // fit presets: bounds to centre once the zoom renders
  const initView = useRef(false);     // one-shot: park the opening scroll on the page, not the margin
  const zoomRef = useRef(1);          // latest requested zoom (may lead state by one frame)
  const appliedZoom = useRef(1);      // zoom the current scroll offsets belong to
  const wheelRef = useRef({});
  const clipboard = useRef(null);     // ⌘C/⌘V subtree snapshots — in memory, never persisted

  // THE THREE PANELS. The rail used to be a fixed column subtracted off the top of the budget on the
  // argument that a thumbnail has one size; it is draggable now, so all three are inside the budget
  // and the arithmetic is one pure function (clampPanelWidths / clampPanelDrag). `panelsShown` is the
  // EFFECTIVE visibility — a v1 scene has no rail, so its flag is forced off rather than reserving
  // width for a column that is never rendered.
  const panelsShown = useMemo(() => panelsShownFor(panelsShownRaw, isDeck), [panelsShownRaw, isDeck]);
  panelsShownRef.current = panelsShown;
  panelWidthsRef.current = panelWidths;
  // The row measures the WHOLE row now, with nothing subtracted up front: a hidden panel is not
  // rendered, so it contributes nothing, and every panel is border-box, so the declared widths and
  // the row add up exactly.
  const rowWidth = () => {
    const row = paneRowRef.current;
    return row ? row.clientWidth : undefined;
  };
  // ONE call, and every decision in it is panelDragRequest's: the panel's own limits, the OTHER
  // shown panels at their clamped widths, the canvas floor, the measured row, and "this frame is
  // unreadable, keep what the author had" (null). The handler does nothing but write the answer,
  // which is the point — the three ways to get this wiring wrong (write the raw delta, clamp to the
  // dragged panel alone, pass a stale visibility) are now all changes to this one line.
  const applyPanelWidth = useCallback((key, requested) => {
    const next = panelDragRequest(key, requested, panelWidthsRef.current, panelsShownRef.current, rowWidth());
    if (next === null || next === panelWidthsRef.current[key]) return;
    panelWidthsRef.current = { ...panelWidthsRef.current, [key]: next };
    setPanelWidths(panelWidthsRef.current);
  }, []);
  // Hiding is instant; SHOWING has to re-fit, because the row may have narrowed (or another panel
  // widened) while this one was away and the restored width would then break the canvas floor. So
  // the toggle writes visibility and the observer below reconciles the widths on the next commit.
  const togglePanel = useCallback((key) => {
    setPanelsShownRaw((prev) => togglePanelShown(prev, key));
  }, []);

  // The canvas ResizeObserver below re-measures fitScale after every panel drag. This observer
  // handles the inverse cases: a browser resize, or a panel coming back, that leaves the local
  // widths too wide for the row.
  //
  // useLAYOUTeffect, not useEffect, and that is the whole of the fix for a measured defect: showing
  // a panel renders it at its STORED width first and re-fits afterwards, so with a passive effect
  // there was one COMMITTED frame in which the row overflowed. Measured at row 700 with the
  // inspector hidden (a correct sum=700, canvas=364), then at microtask time after the show-click:
  // sum=896, overflow=196, and the canvas column at 0. A layout effect runs after the DOM is written
  // and before the browser paints, and its setState flushes synchronously inside the same discrete
  // event, so the overflowing frame is never committed and never observable. (The read view's
  // deleted park effect used useLayoutEffect for exactly this reason.)
  useLayoutEffect(() => {
    if (!editMode) return undefined;
    const node = paneRowRef.current;
    if (!node) return undefined;
    const fitPanels = () => {
      const cur = panelWidthsRef.current;
      const next = clampPanelWidths(cur, panelsShownRef.current, node.clientWidth);
      // Only the SHOWN panels are reconciled: a hidden panel keeps the width it will come back at,
      // which is what makes hide/show a no-op rather than a way to lose a pane's size.
      const merged = { ...cur };
      let changed = false;
      for (const key of PANEL_KEYS) {
        if (!panelsShownRef.current[key] || next[key] === cur[key]) continue;
        merged[key] = next[key];
        changed = true;
      }
      if (!changed) return;
      panelWidthsRef.current = merged;
      setPanelWidths(merged);
    };
    fitPanels();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", fitPanels);
      return () => window.removeEventListener("resize", fitPanels);
    }
    const observer = new ResizeObserver(fitPanels);
    observer.observe(node);
    return () => observer.disconnect();
    // `panelsShown` is in the deps because SHOWING a panel does not change the ROW's size, so the
    // observer would never fire for it — and that is exactly the case where a restored width can
    // break the canvas floor.
  }, [editMode, panelsShown]);

  const setSelection = useCallback((ids) => { setSelectionRaw(ids); setRenamingId(null); }, []);
  const showToast = useCallback((msg) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  // ── Save (Flight) ───────────────────────────────────────────────────────
  // Edits batch in the bag; nothing is written until Save -> confirm. Confirm sends the whole bag
  // to the save Flight in ONE run. On success the bag is cleared at once (it is stale against the
  // version just written) and the dialog stays up until the author reloads onto that version.
  const saveCount = pendingEditCount(ovRaw);
  const [saveUI, setSaveUI] = useState(null); // { phase, summary, message }
  const startSaveRun = useRunFlight(SAVE_FLIGHT_ID);
  const saveRun = useFlightRun(SAVE_FLIGHT_ID, startSaveRun.data?.runNumber, {
    onFinished: (run) => {
      if (run.status === "SUCCEEDED") {
        setOvRaw(null);
        setSaveUI((ui) => ({ ...(ui || {}), phase: "saved" }));
      } else {
        setSaveUI((ui) => ({ ...(ui || {}), phase: "failed", message: flightSaveFailure(run.status, run.exitCode) }));
      }
    },
  });
  const saveBusy = !!saveUI && saveUI.phase === "saving";
  useEffect(() => {
    if (!saveBusy) return;
    const err = startSaveRun.error || saveRun.error;
    if (!err) return;
    const denied = /permission|access|own|forbidden|403/i.test(String(err.message || ""));
    setSaveUI((ui) => ({ ...ui, phase: "failed", message: denied
      ? "You don't have access to run this Dive's save Flight. Ask the Dive's owner, or use Copy JSON."
      : `Could not ${startSaveRun.error ? "start" : "follow"} the save: ${String(err.message || err).slice(0, 160)}` }));
  }, [saveBusy, startSaveRun.error, saveRun.error]);
  const requestSave = useCallback(() => {
    const check = checkFlightSave(SCENE, getOverrides(), SAVE_FLIGHT_ID);
    if (!check.ok) { showToast(check.error); return; }
    setSaveUI({ phase: "confirm", summary: check.summary, count: pendingEditCount(getOverrides()) });
  }, [getOverrides, showToast]);
  const confirmSave = useCallback(() => {
    // Re-checked at the moment of commitment: the bag the author confirms is the one that is sent.
    const check = checkFlightSave(SCENE, getOverrides(), SAVE_FLIGHT_ID);
    if (!check.ok) { setSaveUI({ phase: "failed", message: check.error }); return; }
    setSaveUI((ui) => ({ ...ui, phase: "saving", summary: check.summary }));
    startSaveRun.run({ DIVE_ID: SCENE.diveId, BASE_VERSION: String(SCENE.version), OVERRIDES: check.json });
  }, [getOverrides, startSaveRun]);

  // Drop selection entries that no longer exist (deleted / stale-cleared) — or that belong to a
  // slide the author has navigated away from, which is the same condition seen through `all`.
  useEffect(() => {
    setSelectionRaw((sel) => {
      // One Set, then O(1) per selected id: a marquee can hold thousands of ids and this effect
      // runs on every commit, so the naive nested scan is quadratic on exactly the hot path.
      const liveIds = new Set(all.map((e) => e.id));
      const live = sel.filter((id) => liveIds.has(id));
      return live.length === sel.length ? sel : live;
    });
    setEnteredGroupId((g) => (g && !all.some((e) => e.id === g && e.type === "group") ? null : g));
  }, [all]);

  // Crop mode lives exactly as long as its element is the whole selection. This one rule
  // covers every "leave crop" path that is not Done/Esc: clicking another element, marquee,
  // deselecting, a tree click, deleting the image, or leaving edit mode.
  useEffect(() => {
    if (!croppingId) return;
    if (selection.length === 1 && selection[0] === croppingId) return;
    setCroppingId(null);
    setCropDraft(null);
  }, [selection, croppingId]);

  // Page scaling: logical width -> available width (edit: canvas region; view: full width).
  // This is the FIT scale only — the user's `zoom` multiplies it into `scale` above.
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    initView.current = false;
    const measure = () => {
      const pad = editMode ? 56 : 0;
      const avail = Math.max(80, node.clientWidth - pad);
      setFitScale(avail / page.width);
      setMeasured(true);
    };
    measure();
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(node);
    } else {
      window.addEventListener("resize", measure);
    }
    return () => { if (ro) ro.disconnect(); else window.removeEventListener("resize", measure); };
  }, [editMode, page.width]);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  // Zooming keeps one content point stationary. The scroll fix-up can only run once the new
  // scale has laid out, so the anchor is stashed and applied in a layout effect.
  const zoomTo = useCallback((next, clientX, clientY) => {
    const z = clampZoom(next);
    if (z === zoomRef.current) return;
    const node = canvasRef.current;
    if (node) {
      // `appliedZoom` is the zoom the current scroll offsets belong to, so a burst of wheel
      // events that lands before a render still produces one correct fix-up.
      const held = pendingAnchor.current;
      const rect = node.getBoundingClientRect();
      const cx = held ? held.cx : clientX == null ? rect.width / 2 : clientX - rect.left;
      const cy = held ? held.cy : clientY == null ? rect.height / 2 : clientY - rect.top;
      pendingAnchor.current = {
        cx, cy, k: z / appliedZoom.current,
        sl: held ? held.sl : node.scrollLeft,
        st: held ? held.st : node.scrollTop,
      };
    }
    zoomRef.current = z;
    setZoom(z);
  }, []);
  // Scroll a logical page-space rect to the centre of the canvas viewport. Everything is
  // MEASURED off the live page box, so the plane offset, the container padding and the
  // margin-auto centring of a narrow plane are all accounted for automatically — and the
  // scale is read back from the DOM rather than a possibly-stale closure.
  const centerOn = useCallback((u) => {
    const node = canvasRef.current, pg = pageRef.current;
    if (!node || !pg || !u) return;
    const nb = node.getBoundingClientRect(), pb = pg.getBoundingClientRect();
    const s = pb.width / page.width;
    if (!(s > 0)) return;
    node.scrollLeft += (pb.left + (u.x + u.w / 2) * s) - (nb.left + nb.width / 2);
    node.scrollTop += (pb.top + (u.y + u.h / 2) * s) - (nb.top + nb.height / 2);
  }, [page.width]);

  // The plane opens with PLANE_MARGIN of empty surface to the left of and above the page, so
  // scroll offset 0 would sit on blank margin. Park the opening view on the page instead:
  // horizontally centred, top edge just under the canvas padding. Once per edit session — any
  // later scroll, pan or zoom is the author's.
  useLayoutEffect(() => {
    if (!editMode || !measured || initView.current) return;
    const node = canvasRef.current, pg = pageRef.current;
    if (!node || !pg) return;
    initView.current = true;
    const nb = node.getBoundingClientRect(), pb = pg.getBoundingClientRect();
    node.scrollLeft += (pb.left + pb.width / 2) - (nb.left + nb.width / 2);
    node.scrollTop += (pb.top - nb.top) - 40;
  }, [editMode, measured]);

  useLayoutEffect(() => {
    appliedZoom.current = zoom;
    const c = pendingCenter.current;
    if (c) {
      // A fit preset wins over the point-anchoring fix-up: it dictates the scroll outright.
      pendingCenter.current = null;
      pendingAnchor.current = null;
      centerOn(c);
      return;
    }
    const p = pendingAnchor.current;
    if (!p) return;
    pendingAnchor.current = null;
    const node = canvasRef.current;
    if (!node) return;
    node.scrollLeft = (p.sl + p.cx) * p.k - p.cx;
    node.scrollTop = (p.st + p.cy) * p.k - p.cy;
  }, [zoom, fitScale, centerOn]);

  // React's onWheel is passive, so preventDefault needs a manually attached listener.
  wheelRef.current = { scrollZoom };
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return undefined;
    const onWheel = (e) => {
      if (!wheelRef.current.scrollZoom && !e.ctrlKey) return; // native scrolling proceeds
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [editMode, zoomTo]);

  // ── Pan ───────────────────────────────────────────────────────────────────
  // Drag the canvas scroll container: view mode always, edit mode under the Hand tool.
  const startPan = useCallback((e) => {
    const node = canvasRef.current;
    if (!node || e.button !== 0) return;
    e.preventDefault();
    const startPt = { x: e.clientX, y: e.clientY };
    const sl = node.scrollLeft, st = node.scrollTop;
    gestureActive.current = true;
    setPanning(true);
    const onMove = (ev) => {
      node.scrollLeft = sl - (ev.clientX - startPt.x);
      node.scrollTop = st - (ev.clientY - startPt.y);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      gestureActive.current = false;
      setPanning(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, []);

  // Images (all pulled by one scene-level query).
  const imagesQ = useSQLQuery(SCENE.images ? SCENE.images.sql : "SELECT 1 AS one", { enabled: !!SCENE.images });
  // Cached images paint at once on a reload; the live query refreshes them (see useCachedImageMap).
  const imageMap = useCachedImageMap(imagesQ);
  const imageKeys = useMemo(() => Object.keys(imageMap), [imageMap]);

  const reportCols = useCallback((id, cols) => {
    setChartCols((prev) => {
      if (prev[id] && JSON.stringify(prev[id]) === JSON.stringify(cols)) return prev;
      return { ...prev, [id]: cols };
    });
  }, []);

  // Which autofit step each text element settled on. EPHEMERAL, like chartCols and for the same
  // reason: a measurement of the current render, never dive state. Canvas-only (see TextContent).
  const [fitIdx, setFitIdx] = useState({});
  const reportFit = useCallback((id, index) => setFitIdx((prev) => fitMapPatch(prev, id, index)), []);

  const getH = useCallback((el) => {
    if (el.h !== "auto") return el.h;
    const n = nodeRefs.current[el.id];
    return n ? n.offsetHeight : 24;
  }, []);

  // ── Hierarchy projections ─────────────────────────────────────────────────
  // All of these read `all` — the active slide only. That single fact is what makes selection
  // roots, group drill, tree drag-drop and the clipboard slide-safe without any extra checks:
  // an id from another slide simply is not in `elById`, so every op drops it.
  const elById = useMemo(() => { const m = {}; for (const e of all) m[e.id] = e; return m; }, [all]);
  const kidsById = useMemo(() => {
    const m = {};
    for (const e of all) { const k = parentOf(e) || ""; if (!m[k]) m[k] = []; m[k].push(e); }
    return m;
  }, [all]);
  const kidsOf = useCallback((id) => kidsById[id || ""] || [], [kidsById]);
  // Descendant leaf ids of any element (a leaf resolves to itself).
  const descLeafIds = useCallback((id) => {
    const el = elById[id];
    if (!el) return [];
    if (el.type !== "group") return [id];
    const out = [];
    const rec = (pid, depth) => {
      if (depth > 32) return;
      for (const c of kidsOf(pid)) { if (c.type === "group") rec(c.id, depth + 1); else out.push(c.id); }
    };
    rec(id, 0);
    return out;
  }, [elById, kidsOf]);
  // Block z of an element: a leaf's own z, or a group's minimum descendant z.
  const zOf = useCallback((id) => {
    const el = elById[id];
    if (!el) return 0;
    if (el.type !== "group") return el.z;
    let m = Infinity;
    for (const l of descLeafIds(id)) { const e = elById[l]; if (e && e.z < m) m = e.z; }
    return m === Infinity ? 0 : m;
  }, [elById, descLeafIds]);
  const ancestorChain = useCallback((id) => {
    const out = [];
    let cur = id, guard = 0;
    while (cur != null && guard++ < 64) { out.push(cur); cur = parentOf(elById[cur]); }
    return out;
  }, [elById]);
  const isAncestorOf = useCallback((a, b) => (a == null ? false : ancestorChain(b).indexOf(a) >= 0), [ancestorChain]);

  // Two projections of `selection`: roots (what the tree/inspector act on) and the leaves
  // every transform applies to.
  const selectionRoots = useCallback((sel) => {
    const set = new Set(sel);
    const out = [], seen = new Set();
    for (const id of sel) {
      if (seen.has(id) || !elById[id]) continue;
      let cur = parentOf(elById[id]), covered = false, guard = 0;
      while (cur != null && guard++ < 64) { if (set.has(cur)) { covered = true; break; } cur = parentOf(elById[cur]); }
      if (!covered) { seen.add(id); out.push(id); }
    }
    return out;
  }, [elById]);
  const selectionLeaves = useCallback((sel) => {
    const out = [], seen = new Set();
    for (const id of selectionRoots(sel)) for (const l of descLeafIds(id)) if (!seen.has(l)) { seen.add(l); out.push(l); }
    return out;
  }, [selectionRoots, descLeafIds]);

  // Click promotion: outermost ancestor group, unless drilled into a group — then the direct
  // child of the entered group along the hit leaf's chain.
  const promoteId = useCallback((leafId, entered) => {
    const chain = ancestorChain(leafId);
    if (entered) {
      const i = chain.indexOf(entered);
      if (i > 0) return chain[i - 1];
      if (i === 0) return chain[0];
    }
    return chain.length ? chain[chain.length - 1] : leafId;
  }, [ancestorChain]);

  // Derived geometry: leaf rect, or the union of a group's descendant leaf rects.
  const rectOf = useCallback((id, rects) => {
    const el = elById[id];
    if (!el) return null;
    const leafRect = (lid) => {
      const d = rects && rects[lid];
      if (d) return { x: d.x, y: d.y, w: d.w, h: d.h };
      const e = elById[lid];
      return e ? { x: e.x, y: e.y, w: e.w, h: getH(e) } : null;
    };
    if (el.type !== "group") return leafRect(id);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of descLeafIds(id)) {
      const r = leafRect(l);
      if (!r) continue;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [elById, descLeafIds, getH]);

  // Canvas position of any element/group (draft-aware, so the layers tree re-sorts live
  // while dragging). The tree orders EVERY sibling list in reading order: top-to-bottom,
  // ties left-to-right.
  const posOf = useCallback((id) => {
    const r = rectOf(id, draft && draft.rects);
    return r ? { y: Math.round(r.y), x: Math.round(r.x) } : { y: Number.MAX_SAFE_INTEGER, x: Number.MAX_SAFE_INTEGER };
  }, [rectOf, draft]);

  // ── Used space & the scroll plane ─────────────────────────────────────────
  // USED bounds = the union of every COMMITTED leaf rect (never the draft, so the plane
  // cannot resize mid-gesture — overflow:visible covers the in-flight frame). Measured
  // fresh on each call because auto-height text only knows its height from the DOM.
  const usedBounds = useCallback(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of slideLeaves) {
      const h = getH(el);
      if (el.x < x0) x0 = el.x;
      if (el.y < y0) y0 = el.y;
      if (el.x + el.w > x1) x1 = el.x + el.w;
      if (el.y + h > y1) y1 = el.y + h;
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }, [slideLeaves, getH]);

  // The PLANE is the scrollable surface the scaled page sits on: used bounds ∪ the page
  // rect, grown by PLANE_MARGIN on every side. `ox`/`oy` are the page's logical offset
  // inside it, so an element at a negative coordinate renders left of / above the page and
  // still lands inside the plane.
  const plane = useMemo(() => {
    const u = usedBounds();
    const x0 = Math.min(0, u ? u.x : 0), y0 = Math.min(0, u ? u.y : 0);
    const x1 = Math.max(page.width, u ? u.x + u.w : 0), y1 = Math.max(page.height, u ? u.y + u.h : 0);
    return {
      w: (x1 - x0) + PLANE_MARGIN * 2, h: (y1 - y0) + PLANE_MARGIN * 2,
      ox: PLANE_MARGIN - x0, oy: PLANE_MARGIN - y0,
    };
  }, [usedBounds, page.width, page.height]);

  // The reading view's own scroll surface and its park-on-the-slide effect lived here. Both were ONLY for
  // the deck's reading view — the surface that had to grow past 1280x720 so content parked off the
  // slide was still reachable, and the scroll fix-up that seated it on the page. The reading view is
  // gone and edit mode covers the same ground with strictly more: `plane` above is the same union
  // PLUS a PLANE_MARGIN of bleed, the canvas never clips, the zoom cluster's "Fit all content"
  // frames the used bounds, and off-slide elements there are selectable and draggable back rather
  // than merely visible.

  const selRoots = useMemo(() => selectionRoots(selection), [selectionRoots, selection]);
  // The ACTIVE slide's build steps — the input the canvas badges, the layers-row marks and the
  // Build order section all share. Derived, never stored: `build` lives on the elements, so there
  // is nothing here that could disagree with what present mode reads.
  const slideSteps = useMemo(() => buildStepsOf(slideLeaves), [slideLeaves]);

  // Tree rows select exactly the row's element; the drill state follows it so canvas clicks
  // stay at that level.
  const selectFromTree = useCallback((id) => {
    setSelection([id]);
    setEnteredGroupId(parentOf(elById[id]));
  }, [setSelection, elById]);
  // A BUILD STEP row selects its members — leaves, possibly from different groups. The drill state
  // follows them only when they share one parent; otherwise it resets, because there is no single
  // level a subsequent canvas click could sensibly stay at.
  const selectManyFromTree = useCallback((ids) => {
    const list = (Array.isArray(ids) ? ids : []).filter((id) => elById[id]);
    if (!list.length) return;
    setSelection(list);
    const parent = parentOf(elById[list[0]]);
    setEnteredGroupId(list.every((id) => parentOf(elById[id]) === parent) ? parent : null);
  }, [setSelection, elById]);

  // Switching slides is pure viewport navigation — it commits nothing. Selection and the group
  // drill self-heal through `all`; the text/table editors are closed here because their element
  // unmounts silently, and a stale cursor would reopen on the way back. The slide id stays a
  // CURSOR and never enters the override bag, exactly like `activeCell` and `croppingId`.
  //
  // `order` is the deck a just-committed slide op produced. The effective `slides` list is one
  // render behind the commit, so a brand-new slide is not findable in it yet; the op hands over
  // the order it computed rather than the cursor guessing.
  const activateSlide = useCallback((slideId, order) => {
    if (!isDeck || slideId == null) return;
    const i = (order || slideIdsOf(slides)).indexOf(slideId);
    if (i < 0) return;
    slideIndexRef.current = i;
    setWantedSlideId(slideId);
    setEditingTextId(null);
    setActiveCell(null);
    setHoverId(null);
  }, [isDeck, slides]);

  // ── Commit machinery ──────────────────────────────────────────────────────
  const doCommit = (next, opts = {}) => {
    const bytes = byteLen(next);
    if (bytes > 60000) {
      showToast("Edit budget full — copy the overrides JSON and bake it back to continue editing");
      return false;
    }
    const now = Date.now();
    const coalesced = opts.coalesce && lastCommit.current.kind && lastCommit.current.kind === opts.kind && now - lastCommit.current.t < 800;
    if (!coalesced) {
      // An undo entry is { bag, slideId, peerSlideId }: restoring the bag alone would silently
      // revert an edit made on a slide the author has since navigated away from, with nothing
      // changing on screen. `slideId` is the PRE-op slide — where an undo of this commit belongs —
      // and `peerSlideId` is where the commit LEAVES the author, which is where the matching redo
      // belongs. They are the same slide for every edit that stays put; a slide op that moves the
      // cursor passes `opts.afterSlideId` (see commitSlideOp). Both are viewport cursors only —
      // stored on this stack, never in the bag.
      undoStack.current.push(undoEntry(ovRaw, activeSlideId, opts.afterSlideId));
      if (undoStack.current.length > 50) undoStack.current.shift();
      redoStack.current = [];
    }
    lastCommit.current = { t: now, kind: opts.kind || (opts.coalesce ? "c" : null) };
    setOvRaw(next);
    bump((x) => x + 1);
    return true;
  };

  // Bag assembly is PURE and lives above (buildPatched / zEntries / buildDeleted / buildInserted
  // / buildAdded). Everything from here down is glue: read the current projection, call one of
  // them, commit. `patched` binds the scene so the call sites stay short.
  const patched = (bag, entries) => buildPatched(SCENE, bag, entries);

  const patchMany = (entries, opts = {}) => doCommit(patched(ov, entries), opts);
  const patchEl = (id, partial, opts = {}) => patchMany([{ id, partial }], { ...opts, kind: opts.kind || (opts.coalesce ? "p:" + id : undefined) });

  // The cell cursor only exists while its own table is the element being edited. Every exit
  // path already clears editingTextId, so deriving from it means no exit route can leak a
  // stale cursor into the inspector.
  useEffect(() => {
    if (activeCell && editingTextId !== activeCell.id) setActiveCell(null);
  }, [editingTextId, activeCell]);

  const patchTable = (id, partial, opts) => patchEl(id, partial, opts || {});

  const commitCell = (id, r, c, changes) => {
    const el = slideLeaves.find((e) => e.id === id);
    if (!el || el.type !== "table") return;
    patchTable(id, { cells: tableWithCell(el, r, c, changes) });
  };

  const tableRowCol = (id, kind, at, remove) => {
    const el = slideLeaves.find((e) => e.id === id);
    if (!el || el.type !== "table") return;
    const next = kind === "row" ? tableWithRow(el, at, remove) : tableWithCol(el, at, remove);
    if (!next) return;
    patchTable(id, next);
    // Keep the cursor inside the grid that now exists.
    setActiveCell((cur) => {
      if (!cur || cur.id !== id) return cur;
      const rows = next.cells.length, cols = next.cells[0].length;
      return { id, r: Math.min(cur.r, rows - 1), c: Math.min(cur.c, cols - 1) };
    });
  };

  // Dragging a column divider moves weight between the two tracks it separates; every other
  // column keeps its share, so the drag is local and the weights still sum to 1.
  const onTableColDrag = (event, el, index) => {
    const node = nodeRefs.current[el.id];
    if (!node) return;
    const box = node.getBoundingClientRect();
    if (box.width <= 0) return;
    const t = normTable(el);
    const start = t.colFracs.slice();
    const pair = start[index] + start[index + 1];
    const originX = event.clientX;
    const move = (ev) => {
      const delta = (ev.clientX - originX) / box.width;
      const left = Math.max(TABLE_MIN_WEIGHT, Math.min(pair - TABLE_MIN_WEIGHT, start[index] + delta));
      const next = start.slice();
      next[index] = left;
      next[index + 1] = pair - left;
      patchTable(el.id, { colWidths: tableTrack(next) }, { coalesce: true, kind: "tcol:" + el.id });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const navCell = (el, dir) => {
    if (dir === "exit") { setEditingTextId(null); setActiveCell(null); return; }
    const t = normTable(el);
    const cur = activeCell && activeCell.id === el.id ? activeCell : { r: 0, c: 0 };
    let { r, c } = cur;
    if (dir === "down") r += 1;
    else if (dir === "next") { c += 1; if (c >= t.cols) { c = 0; r += 1; } }
    else if (dir === "prev") { c -= 1; if (c < 0) { c = t.cols - 1; r -= 1; } }
    if (r < 0 || r >= t.cells.length) return;
    setActiveCell({ id: el.id, r, c });
  };

  const patchChart = (id, mutator, extra) => {
    const el = slideLeaves.find((e) => e.id === id);
    if (!el) return false;
    const cfg = clone(el.chart || {});
    if (mutator) mutator(cfg);
    return patchEl(id, mutator ? { chart: cfg, ...(extra || {}) } : { ...(extra || {}) });
  };

  // Deleting a group deletes its whole subtree; any group left childless goes too (Figma's
  // empty-group rule).
  const deleteEls = (ids) => {
    const result = buildDeleted(SCENE, ov, all, ids);
    if (!result) return;
    const kill = new Set(result.dead);
    doCommit(result.bag);
    setSelection([]);
    setEnteredGroupId((g) => (g && kill.has(g) ? null : g));
  };

  // ── Slide ops ─────────────────────────────────────────────────────────────
  // Glue only. The bag transform is pure (buildNewSlide / buildDuplicatedSlide /
  // buildDeletedSlide / buildSlidePatched / buildReorderedSlides), the commit is the one
  // `doCommit` — so a slide op takes the same 60 KB guard and the same undo snapshot every
  // element edit takes — and the cursor moves to the slide the op nominates. That nominated slide
  // is ALSO the transition's after-endpoint, so it is handed to `doCommit` as `afterSlideId`: the
  // undo entry then knows both ends, and redoing a New / Duplicate / Delete lands on the slide the
  // op produced instead of the one it started from.
  const commitSlideOp = (result) => {
    if (!result || !doCommit(result.bag, { afterSlideId: result.slideId })) return false;
    activateSlide(result.slideId, result.order);
    return true;
  };
  const slideCtx = () => ({ deckAll: merged.all, slides });
  // Every slide op is refused on a stale bag: its deck edits are ignored by the render (spec §3)
  // and it can never bake, so the op would look like a broken button. The toast repeats the stale
  // banner's own words and names its button, which is the only way out.
  const slideStaleBlocked = () => {
    const refusal = slideStaleRefusal(SCENE, ov);
    if (refusal) showToast(refusal);
    return !!refusal;
  };
  // Every op below takes an OPTIONAL target slide id, defaulting to the cursor — the filmstrip acts
  // on the row under the pointer, which is often not the slide the canvas is showing, and a
  // "hide" that silently hid the active slide instead would be a data-loss-shaped bug.
  const targetSlide = (slideId) => (slideId == null ? activeSlideId : slideId);
  // `layout` names one of SLIDE_LAYOUTS (absent / "blank" = an empty slide, exactly as before). Its
  // elements ride the same bag as the slide record, so a layout-stamped slide is ONE commit and ONE
  // undo step. `zOffset` is where the new slide's leaves belong in the global paint order — the
  // slide it is inserted after, plus that slide's own leaves, which is `slideZOffset` (the same
  // function duplicate-slide uses).
  const newSlide = (afterId, layout) => {
    if (slideStaleBlocked()) return;
    const refusal = slideAddRefusal(SCENE, ov);
    if (refusal) { showToast(refusal); return; }
    const after = targetSlide(afterId);
    commitSlideOp(buildNewSlide(SCENE, ov, {
      ...slideCtx(), afterId: after, layout, zOffset: slideZOffset(SCENE, slides, after),
    }));
  };
  const duplicateSlide = (slideId) => {
    const src = slideId == null ? activeSlideId : slideId;
    if (slideStaleBlocked()) return;
    const refusal = slideAddRefusal(SCENE, ov);
    if (refusal) { showToast(refusal); return; }
    // The copy's leaves start where the SOURCE's baked leaves end — one slide's worth further
    // into the global paint order (slideZOffset, shared with the tests). Pending z may collide
    // across slides between bakes; that is declared harmless (see leavesBeforeSlide) because
    // renumberLeafZ re-contiguises by (slideIndex, z) at bake and nothing paints two slides at once.
    commitSlideOp(buildDuplicatedSlide(SCENE, ov, {
      ...slideCtx(), slideId: src,
      elements: elementsOfSlide(merged.all, src, isDeck),
      zOffset: slideZOffset(SCENE, slides, src),
    }));
  };
  const deleteSlide = (slideId) => {
    const target = slideId == null ? activeSlideId : slideId;
    if (slideStaleBlocked()) return;
    const refusal = slideDeleteRefusal(slides, target);
    if (refusal) { showToast(refusal); return; }
    if (commitSlideOp(buildDeletedSlide(SCENE, ov, slides, target))) setSelection([]);
  };
  // Rename/hide/background/notes all land here. Renaming coalesces per slide so a typed name is
  // one undo step, not one per keystroke.
  const patchSlide = (partial, opts = {}, slideId) => {
    if (slideStaleBlocked()) return;
    const next = buildSlidePatched(SCENE, ov, targetSlide(slideId), partial);
    if (next) doCommit(next, opts);
  };
  const slideById = (slideId) => (slides || []).find((slide) => slide.id === targetSlide(slideId)) || null;
  const toggleSlideHidden = (slideId) => {
    const slide = slideById(slideId);
    if (slide) patchSlide({ hidden: !slide.hidden }, {}, slide.id);
  };
  const renameSlide = (name, slideId) => {
    const id = targetSlide(slideId);
    patchSlide({ name }, { coalesce: true, kind: "sname:" + id }, id);
  };
  const moveSlide = (toIndex, slideId) => {
    if (slideStaleBlocked()) return;
    // buildReorderedSlides CLAMPS a negative toIndex to 0 — deliberately, and the fuzzer covers
    // that — so the rail's "no drop" marker must never reach it or a bad index silently slams the
    // slide to the top of the deck. The drag release already guards it; this makes the refusal a
    // property of the glue, so no future caller can bypass one `&&` in one component.
    if (!Number.isFinite(toIndex) || Math.trunc(toIndex) < 0) return;
    commitSlideOp(buildReorderedSlides(SCENE, ov, slides, targetSlide(slideId), toIndex));
  };

  // The deck the INCOMING bag describes. An undo/redo swaps the whole bag, so the deck it lands on
  // is not the one on screen — undoing a slide delete restores that slide, and resolving the cursor
  // against the outgoing `slides` would find nothing and silently leave the author on the
  // neighbour, watching a restore they cannot see. Same one-render-behind problem the slide ops
  // solve by returning their order.
  const slideOrderFor = (bag) => (isDeck ? slideIdsOf(slidesOf(SCENE, bag == null ? undefined : bag)) : undefined);
  // A transition has TWO endpoints, and undo/redo travel between them in opposite directions: the
  // entry being applied carries the cursor for the bag it restores (`slideId`), and the entry
  // pushed onto the OTHER stack must carry the endpoint on the other side (`peerSlideId`) — the
  // cursor the state we are leaving belongs to. Reusing one endpoint for both is what made redoing
  // a New land back on the slide the New was invoked from, and made redoing a Delete land on
  // nothing at all (the slide is gone again, activateSlide bails, and the cursor falls to whatever
  // resolveActiveSlideId picks). Neither endpoint is a wherever-the-author-is-standing reading: the
  // author may have navigated in between, and a redone New still belongs on the slide it re-creates.
  const undo = () => {
    if (!undoStack.current.length) return;
    const prev = undoStack.current.pop();
    redoStack.current.push(undoEntry(ovRaw, prev.peerSlideId, prev.slideId));
    lastCommit.current = { t: 0, kind: null };
    setOvRaw(prev.bag === null ? undefined : prev.bag);
    activateSlide(prev.slideId, slideOrderFor(prev.bag));
    bump((x) => x + 1);
  };
  const redo = () => {
    if (!redoStack.current.length) return;
    const next = redoStack.current.pop();
    undoStack.current.push(undoEntry(ovRaw, next.peerSlideId, next.slideId));
    lastCommit.current = { t: 0, kind: null };
    setOvRaw(next.bag === null ? undefined : next.bag);
    activateSlide(next.slideId, slideOrderFor(next.bag));
    bump((x) => x + 1);
  };

  // ── Z-order ───────────────────────────────────────────────────────────────
  // z lives on leaves only. A group's descendants stay CONTIGUOUS in the global order because
  // every operation below rebuilds that order and renumbers — never because of a runtime check.
  // `orderedLeafIds` is one SLIDE's leaf order, so the numbering starts where the previous
  // slides' leaves end (zOffset). That keeps a freshly baked deck's z values untouched by an
  // order command on slide N — see leavesBeforeSlide. zOffset is 0 on a v1 scene.
  const zOrder = (orderedLeafIds) => zEntries(all, orderedLeafIds, zOffset);
  const applyOrder = (orderedIds) => {
    const entries = zOrder(orderedIds);
    if (entries.length) patchMany(entries);
  };
  // Global leaf order implied by the sibling lists, with optional per-parent overrides
  // (ascending order, key "" = root).
  const flattenOrder = (overrides) => {
    const ovr = overrides || {};
    const out = [];
    const rec = (pid, depth) => {
      if (depth > 32) return;
      const key = pid || "";
      const list = ovr[key] || kidsOf(pid).slice().sort((a, b) => zOf(a.id) - zOf(b.id)).map((e) => e.id);
      for (const id of list) {
        const e = elById[id];
        if (!e) continue;
        if (e.type === "group") rec(id, depth + 1); else out.push(id);
      }
    };
    rec(null, 0);
    return out;
  };
  const siblingsDesc = (pid) => kidsOf(pid).slice().sort((a, b) => zOf(b.id) - zOf(a.id)).map((e) => e.id);

  // Arrange moves the selection root as a BLOCK among its sibling blocks.
  const orderCmd = (cmd) => {
    const roots = selectionRoots(stateRef.current.selection);
    if (!roots.length) return;
    const id = roots[0];
    const el = elById[id];
    if (!el) return;
    const pid = parentOf(el);
    const asc = siblingsDesc(pid).slice().reverse();
    const i = asc.indexOf(id);
    if (i < 0) return;
    asc.splice(i, 1);
    if (cmd === "front") asc.push(id);
    else if (cmd === "back") asc.unshift(id);
    else if (cmd === "forward") asc.splice(Math.min(i + 1, asc.length), 0, id);
    else asc.splice(Math.max(i - 1, 0), 0, id);
    applyOrder(flattenOrder({ [pid || ""]: asc }));
  };

  // Tree drag/drop: between rows = reorder inside the implied parent; onto a group row =
  // reparent into it. One undo entry for the parent change + the z renumber.
  const onTreeDrop = (dragId, target) => {
    const el = elById[dragId];
    if (!el || !target) return;
    let newParent, pos;
    if (target.kind === "into") {
      if (isAncestorOf(dragId, target.id)) return;
      newParent = target.id;
      pos = 0; // top of the group (desc order)
    } else if (target.kind === "before") {
      const b = elById[target.id];
      if (!b || b.id === dragId) return;
      newParent = parentOf(b);
      if (isAncestorOf(dragId, newParent)) return;
      const list = siblingsDesc(newParent).filter((i) => i !== dragId);
      const at = list.indexOf(target.id);
      pos = at < 0 ? list.length : at;
    } else {
      newParent = null;
      const list = siblingsDesc(null).filter((i) => i !== dragId);
      pos = list.length;
    }
    const oldParent = parentOf(el);
    const desc = {};
    desc[oldParent || ""] = siblingsDesc(oldParent).filter((i) => i !== dragId);
    const tgtKey = newParent || "";
    const base = desc[tgtKey] != null ? desc[tgtKey] : siblingsDesc(newParent).filter((i) => i !== dragId);
    const next = base.slice();
    next.splice(Math.max(0, Math.min(pos, next.length)), 0, dragId);
    desc[tgtKey] = next;
    const asc = {};
    for (const k of Object.keys(desc)) asc[k] = desc[k].slice().reverse();
    const order = flattenOrder(asc);
    const parentChanged = (oldParent || null) !== (newParent || null);
    const ze = zOrder(order);
    if (!parentChanged && !ze.length) return;
    let nx = ov;
    if (parentChanged) nx = patched(nx, [{ id: dragId, partial: { parent: newParent } }]);
    if (ze.length) nx = patched(nx, ze);
    doCommit(nx);
  };

  // ── Group / ungroup ───────────────────────────────────────────────────────
  const groupSelection = () => {
    if (mintBlocked) { showToast(mintBlocked); return; }
    const roots = selectionRoots(stateRef.current.selection);
    if (roots.length < 2) { showToast("Select at least two items to group"); return; }
    // DECK-WIDE, and against the ONE reserved-id set every mint site shares: element ids are
    // unique across the whole deck AND share a namespace with slide ids (spec S2).
    const gid = idReserver(SCENE, ov, { deckAll: merged.all, slides })("group");
    const ps = roots.map((id) => parentOf(elById[id]));
    const common = ps.every((p) => p === ps[0]) ? ps[0] : null;
    // The group joins the active slide, and CANNOT span slides: `roots` came from
    // selectionRoots, which resolves ids through the slide-filtered `elById`, so an id from
    // another slide never survives into it. The invariant (spec S4) is structural here.
    let nx = { ...ov, added: [...ov.added, stampSlide({ id: gid, type: "group", name: "Group", parent: common }, activeSlideId, isDeck)] };
    nx = patched(nx, roots.map((id) => ({ id, partial: { parent: gid } })));
    // Members become one contiguous block ending where the topmost member leaf sat — without
    // splitting the block of any group they are being pulled OUT of.
    const members = new Set(selectionLeaves(roots));
    const order = groupBlockOrder(
      slideLeaves.map((e) => e.id), members,
      (lid) => ancestorChain(lid).slice(1),
      common ? ancestorChain(common) : [],
    );
    const ze = zOrder(order);
    if (ze.length) nx = patched(nx, ze);
    if (doCommit(nx)) { setSelection([gid]); setEnteredGroupId(common); }
  };

  const ungroupSelection = () => {
    const groups = selectionRoots(stateRef.current.selection).filter((id) => elById[id] && elById[id].type === "group");
    if (!groups.length) { showToast("Select a group to ungroup"); return; }
    const entries = [];
    const freed = [];
    for (const gid of groups) {
      const g = elById[gid];
      for (const c of kidsOf(gid)) { entries.push({ id: c.id, partial: { parent: parentOf(g) } }); freed.push(c.id); }
    }
    let nx = patched(ov, entries);
    const gone = new Set(groups);
    const baseDel = groups.filter((id) => SCENE.elements.some((e) => e.id === id));
    const patch = { ...nx.patch };
    groups.forEach((id) => delete patch[id]);
    nx = {
      ...nx, patch,
      added: nx.added.filter((e) => !gone.has(e.id)),
      deleted: [...new Set([...nx.deleted, ...baseDel])],
    };
    if (doCommit(nx)) {
      setSelection(freed);
      setEnteredGroupId(groups.length === 1 ? parentOf(elById[groups[0]]) : null);
    }
  };

  // ── Align / distribute ────────────────────────────────────────────────────
  // Roots, never leaves: a group aligns as ONE unit. The resulting per-root delta is written
  // to that root's leaves in a single commit, so it is one undo step.
  const alignSelection = (edge) => {
    const roots = selectionRoots(stateRef.current.selection);
    if (roots.length < 2) { showToast("Select at least two items to align"); return; }
    const entries = alignEntries(roots, edge, (id) => rectOf(id), descLeafIds);
    if (entries.length) patchMany(entries);
  };
  const distributeSelection = (axis) => {
    const roots = selectionRoots(stateRef.current.selection);
    if (roots.length < 3) { showToast("Select at least three items to distribute"); return; }
    const entries = distributeEntries(roots, axis, (id) => rectOf(id), descLeafIds);
    if (entries.length) patchMany(entries);
  };

  // ── Duplicate / clipboard ─────────────────────────────────────────────────
  // A snapshot is a flat, fully-resolved deep copy of one selection root's subtree (root
  // first; `parent` still names the ORIGINAL ids). Both ⌘D and ⌘C/⌘V insert from these.
  const snapshotRoots = (roots) => roots.map((rid) => {
    const nodes = [];
    const rec = (id, depth) => {
      const src = elById[id];
      if (!src || depth > 32) return;
      nodes.push(clone(src));
      if (src.type === "group") for (const c of kidsOf(id)) rec(c.id, depth + 1);
    };
    rec(rid, 0);
    return { rootId: rid, rootParent: parentOf(elById[rid]), nodes };
  }).filter((t) => t.nodes.length);

  // The slide projection this component hands the pure paste/duplicate builder. `elements` and
  // `leafOrder` are the ACTIVE slide's; `deckAll` is the whole deck, which is only ever reached
  // for to make a minted id unique.
  const insertCtx = () => ({
    deckAll: merged.all, slides, elements: all,
    leafOrder: slideLeaves.map((e) => e.id),
    zOffset, slideId: activeSlideId, isDeck,
  });

  const insertTrees = (trees, dx, dy) => {
    if (mintBlocked) { showToast(mintBlocked); return; }
    const result = buildInserted(SCENE, ov, insertCtx(), trees, dx, dy);
    if (!result) return;
    // ONE commit: the additions and the whole z renumber undo together.
    if (doCommit(result.bag)) {
      setSelection(result.rootIds);
      const drill = trees[0].rootParent && elById[trees[0].rootParent] ? trees[0].rootParent : null;
      setEnteredGroupId(drill);
    }
  };

  const duplicateSelection = () => {
    const roots = selectionRoots(stateRef.current.selection);
    if (!roots.length) return;
    insertTrees(snapshotRoots(roots), 16, 16);
  };
  // In-memory only: never the OS clipboard, never URL state.
  const copySelection = () => {
    const roots = selectionRoots(stateRef.current.selection);
    if (!roots.length) return;
    clipboard.current = snapshotRoots(roots);
    showToast(roots.length === 1 ? "1 item copied" : roots.length + " items copied");
  };
  const pasteClipboard = () => {
    const trees = clipboard.current;
    if (!trees || !trees.length) return;
    insertTrees(clone(trees), 16, 16);
  };

  // ── Nudge ─────────────────────────────────────────────────────────────────
  // The edit canvas is UNBOUNDED: positions are never clamped to the page. Negative
  // coordinates and coordinates past page.width/height are all legal — the plane below
  // grows to cover them so anything parked off-page stays reachable.
  const nudge = (dx, dy) => {
    const ids = selectionLeaves(stateRef.current.selection);
    if (!ids.length) return;
    const entries = ids.map((id) => {
      const el = elById[id];
      if (!el) return null;
      return { id, partial: { x: el.x + dx, y: el.y + dy } };
    }).filter(Boolean);
    patchMany(entries, { coalesce: true, kind: "nudge:" + ids.join(",") });
  };

  // ── Image crop ────────────────────────────────────────────────────────────
  // See the model comment above ImageContent. `cropOf` is the draft-aware read every renderer
  // uses; `cropTravel` turns the element box + the image's natural size into the pannable
  // distance Dx/Dy in logical px, which is what makes a drag track the pointer 1:1.
  const cropOf = (el) => {
    if (!el || el.type !== "image") return null;
    if (cropDraft && cropDraft.id === el.id) return cropDraft;
    return normCrop(el.crop);
  };
  const cropTravel = (el, zoom) => {
    const W = el.w, H = getH(el);
    let ox = 0, oy = 0;
    if ((el.fit || "cover") === "cover") {
      const node = nodeRefs.current[el.id];
      const img = node ? node.querySelector("img") : null;
      const nw = img ? img.naturalWidth : 0, nh = img ? img.naturalHeight : 0;
      if (nw > 0 && nh > 0) {
        const s = Math.max(W / nw, H / nh);
        ox = Math.max(0, nw * s - W);
        oy = Math.max(0, nh * s - H);
      }
    }
    return { dx: W * (zoom - 1) + zoom * ox, dy: H * (zoom - 1) + zoom * oy };
  };
  const commitCrop = (id, c) => patchEl(id, { crop: roundCrop(c) });

  // Dragging INSIDE the cropped element pans it: the element's own move gesture never starts
  // (see onElPointerDown), and the pan commits once, on release.
  const startCropGesture = (e, el) => {
    const s = scale || 1;
    const start = cropOf(el) || DEFAULT_CROP;
    const trav = cropTravel(el, start.zoom);
    const startPt = { x: e.clientX, y: e.clientY };
    let moved = false, last = null;
    gestureCancel.current = false;
    gestureActive.current = true;
    const onMove = (ev) => {
      if (gestureCancel.current) return;
      const rdx = ev.clientX - startPt.x, rdy = ev.clientY - startPt.y;
      if (!moved && Math.abs(rdx) < 3 && Math.abs(rdy) < 3) return;
      moved = true;
      // Moving the picture RIGHT reveals what was off its left edge, so ox DECREASES.
      const ox = trav.dx > 0 ? clamp01(start.ox - (rdx / s) / trav.dx) : start.ox;
      const oy = trav.dy > 0 ? clamp01(start.oy - (rdy / s) / trav.dy) : start.oy;
      last = { ox, oy, zoom: start.zoom };
      setCropDraft({ id: el.id, ...last });
    };
    const finish = (commit) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEv);
      window.removeEventListener("keydown", onKeyEv, true);
      gestureActive.current = false;
      if (commit && moved && last && !gestureCancel.current) commitCrop(el.id, last);
      setCropDraft(null);
    };
    const onUp = () => finish(true);
    const onCancelEv = () => finish(false);
    // Same staging as a move: the first Escape cancels the in-flight pan and is swallowed here,
    // so escapeStep (which would leave crop mode) only sees the NEXT press.
    const onKeyEv = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); gestureCancel.current = true; finish(false); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEv);
    window.addEventListener("keydown", onKeyEv, true);
  };

  // Arrow keys pan the crop instead of nudging the element while crop mode is on — moving the
  // element is disabled there, so the keys would otherwise do the one thing crop mode forbids.
  const cropNudge = (dx, dy) => {
    const el = elById[croppingId];
    if (!el || el.type !== "image") return;
    const cur = cropOf(el) || DEFAULT_CROP;
    const trav = cropTravel(el, cur.zoom);
    const next = {
      ox: trav.dx > 0 ? clamp01(cur.ox - dx / trav.dx) : cur.ox,
      oy: trav.dy > 0 ? clamp01(cur.oy - dy / trav.dy) : cur.oy,
      zoom: cur.zoom,
    };
    setCropDraft(null);
    patchEl(el.id, { crop: roundCrop(next) }, { coalesce: true, kind: "crop:" + el.id });
  };

  // The one bundle the inspector needs. `value` is already draft-resolved so the panel and the
  // canvas can never disagree about what the current crop is.
  const tableUI = {
    cell: activeCell,
    rowCol: (id, kind, at, remove) => tableRowCol(id, kind, at, remove),
    cellPatch: (id, r, c, changes) => commitCell(id, r, c, changes),
    // Setting one track to N% rescales the OTHERS to fill the remainder, keeping the weights
    // normalised without the edited track fighting whatever the author just typed.
    setTrack: (id, kind, index, pct) => {
      const el = elById[id];
      if (!el || el.type !== "table") return;
      const t = normTable(el);
      const fracs = (kind === "col" ? t.colFracs : t.rowFracs).slice();
      if (fracs.length < 2) return;
      const want = Math.max(TABLE_MIN_WEIGHT, Math.min(1 - TABLE_MIN_WEIGHT * (fracs.length - 1), (Number(pct) || 0) / 100));
      const restBefore = fracs.reduce((sum, f, i) => (i === index ? sum : sum + f), 0);
      const scale = restBefore > 0 ? (1 - want) / restBefore : 0;
      const next = fracs.map((f, i) => (i === index ? want : f * scale));
      patchTable(el.id, kind === "col" ? { colWidths: tableTrack(next) } : { rowHeights: tableTrack(next) });
    },
  };

  // The slide bundle the inspector's Slide section reads. One object for the same reason `cropUI`
  // and `tableUI` are: the panel and the canvas can then never disagree about which slide's fields
  // are on screen. `null` for a v1 scene or a deck with no live slide, which is what makes the
  // section appear only when there is a slide to talk about.
  const slideUI = activeSlide ? {
    id: activeSlide.id, index: activeSlideIndex, count: slides.length,
    name: activeSlide.name, background: activeSlide.background, hidden: !!activeSlide.hidden,
    pageBackground: page.background,
    patch: (partial) => patchSlide(partial, {}, activeSlide.id),
  } : null;

  // The build UI's context, handed to the LAYERS panel (the tree rows' marks and the Build order
  // section under them). Deck only — a v1 scene cannot carry the key, so both are simply absent
  // there, which is also why TreePanel takes this as one nullable bundle rather than five props.
  //
  // `apply` takes a whole STEP SEQUENCE and commits the difference in ONE patchMany — one undo
  // entry for a reorder that moved four leaves, exactly like the grouping op's "per-element `parent`
  // patches plus a `z` renumber as ONE undo step". Clearing a step writes `null`, and prunePatch
  // drops the key when it matches the base element, so un-building something the deck never built
  // costs zero URL bytes.
  //
  // STALE BAG: every write is discarded when `_base !== SCENE.version`, so the controls are disabled
  // and say why (the same `disabled` / `disabledHint` pair NotesStrip takes). A reorder that is
  // silently swallowed is worse than one the author cannot start.
  const buildUI = isDeck ? {
    steps: slideSteps,
    leaves: slideLeaves,
    disabled: !!merged.stale,
    disabledHint: SLIDE_STALE,
    apply: (order) => {
      const entries = buildWritePlan(slideLeaves, order);
      if (entries.length) patchMany(entries);
    },
  } : null;

  const cropUI = {
    id: croppingId,
    value: croppingId ? (cropOf(elById[croppingId]) || DEFAULT_CROP) : null,
    hasSrc: (el) => !!(el && el.imageKey && imageMap[el.imageKey]),
    start: (id) => { setSelection([id]); setCroppingId(id); setCropDraft(null); },
    done: () => { setCroppingId(null); setCropDraft(null); },
    zoomLive: (id, z) => {
      const el = elById[id];
      const cur = cropOf(el) || DEFAULT_CROP;
      setCropDraft({ id, ox: cur.ox, oy: cur.oy, zoom: Math.max(CROP_ZOOM_MIN, Math.min(CROP_ZOOM_MAX, z)) });
    },
    zoomCommit: (id) => {
      if (!cropDraft || cropDraft.id !== id) return;
      const c = { ox: cropDraft.ox, oy: cropDraft.oy, zoom: cropDraft.zoom };
      setCropDraft(null);
      commitCrop(id, c);
    },
    reset: (id) => { setCropDraft(null); patchEl(id, { crop: null }); },
  };

  // ── Pointer gestures ──────────────────────────────────────────────────────
  // `onTap` fires on a release that never became a drag — a plain click, per `gestureIsTap`. Only
  // the ghost path uses it (see onElPointerDown): a placeholder has to take a caret on ONE click,
  // and doing it on pointerdown instead would make a placeholder the one element on the slide that
  // cannot be dragged. Threshold and cancel semantics are the gesture's existing ones, so nothing
  // new can fire it.
  const startMoveGesture = (e, ids, primaryId, onTap) => {
    const s = scale || 1;
    const startPt = { x: e.clientX, y: e.clientY };
    const roots = selectionRoots(ids);
    const leafIds = selectionLeaves(ids);
    const startRects = {};
    leafIds.forEach((id) => {
      const m = elById[id];
      if (m) startRects[id] = { x: m.x, y: m.y, w: m.w, h: getH(m) };
    });
    // The primary rect is the moved root's derived rect (union, for a group).
    const p0 = rectOf(primaryId, startRects);
    if (!p0 || !leafIds.length) return;
    const cands = roots.length === 1 ? snapCandidates(slideLeaves, new Set(leafIds), page, getH) : null;
    let moved = false;
    let lastRects = null;
    gestureCancel.current = false;
    gestureActive.current = true;

    const onMove = (ev) => {
      if (gestureCancel.current) return;
      const rdx = ev.clientX - startPt.x, rdy = ev.clientY - startPt.y;
      if (!moved && Math.abs(rdx) < 3 && Math.abs(rdy) < 3) return;
      moved = true;
      const dx = rdx / s, dy = rdy / s;
      let rect = { x: R(p0.x + dx), y: R(p0.y + dy), w: p0.w, h: p0.h };
      let guides = null;
      if (cands && !ev.altKey) {
        const sn = snapRect(rect, cands);
        rect = { ...rect, x: sn.x, y: sn.y };
        guides = sn.guides;
      }
      const ddx = rect.x - p0.x, ddy = rect.y - p0.y;
      const rects = {};
      leafIds.forEach((id) => {
        const r0 = startRects[id];
        if (r0) rects[id] = { x: R(r0.x + ddx), y: R(r0.y + ddy), w: r0.w, h: r0.h };
      });
      lastRects = rects;
      setDraft({ rects, guides });
    };
    const finish = (commit) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEv);
      window.removeEventListener("keydown", onKeyEv, true);
      gestureActive.current = false;
      if (commit && moved && lastRects && !gestureCancel.current) {
        patchMany(leafIds.filter((id) => lastRects[id]).map((id) => ({ id, partial: { x: lastRects[id].x, y: lastRects[id].y } })));
      }
      if (gestureIsTap(commit, moved, gestureCancel.current) && onTap) onTap();
      setDraft(null);
    };
    const onUp = () => finish(true);
    const onCancelEv = () => finish(false);
    const onKeyEv = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); gestureCancel.current = true; finish(false); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEv);
    window.addEventListener("keydown", onKeyEv, true);
  };

  // Canvas click resolves the hit leaf to what the user means: its outermost ancestor group,
  // or the direct child of the group they have drilled into. Cmd/Ctrl = deep select.
  const clickTarget = (leafId, deep) => {
    if (deep) return { id: leafId, entered: enteredGroupId };
    const chain = ancestorChain(leafId);
    const entered = enteredGroupId && chain.indexOf(enteredGroupId) >= 0 ? enteredGroupId : null;
    return { id: promoteId(leafId, entered), entered };
  };

  const onElPointerDown = (e, el) => {
    if (!editMode || e.button !== 0) return;
    // Under the Hand tool the event falls through to the canvas region, which pans.
    if (handActive) return;
    if (editingTextId === el.id) return;
    if (editingTextId) setEditingTextId(null);
    e.preventDefault();
    e.stopPropagation();
    // Crop mode claims the drag on ITS element: pan the picture, never move the element.
    if (croppingId === el.id) { startCropGesture(e, el); return; }
    const t = clickTarget(el.id, e.metaKey || e.ctrlKey);
    if (t.entered !== enteredGroupId) setEnteredGroupId(t.entered);
    let sel;
    if (e.shiftKey) {
      sel = selection.includes(t.id) ? selection.filter((i) => i !== t.id) : [...selection, t.id];
      setSelection(sel);
      if (!sel.includes(t.id)) return;
    } else {
      sel = selection.includes(t.id) ? selection : [t.id];
      setSelection(sel);
    }
    // A PLACEHOLDER takes the caret on a single click. The plan asks for exactly this ("not a
    // double-click dance") and it is safe to special-case, because a ghost has no content a click
    // could be trying to select: the only thing to do with an empty placeholder is type in it. All
    // four conditions live in `tapTarget` — including the two this used to be missing, the
    // modifier and the selection size, without which a shift-click on a placeholder both extended
    // the selection and dropped a caret into it, and the typing guard then ate ⌘D, Delete and ⌘G.
    const caretId = tapTarget(el, t.id, e.shiftKey, sel.length);
    startMoveGesture(e, sel, t.id, caretId ? () => setEditingTextId(caretId) : null);
  };

  const onElDoubleClick = (e, el) => {
    if (!editMode) return;
    if (croppingId === el.id) { e.stopPropagation(); return; } // crop mode owns this element
    e.stopPropagation();
    const chain = ancestorChain(el.id);
    const entered = enteredGroupId && chain.indexOf(enteredGroupId) >= 0 ? enteredGroupId : null;
    const targetId = promoteId(el.id, entered);
    const target = elById[targetId];
    if (target && target.type === "group" && selection.includes(targetId)) {
      // Drill one level: enter the group, select the child of it on the hit leaf's chain.
      const i = chain.indexOf(targetId);
      setEnteredGroupId(targetId);
      setSelection([i > 0 ? chain[i - 1] : el.id]);
      return;
    }
    if (targetId === el.id && (el.type === "text" || el.type === "table") && editingTextId !== el.id) {
      setEditingTextId(el.id);
      if (el.type === "table") setActiveCell({ id: el.id, r: 0, c: 0 });
      return;
    }
    if (entered !== enteredGroupId) setEnteredGroupId(entered);
    setSelection([targetId]);
  };

  // Marquee on empty canvas / page background. Below the threshold this stays a plain click
  // (deselect), matching the previous behaviour.
  const onCanvasPointerDown = (e) => {
    if (!editMode || e.button !== 0 || gestureActive.current) return;
    if (editingTextId) setEditingTextId(null);
    const s = scale || 1;
    const node = pageRef.current;
    const box = node ? node.getBoundingClientRect() : null;
    const startPt = { x: e.clientX, y: e.clientY };
    const origin = box ? { x: (e.clientX - box.left) / s, y: (e.clientY - box.top) / s } : { x: 0, y: 0 };
    const baseSel = e.shiftKey ? selection.slice() : [];
    const deep = e.metaKey || e.ctrlKey;
    let armed = false;
    let hits = [];
    gestureCancel.current = false;
    gestureActive.current = true;
    const onMove = (ev) => {
      if (gestureCancel.current) return;
      const rdx = ev.clientX - startPt.x, rdy = ev.clientY - startPt.y;
      if (!armed && Math.abs(rdx) < MARQUEE_THRESHOLD && Math.abs(rdy) < MARQUEE_THRESHOLD) return;
      armed = true;
      const cur = { x: origin.x + rdx / s, y: origin.y + rdy / s };
      const rect = {
        x: Math.min(origin.x, cur.x), y: Math.min(origin.y, cur.y),
        w: Math.abs(cur.x - origin.x), h: Math.abs(cur.y - origin.y),
      };
      // Touch, not contain.
      const leaves = slideLeaves.filter((le) => {
        const h = getH(le);
        return le.x < rect.x + rect.w && le.x + le.w > rect.x && le.y < rect.y + rect.h && le.y + h > rect.y;
      }).map((le) => le.id);
      const out = [];
      const seen = new Set();
      for (const lid of leaves) {
        const id = deep ? lid : clickTarget(lid, false).id;
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
      hits = out;
      const preview = [];
      const pseen = new Set(baseSel);
      for (const id of out) if (!pseen.has(id)) { pseen.add(id); preview.push(id); }
      setMarquee({ rect, preview: baseSel.concat(preview) });
    };
    const finish = (commit) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEv);
      window.removeEventListener("keydown", onKeyEv, true);
      gestureActive.current = false;
      setMarquee(null);
      if (!commit || gestureCancel.current) return;
      if (!armed) { setSelection([]); setEnteredGroupId(null); return; }
      const out = baseSel.slice();
      const seen = new Set(out);
      for (const id of hits) if (!seen.has(id)) { seen.add(id); out.push(id); }
      setSelection(out);
    };
    const onUp = () => finish(true);
    const onCancelEv = () => finish(false);
    const onKeyEv = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); gestureCancel.current = true; finish(false); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEv);
    window.addEventListener("keydown", onKeyEv, true);
  };

  const onHandlePointerDown = (e, el, hd) => {
    if (e.button !== 0) return;
    if (handActive) return; // resize handles are inert while panning; the canvas pans instead
    e.preventDefault();
    e.stopPropagation();
    const s = scale || 1;
    const start = { x: el.x, y: el.y, w: el.w, h: getH(el) };
    const startPt = { x: e.clientX, y: e.clientY };
    const isText = el.type === "text";
    let lastRect = null;
    let moved = false;
    gestureCancel.current = false;
    gestureActive.current = true;
    const onMove = (ev) => {
      if (gestureCancel.current) return;
      moved = true;
      const dx = (ev.clientX - startPt.x) / s, dy = (ev.clientY - startPt.y) / s;
      const r = resizeRect(start, hd, dx, dy, ev.shiftKey);
      lastRect = r;
      setDraft({ rects: { [el.id]: r }, guides: null });
    };
    const finish = (commit) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancelEv);
      window.removeEventListener("keydown", onKeyEv, true);
      gestureActive.current = false;
      if (commit && moved && lastRect && !gestureCancel.current) {
        patchEl(el.id, isText
          ? { x: lastRect.x, w: lastRect.w }
          : { x: lastRect.x, y: lastRect.y, w: lastRect.w, h: lastRect.h });
      }
      setDraft(null);
    };
    const onUp = () => finish(true);
    const onCancelEv = () => finish(false);
    const onKeyEv = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); gestureCancel.current = true; finish(false); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancelEv);
    window.addEventListener("keydown", onKeyEv, true);
  };

  // ── Add / copy / reset ────────────────────────────────────────────────────
  const addElement = (type, opts) => {
    // A deck with no live slide has nowhere to put this, and an element minted without a `slide`
    // is invisible forever and poisons every later Save. A STALE bag is the other silent failure:
    // the element would land in `added`, grow the byte meter and never appear, because mergeScene
    // throws a stale bag away wholesale. Refuse both, loudly. (The Add controls are also disabled
    // in the no-slide state; this is the belt to that pair of braces.)
    if (mintBlocked) { showToast(mintBlocked); return; }
    const zMax = slideLeaves.reduce((m, e) => Math.max(m, e.z), 0);
    // Land in the middle of what the author is LOOKING AT. Measured off the live page box,
    // so the plane offset, padding and any scroll/zoom are already folded in — and then clamped
    // onto the sheet by insertRect, which every branch below goes through.
    const node = canvasRef.current, pg = pageRef.current;
    let c = { x: page.width / 2, y: page.height / 2 };
    if (node && pg) {
      const nb = node.getBoundingClientRect(), pb = pg.getBoundingClientRect();
      const s = pb.width / page.width;
      if (s > 0) c = { x: (nb.left + nb.width / 2 - pb.left) / s, y: (nb.top + nb.height / 2 - pb.top) / s };
    }
    const sk = SHAPE_KINDS.find((s) => s.k === ((opts && opts.shape) || "rect")) || SHAPE_KINDS[0];
    // DECK-WIDE, like every other id mint, and against the ONE reserved-id set: ids are unique
    // across the deck AND share a namespace with slide ids (spec S2).
    const result = buildAdded(SCENE, ov, { deckAll: merged.all, slides, type, slideId: activeSlideId, isDeck }, (id, stamp) => {
      const common = stamp({ id, name: type === "text" ? "Text" : type === "shape" ? sk.name : type === "table" ? "Table" : type === "chart" ? "Chart" : type === "sqltable" ? "SQL table" : "Line", z: zMax + 10, opacity: 1 });
      let el;
      // `h: "auto"` overrides the nominal height insertRect clamped against — a fresh one-line
      // Text is ~24 units tall, and the clamp only has to keep the box on the sheet, not predict
      // the reflow. The key ORDER is unchanged (x, y, w, h), so the emitted JSON is byte-identical.
      if (type === "text") el = { ...common, type: "text", ...insertRect(c.x, c.y, 320, 24, page), h: "auto", text: "Text", level: "p", fontSize: 16, color: "#231f20", align: "left" };
      else if (type === "shape") {
        el = { ...common, type: "shape", ...insertRect(c.x, c.y, sk.w, sk.h, page), fill: "#e8eef4", stroke: "#0777b3", strokeWidth: 0, radius: 8 };
        // `shape` is omitted for a rectangle so a plain box stays byte-identical to before.
        if (sk.k !== "rect") el.shape = sk.k;
      }
      else if (type === "table") {
        // 3x3 of empty cells. Weights are omitted entirely for a uniform grid, so a freshly
        // added table costs only its cell text in the override bag.
        const blank = () => [{ t: "" }, { t: "" }, { t: "" }];
        el = { ...common, type: "table", ...insertRect(c.x, c.y, 420, 108, page), cells: [blank(), blank(), blank()] };
      }
      // The whole element is pure (see newChartElement): the default query is a VALUES table, so
      // the chart draws before the author has typed anything and can never fail on this dive.
      else if (type === "chart") el = newChartElement(common, c.x, c.y, page);
      // Same argument as the chart's, one type over: the default query is a literal VALUES table, so
      // the grid draws real rows before the author has typed anything and cannot fail on this dive.
      else if (type === "sqltable") el = newSqlTableElement(common, c.x, c.y, page);
      else el = { ...common, type: "line", ...insertRect(c.x, c.y, 240, 12, page), orientation: "h", color: "#0777b3", thickness: 2 };
      return el;
    });
    if (doCommit(result.bag)) setSelection([result.id]);
  };

  const copyOverrides = async () => {
    const txt = JSON.stringify(ov, null, 2);
    try {
      // Clipboard promises can hang unresolved in sandboxed iframes — race a timeout so the
      // fallbacks stay reachable.
      await Promise.race([
        navigator.clipboard.writeText(txt),
        new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), 1500)),
      ]);
      showToast("Overrides JSON copied — paste it to Claude to bake edits into the dive");
      return;
    } catch (err) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      let ok = false;
      try {
        ta.select();
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
      if (ok) {
        showToast("Overrides JSON copied — paste it to Claude to bake edits into the dive");
        return;
      }
    } catch (err) { /* fall through */ }
    setCopyModal(txt);
  };

  const resetAll = () => {
    undoStack.current.push(undoEntry(ovRaw, activeSlideId));
    redoStack.current = [];
    setOvRaw(undefined);
    setSelection([]);
    bump((x) => x + 1);
    showToast("All edits reset to the saved scene");
  };

  // Esc is staged, one step per press: cancel an active gesture → leave crop mode → leave text
  // editing → step out of the entered group → clear the selection. The gesture stage is owned
  // elsewhere (a move's / crop pan's capture-phase Escape listener stops propagation so this
  // handler never double-steps; the contentEditable swallows its own Escape).
  const escapeStep = () => {
    // Crop is the outermost mode, so it leaves first — and it KEEPS the selection.
    if (croppingId) { setCroppingId(null); setCropDraft(null); return; }
    if (editingTextId) { setEditingTextId(null); return; }
    if (enteredGroupId) {
      const g = elById[enteredGroupId];
      setSelection([enteredGroupId]);
      setEnteredGroupId(g ? parentOf(g) : null);
      return;
    }
    setSelection([]);
  };

  // ── Keyboard (single global handler) ──────────────────────────────────────
  stateRef.current = {
    editMode, selection, undo, redo, deleteEls, orderCmd, nudge, setSelection,
    escapeStep, groupSelection, ungroupSelection, setTool, setSpaceHeld,
    duplicateSelection, copySelection, pasteClipboard, croppingId, cropNudge,
  };
  // Registered only WHILE EDITING, which is what makes the isolation claim literal: present mode
  // owns every key it handles because this listener does not exist then, rather than because it
  // returns early. (It used to register unconditionally and bail on `!editMode` — same behaviour,
  // but a live listener in front of present mode's is a standing invitation to a future collision.)
  useEffect(() => {
    if (!editMode) return undefined;
    const onKey = (e) => {
      const S = stateRef.current;
      const ae = document.activeElement;
      if (isTypingTarget(ae)) return;
      const meta = e.metaKey || e.ctrlKey;
      // The filmstrip is not the canvas. The check above only exempts INPUT-like focus, so a
      // focused <button> — and the slide menu AUTOFOCUSES one — left Backspace and ⌘D reaching the
      // canvas selection behind the menu and destroying it. Undo/redo is the one global that still
      // means the same thing from the rail, so it is the only key let through.
      if (ae && ae.closest && ae.closest("[data-filmstrip],[data-film-menu]")) {
        if (!(meta && (e.key === "z" || e.key === "Z"))) return;
      }
      if (meta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); if (e.shiftKey) S.redo(); else S.undo(); return; }
      if (meta && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (e.shiftKey) S.ungroupSelection(); else S.groupSelection();
        return;
      }
      // ⌘D duplicates (preventDefault stops the browser's bookmark dialog). ⌘C/⌘V use an
      // in-memory clipboard; ⌘C only claims the event when something is selected, so plain
      // text copying elsewhere is untouched (and this whole handler is edit-mode only).
      if (meta && (e.key === "d" || e.key === "D")) { e.preventDefault(); S.duplicateSelection(); return; }
      if (meta && (e.key === "c" || e.key === "C")) {
        if (!S.selection.length) return;
        e.preventDefault();
        S.copySelection();
        return;
      }
      if (meta && (e.key === "v" || e.key === "V")) { e.preventDefault(); S.pasteClipboard(); return; }
      // Tool switches. Space-hold is the standard temporary-Hand convention; preventDefault
      // stops the canvas container from page-scrolling while it is held.
      if (!meta && e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) S.setSpaceHeld(true);
        return;
      }
      if (!meta && (e.key === "v" || e.key === "V")) { S.setTool("select"); return; }
      if (!meta && (e.key === "h" || e.key === "H")) { S.setTool("hand"); return; }
      if (e.key === "Escape") { S.escapeStep(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && S.selection.length) { e.preventDefault(); S.deleteEls(S.selection); return; }
      if (e.key === "]") { e.preventDefault(); S.orderCmd(meta ? "front" : "forward"); return; }
      if (e.key === "[") { e.preventDefault(); S.orderCmd(meta ? "back" : "backward"); return; }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") && S.selection.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        // In crop mode the arrows pan the picture; element moves are off there.
        if (S.croppingId) S.cropNudge(dx, dy); else S.nudge(dx, dy);
      }
    };
    // Space release / focus loss must always clear the temporary Hand, input guard or not.
    const onKeyUp = (e) => { if (e.code === "Space") stateRef.current.setSpaceHeld(false); };
    const onBlur = () => stateRef.current.setSpaceHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Leaving edit mode with Space held would otherwise strand the temporary Hand.
      stateRef.current.setSpaceHeld(false);
    };
  }, [editMode]);

  // ── Element rendering ─────────────────────────────────────────────────────
  const renderElement = (el) => {
    const dr = draft && draft.rects && draft.rects[el.id];
    const x = dr ? dr.x : el.x, y = dr ? dr.y : el.y, w = dr ? dr.w : el.w;
    const h = el.h === "auto" ? undefined : (dr ? dr.h : el.h);
    const editingThis = editingTextId === el.id;
    const content =
      el.type === "text" ? (
        <TextContent key={editingThis ? "edit" : "view"} el={el} editing={editingThis}
          surface={editMode ? "canvas" : "read"}
          // The DRAFT rect, so autofit tracks a resize handle live (`undefined` for an auto box).
          boxW={w} boxH={h} reportFit={editMode ? reportFit : undefined}
          // `textCommitChanged` normalizes the placeholder case — see it for why absent and "" are
          // the same edit.
          onCommit={(t) => { setEditingTextId(null); if (textCommitChanged(el, t)) patchEl(el.id, { text: t }); }}
          onCancel={() => setEditingTextId(null)} />
      ) : el.type === "image" ? <ImageContent el={el} imageMap={imageMap} crop={cropOf(el)} />
      : el.type === "shape" ? <ShapeContent el={el} />
      : el.type === "line" ? <LineContent el={el} w={w} h={h} />
      // Only the ACTIVE slide's elements reach here, so only its charts mount and a non-active
      // slide issues no query. Navigating away and back therefore re-runs the SQL. Kicking every
      // slide's query off in the background on load (and allowing navigation during the load) is
      // a PRESENT-MODE requirement and belongs with that task — deliberately not built here.
      : isLiveSQL(el) ? <ChartBlock el={el} reportCols={reportCols} />
      : el.type === "table" ? (
        <TableContent el={el} editing={editingThis}
          activeCell={activeCell && activeCell.id === el.id ? activeCell : null}
          onPickCell={(r, c) => setActiveCell({ id: el.id, r, c })}
          onEnterCell={(r, c) => { setEditingTextId(el.id); setActiveCell({ id: el.id, r, c }); }}
          onCommitCell={(r, c, text) => commitCell(el.id, r, c, { t: text })}
          onNav={(dir) => navCell(el, dir)}
          onColDrag={(event, index) => onTableColDrag(event, el, index)} />
      )
      : null;
    const shield = (isLiveSQL(el) || el.type === "image") && editMode;
    return (
      <div key={el.id} data-elid={el.id}
        ref={(n) => { if (n) nodeRefs.current[el.id] = n; else delete nodeRefs.current[el.id]; }}
        onPointerDown={editMode ? (e) => onElPointerDown(e, el) : undefined}
        onDoubleClick={editMode && !editingThis && !handActive ? (e) => onElDoubleClick(e, el) : undefined}
        onMouseEnter={editMode ? () => setHoverId(clickTarget(el.id, false).id) : undefined}
        onMouseLeave={editMode ? () => { const t = clickTarget(el.id, false).id; setHoverId((hid) => (hid === t ? null : hid)); } : undefined}
        style={{
          position: "absolute", left: x, top: y, width: w, height: h,
          // An auto-height text box with nothing in it has no height at all: a floor keeps it
          // clickable (and its selection ring visible) without inventing an `h` for the bag. See
          // AUTO_TEXT_MIN_H — this is the fix for the collapse the ghost condition used to cover.
          minHeight: el.type === "text" && el.h === "auto" ? AUTO_TEXT_MIN_H : undefined,
          opacity: el.opacity != null ? el.opacity : 1,
          cursor: editMode
            ? (handActive ? (panning ? "grabbing" : "grab")
              : croppingId === el.id ? (cropDraft && cropDraft.id === el.id ? "grabbing" : "grab")
              : editingThis ? "text" : "move")
            : undefined,
          userSelect: editMode && !editingThis ? "none" : undefined,
          touchAction: editMode ? "none" : undefined,
        }}>
        {shield ? <div style={{ width: "100%", height: "100%", pointerEvents: "none" }}>{content}</div> : content}
      </div>
    );
  };

  // The page sheet paints the ACTIVE slide's background when it sets one, falling back to
  // page.background (which is also the surround, so a deck that sets no per-slide colour looks
  // exactly like the v1 boundary-free surface).
  //
  // A slide marked hidden DIMS while editing — the one piece of feedback that the flag did
  // something, next to the nav's glyph. Edit mode only: dimming the published view would be
  // present mode half-built, and present mode (the flag's real consumer) is a later task.
  const pageInner = (
    <div ref={pageRef} data-slide={activeSlideId || undefined}
      data-slide-hidden-page={editMode && slideHidden ? "1" : undefined} style={{
      width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: "top left",
      // Never clipped: the edit canvas is unbounded, so elements dragged past the page edge
      // (or to negative coordinates) must still paint. The published view already did this.
      position: "relative", background: slideBackground, fontFamily: T.font, overflow: "visible",
      opacity: editMode && slideHidden ? 0.45 : undefined,
    }}>
      {slideLeaves.map(renderElement)}
      {/* Build steps are FULLY VISIBLE in the editor — renderElement never consults `build` — so the
          badges are the only thing that says a slide has steps at all. Deck only: a v1 scene cannot
          carry the key. */}
      {editMode && isDeck ? <BuildBadges leaves={slideLeaves} steps={slideSteps} rectOf={(id) => rectOf(id, draft && draft.rects)} /> : null}
      {editMode ? (
        <SelectionOverlay selection={selRoots} hoverId={hoverId} elements={all} marquee={marquee}
          rectOf={(id) => rectOf(id, draft && draft.rects)} croppingId={croppingId}
          editingTextId={editingTextId} onHandlePointerDown={onHandlePointerDown} />
      ) : null}
      {editMode && draft && draft.guides ? <SnapGuides guides={draft.guides} page={page} /> : null}
    </div>
  );

  // Zoom presets. fitScale is fit-to-WIDTH of the PAGE (unchanged — 100% still reads as
  // "page fills the width"), but the FITS frame the USED bounds: the union of the leaf
  // rects, falling back to the page rect on an empty scene. Each fit then scrolls those
  // bounds to the centre of the viewport, whether the zoom grew or shrank.
  const presetZoom = useCallback((kind) => {
    const node = canvasRef.current;
    if (!node || !fitScale) return;
    if (kind === "100") { zoomTo(roundZoom(1 / fitScale)); return; }
    const padH = editMode ? 56 : 0; // canvas region padding: 28px each side
    const padV = editMode ? 80 : 0; // ...and 40px top/bottom
    const availW = Math.max(80, node.clientWidth - padH);
    const availH = Math.max(80, node.clientHeight - padV);
    const u = usedBounds() || { x: 0, y: 0, w: page.width, h: page.height };
    const zW = (availW / u.w) / fitScale;
    const zH = (availH / u.h) / fitScale;
    const target = roundZoom(kind === "w" ? zW : kind === "h" ? zH : Math.min(zW, zH));
    pendingCenter.current = u;
    zoomTo(target);
    // When the zoom is already at the target nothing re-renders, so the layout effect never
    // fires — this rAF is the fallback that still performs the centring scroll.
    requestAnimationFrame(() => {
      const c = pendingCenter.current;
      if (!c) return;
      pendingCenter.current = null;
      centerOn(c);
    });
  }, [fitScale, editMode, page.width, page.height, usedBounds, zoomTo, centerOn]);

  const cluster = (
    <ViewportCluster editMode={editMode} inspectorWidth={panelsShown.right ? panelWidths.right : 0} zoom={zoom} scrollZoom={scrollZoom}
      bottomInset={editMode && isDeck ? (notesOpen ? NOTES_STRIP_H : NOTES_HEADER_H) : 0}
      onToggleScrollZoom={() => setScrollZoom((v) => !v)}
      onZoomIn={() => zoomTo(roundZoom(zoomRef.current * ZOOM_STEP))}
      onZoomOut={() => zoomTo(roundZoom(zoomRef.current / ZOOM_STEP))}
      onSetZoomPct={(pct) => zoomTo(roundZoom(pct / 100))}
      onPreset={presetZoom} />
  );

  // ── Present mode ──────────────────────────────────────────────────────────
  // ONE way in, and it is the top bar's Present button: it carries the slide cursor and a live
  // gesture. Leaving editMode is what makes PresentShell mount. There is no `fromCurrent` argument
  // any more — the only OTHER caller was the reading view's Present pill, which asked for a cold
  // open, and a cold open is now just the initial `entry: null` a published URL mounts with.
  //
  // "PRESENT FROM THIS SLIDE" ON A HIDDEN SLIDE IS ALLOWED — decided, not overlooked. An author who
  // asks to present the slide they are editing has said which slide they mean, and `hidden` says
  // only "skip this one when WALKING the deck"; refusing would mean an author cannot preview the
  // slide they are working on without first unhiding it. The two visible consequences are honest and
  // bounded: the counter reads "– / n" because the slide is not one of the presentable ones, and once
  // a key walks off it there is no way back to it (the walk cannot land on it). It is not a dead end
  // either way — every navigation key reaches a presentable slide, and Esc now seats the reading view
  // on the first presentable slide rather than on whatever was under the cursor.
  const openPresent = useCallback(() => {
    setPresent({ entry: activeSlideIndex, gesture: true });
    setEditMode(false);
    setSelection([]);
    setEditingTextId(null);
  }, [activeSlideIndex, setEditMode, setSelection]);
  // Esc, and the Exit Presentation control, land in the EDITOR — on the slide that was on screen.
  // PresentShell reports it, and only falls back to the first presentable slide when it cannot (an
  // empty deck, or a cursor the deck lost mid-presentation). This is the answer to the defect the
  // reading view was built for: the old exit seated a fixed `slides[0]` that could be hidden, in a
  // surface that could reach no other slide. Handing the cursor back to a surface that can reach
  // every slide costs one argument instead of a third mode.
  const exitPresent = useCallback((atSlideId) => {
    setPresent({ entry: null, gesture: false });
    setEditMode(true);
    if (!isDeck) return;
    if (atSlideId && slides.some((slide) => slide.id === atSlideId)) { setWantedSlideId(atSlideId); return; }
    const at = presentEdgeSlide(slides, 1);
    if (at !== PRESENT_NONE) setWantedSlideId(slides[at].id);
  }, [isDeck, slides, setEditMode]);

  // A DECK NOT IN EDIT MODE IS A PRESENTATION. There is deliberately no second "is it on" flag in
  // this condition: the two facts were always set together, and keeping both created a fourth state
  // (not editing and not presenting) that the reading view used to occupy and nothing occupies now.
  if (!editMode && isDeck) {
    return (
      <PresentShell slides={slides} elements={merged.elements} leavesBySlide={leavesBySlide}
        page={page} imageMap={imageMap} entryIndex={present.entry}
        autoFullscreen={present.gesture} onExit={exitPresent} />
    );
  }

  // ── V1 published view (a NON-deck scene's page) ───────────────────────────
  // This branch is now reachable only for a v1 scene: the deck's reading view — the third surface —
  // is gone, and the branch above returns present mode for every deck. What is left is the ORIGINAL
  // scroll page, unchanged: the page rect as its own surface, `page.background` as the surround with
  // no hairline and no shadow, drag-to-pan, the zoom cluster, and the floating Edit toggle.
  //
  // The Edit toggle stays HERE and only here. It was removed from the deck, which no longer has an
  // "editing off" state to toggle — but a v1 scene still has two surfaces and this pill is its only
  // door in either direction, so deleting it would leave a v1 scene rendered by this template
  // uneditable. That is a regression in a path this task does not touch, so: kept, and gated.
  //
  // The surround has no edge deliberately. The edge answers an EDITING question (is this element on
  // the slide, or parked in the bleed?) and only edit mode can act on the answer. Giving this view a
  // hairline is also not one line — the hairline is light because it contrasts with the ONE fixed
  // surround colour, so it would need this view's surround changed to T.slideSurround too, and that
  // repaints the published page of every v1 dive. Accepted, documented, and pinned by a test.
  if (!editMode) {
    return (
      <>
        <div ref={canvasRef} onPointerDown={startPan}
          style={{
            width: "100%", height: "100vh", position: "relative",
            overflowY: "auto",
            // At fit width the scaled page can overflow horizontally by a sub-pixel and Chrome
            // then reserves an inert horizontal bar, costing height — so horizontal scrolling is
            // off unless there is a real zoom past fit width to reach.
            overflowX: zoom > 1 ? "auto" : "hidden",
            background: page.background, cursor: panning ? "grabbing" : "grab",
          }}>
          <div style={{ width: page.width * scale, height: page.height * scale, margin: "0 auto", position: "relative" }}>
            {pageInner}
          </div>
        </div>
        <EditToggle on={false} onChange={() => setEditMode(true)} />
        {cluster}
      </>
    );
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: T.canvasBg }}>
      <style>{SCROLLBAR_CSS}</style>
      {/* A DECK has no floating Edit toggle any more: there is no third surface to toggle to, and the
          way out is Present. A v1 scene keeps it — see the branch above — and only then does the top
          bar need the 136px gutter that used to sit under it. */}
      {isDeck ? null : (
        <EditToggle on={true} onChange={() => { setEditMode(false); setSelection([]); setEnteredGroupId(null); setEditingTextId(null); }} />
      )}
      <TopBar
        onAdd={addElement} addDisabled={!!noSlideRefusal} onUndo={undo} onRedo={redo}
        canUndo={undoStack.current.length > 0} canRedo={redoStack.current.length > 0}
        bytes={ovRaw == null ? 0 : byteLen(ov)} onSave={requestSave} saveCount={saveCount} saveBusy={saveBusy}
        onCopy={copyOverrides} onReset={resetAll}
        stale={merged.stale} onClearStale={resetAll}
        onPresent={isDeck ? openPresent : null}
        tool={tool} onToolChange={setTool}
        panelsShown={panelsShown} onTogglePanel={togglePanel} isDeck={isDeck}
        inspectorHolds={inspectorHiddenHolds(selection.length > 0, !!slideUI)}
        layersHolds={layersHiddenHolds(isDeck)} insetLeft={isDeck ? 12 : 136} />
      {/* Below the feasibility boundary — every shown panel at its minimum plus the canvas floor,
          which is 72+180+180+240 = 672 with all three up, and 432 of panels alone — the canvas has
          nothing left to give and the panels spill past the viewport. The root is `position: fixed`,
          so that used to mean UNREACHABLE: at row 320 the last 112px of the inspector was simply off
          screen with nothing to scroll. The row scrolls horizontally now, so a very narrow window
          (or a narrow embed) costs panning rather than access. `overflowY: hidden` keeps that from
          becoming a second vertical scrollbar over the panels' own. `clientWidth` still measures the
          VISIBLE row, which is what the budget wants: it is the space there is, not the space the
          content took. */}
      <div ref={paneRowRef} style={{ flex: 1, display: "flex", minHeight: 0, overflowX: "auto", overflowY: "hidden" }}>
        {/* The rail is the deck's navigator, and it is now INSIDE the width budget with the other two
            panels (clampPanelWidths) rather than a fixed column subtracted off the top of it. It is
            also NOT RENDERED when hidden — not collapsed to zero width, not display:none — so a
            hidden rail mounts no rows, measures no viewport, and renders no thumbnails at all.
            `ops` is a fresh object per render on purpose — Filmstrip funnels it through a ref so the
            row memo does not see it. */}
        {isDeck && panelsShown.rail ? (
          <Filmstrip width={panelWidths.rail} slides={slides} activeSlideId={activeSlideId} activeIndex={activeSlideIndex}
            leavesBySlide={leavesBySlide} page={page} imageMap={imageMap}
            renamingSlideId={renamingSlideId}
            ops={{
              activate: (id) => activateSlide(id),
              newAfter: (id, layout) => newSlide(id, layout),
              duplicate: (id) => duplicateSlide(id),
              remove: (id) => deleteSlide(id),
              toggleHidden: (id) => toggleSlideHidden(id),
              move: (toIndex, id) => moveSlide(toIndex, id),
              startRename: (id) => setRenamingSlideId(id),
              endRename: (id, value) => {
                setRenamingSlideId(null);
                const slide = slideById(id);
                const next = String(value == null ? "" : value).trim();
                // An empty field clears the name back to unnamed; buildSlidePatched prunes a patch
                // that says nothing, so a rename to the same text writes zero bytes.
                if (slide && next !== (slide.name || "")) renameSlide(next || null, id);
              },
            }} />
        ) : null}
        {/* The rail's own handle, the SAME idiom the two panes use — drag to resize, double-click to
            reset to the width it shipped at. It lives with the rail, so hiding the rail takes its
            handle with it and there is never a separator with nothing on either side of it. */}
        {isDeck && panelsShown.rail ? (
          <PaneResizeHandle side="left" label="Slides" width={panelWidths.rail}
            min={FILM_MIN_WIDTH} max={FILM_MAX_WIDTH}
            onResize={(width) => applyPanelWidth("rail", width)}
            onReset={() => applyPanelWidth("rail", FILM_DEFAULT_WIDTH)} />
        ) : null}
        {panelsShown.left ? (
          <>
            <TreePanel width={panelWidths.left} elements={all} zOf={zOf} posOf={posOf} selection={selection} hoverId={hoverId} setHoverId={setHoverId}
              onSelect={selectFromTree} onSelectMany={selectManyFromTree} renamingId={renamingId} setRenamingId={setRenamingId}
              onRename={(id, name) => patchEl(id, { name })} onDrop={onTreeDrop} build={buildUI} />
            <PaneResizeHandle side="left" label="Layers" width={panelWidths.left}
              onResize={(width) => applyPanelWidth("left", width)}
              onReset={() => applyPanelWidth("left", LEFT_PANE_DEFAULT)} />
          </>
        ) : null}
        {/* The canvas COLUMN: the scroll region, then the notes strip beneath it. The wrapper takes
            the horizontal flex slot the canvas used to hold, so the panel-width budget (which
            measures the row and subtracts the three panels' widths) is unchanged; the strip only ever
            costs canvas HEIGHT, which the fit-height preset then honours. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={canvasRef}
          onPointerDown={handActive ? startPan : onCanvasPointerDown}
          className="ed-scroll"
          style={{
            flex: 1, overflow: "auto", position: "relative", padding: "40px 28px", minWidth: 0, minHeight: 0,
            // A slide has an EDGE, so the surround is a neutral of its own (slideSurround) rather
            // than the page colour, and the sheet is lifted off it by T.slideEdge. The Figma fork made
            // the surround `page.background` with no shadow on purpose — one boundary-free plane
            // that reads as infinite — which is right for a freeform canvas and wrong here: an
            // author otherwise cannot tell whether an element at y:680 is on the slide or in the
            // bleed, and on a white deck the sheet and the surround were literally the same white.
            // The plane is unchanged: still sized from the used bounds, still never clipping, and
            // off-slide elements still paint (over the shadow, as in Slides) and stay selectable
            // and scrollable-to. The edge marks where the slide ends; it is not a clip. Present mode
            // keeps its own surface (it letterboxes), and a v1 scene's published page keeps its own.
            //
            // The surround is a MID neutral, not the near-black it shipped as: see T.slideSurround.
            // A near-black surround made the edge legible and made the BLEED invisible — default
            // ink #231f20 against #141416 is 1.13:1, so an element dragged off the sheet vanished
            // instead of being parked, which is the opposite of the promise this edge makes.
            background: T.slideSurround,
            cursor: handActive ? (panning ? "grabbing" : "grab") : undefined,
          }}>
          {/* The plane: sized from the used bounds ∪ the page rect + PLANE_MARGIN, so anything
              parked off-page can be scrolled to. Narrower than the viewport, it centres. */}
          <div style={{
            width: plane.w * scale, height: plane.h * scale, margin: "0 auto", position: "relative",
          }}>
            {/* Carries the edge rather than `pageInner`, for two reasons: this box is edit-mode
                only (pageInner is shared with the v1 published page) and it is UNSCALED, so the
                hairline stays exactly 1px at every zoom. A box-shadow paints beneath its own subtree, so
                elements parked off-slide still draw on top of it. */}
            <div data-slide-sheet="1" style={{
              position: "absolute", left: plane.ox * scale, top: plane.oy * scale,
              width: page.width * scale, height: page.height * scale,
              boxShadow: T.slideEdge,
            }}>
              {/* Names what the dimming means. Outside the dimmed sheet so the label itself stays
                  legible, and inert — it is a caption, not a control. */}
              {slideHidden ? (
                <div data-slide-hidden-badge="1" title="Marked hidden. Present mode will skip it; nothing skips it yet."
                  style={{
                    position: "absolute", left: 0, top: -22, pointerEvents: "none",
                    fontSize: 11, fontFamily: T.font, color: "#e8a13c", letterSpacing: 0.2,
                  }}>Hidden slide</div>
              ) : null}
              {pageInner}
            </div>
          </div>
        </div>
        {isDeck ? (
          <NotesStrip open={notesOpen} onToggle={() => setNotesOpen((v) => !v)}
            notes={activeSlide ? activeSlide.notes : ""}
            disabled={!activeSlide || !!merged.stale}
            disabledHint={!activeSlide ? "No slide" : SLIDE_STALE}
            slideLabel={activeSlide ? (activeSlide.name || "Slide " + (activeSlideIndex + 1)) : ""}
            // Coalesced per slide, so a typed paragraph is ONE undo step rather than one per
            // keystroke — the same treatment the slide rename and the opacity slider get.
            onCommit={(v) => patchSlide({ notes: v || null }, { coalesce: true, kind: "snotes:" + activeSlideId })} />
        ) : null}
        </div>
        {/* HIDING THE INSPECTOR DOES NOT DROP THE SELECTION, AND A SELECTION DOES NOT RE-OPEN IT.
            The inspector holds the only editors for some things — the SQL editor, the Slide section,
            crop, the column picker — so hiding it while a chart is selected genuinely puts those out
            of reach. Auto-revealing was rejected: the author asked for the width, and a panel that
            springs back on the next click is a panel you cannot keep closed. Instead the toggle in
            the top bar carries an accent dot, AND says so in its own accessible name, whenever the
            hidden panel is the only place something can be reached from — see inspectorHiddenHolds,
            which is why the signal also fires with NOTHING selected: that is when the inspector shows
            the Slide section, and per-slide Background exists nowhere else in the editor. So the
            state is signposted rather than silently lossy, and one click resolves it. Everything the
            CANVAS can do — move, resize, reorder, delete, group, align by keyboard, edit text in
            place, undo — is unaffected.
            THE LAYERS TOGGLE now carries the same signal for the same reason (layersHiddenHolds):
            the build order moved into that panel, and there is no second way to reach it. */}
        {panelsShown.right ? (
          <>
            <PaneResizeHandle side="right" label="Inspector" width={panelWidths.right}
              onResize={(width) => applyPanelWidth("right", width)}
              onReset={() => applyPanelWidth("right", RIGHT_PANE_DEFAULT)} />
            <Inspector width={panelWidths.right} selection={selRoots} elements={all} patch={patchEl} patchChart={patchChart}
              onDelete={deleteEls} orderCmd={orderCmd} imageKeys={imageKeys} chartCols={chartCols} getH={getH} fitIdx={fitIdx}
              onGroup={groupSelection} onUngroup={ungroupSelection} childCount={(id) => kidsOf(id).length}
              onDuplicate={duplicateSelection} onAlign={alignSelection} onDistribute={distributeSelection} crop={cropUI}
              table={tableUI} slide={slideUI} />
          </>
        ) : null}
      </div>
      {cluster}
      {toast ? <Toast text={toast} /> : null}
      {saveUI ? (
        <SaveDialog phase={saveUI.phase} count={saveUI.count || saveCount} summary={saveUI.summary}
          runStatus={saveRun.status} message={saveUI.message}
          onConfirm={confirmSave} onCancel={() => setSaveUI(null)}
          onReload={() => window.location.reload()} />
      ) : null}
      {copyModal ? <CopyModal text={copyModal} onClose={() => setCopyModal(null)} /> : null}
    </div>
  );
}

// Unit-test seam. The framework's PURE helpers, re-exported so `tests/unit/run.mjs` can
// assert on them without a DOM or React. Dead weight in production (a named export a dive
// never imports); nothing in the framework reads it. Keep it last and keep it small.
export const __TESTABLES__ = {
  normOv, applyElPatch, sanitizeParents, finalizeScene, mergeScene,
  isDeckScene, normSlideOv, slidesOf, slidesOfStrict, permanentizeSlideIds,
  valEq, prunePatch, validateBakeInput, permanentizeAddedIds, removeEmptyGroups,
  renumberLeafZ, bakeScene, mapRequiredResources,
  pendingEditCount, checkFlightSave, flightSaveFailure,
  elementsOfSlide, resolveActiveSlideId, stampSlide, leavesBeforeSlide, mintRefusal,
  opBag, undoEntry, reservedIds, idReserver,
  allowedBagKeys, bagNamedIds, reservedNamespaceIds, EDITABLE_DIVE_BAG_KEYS,
  EDITABLE_DIVE_V1_TYPES, EDITABLE_DIVE_DECK_ONLY_TYPES, EDITABLE_DIVE_FORBIDDEN_KEYS,
  buildPatched, zEntries, deleteCascade, buildDeleted,
  buildInserted, buildAdded,
  fitMapPatch, isTypingTarget, PRESENT_NONE, PRESENT_MOUNT_RADIUS, PRESENT_PREFETCH_MAX,
  PRESENT_FADE_MS, PRESENT_FADE_GRACE_MS, PRESENT_INFLIGHT_MAX,
  presentVisible, nextVisibleSlide, presentEdgeSlide, presentEntrySlide, presentCounter,
  letterbox, presentMountWindow, presentPrefetchSql, presentAdmit,
  BUILD_NONE, BUILD_NAV, BUILD_BADGE, PRESENT_NO_FADE,
  normBuild, buildStepsOf, buildStepsBySlide, buildStepsFor, buildCutoff, buildShown,
  buildNext, buildSeat, presentReveal, presentSeat, presentStep, presentJump,
  presentArrowDead, presentLayerCut, buildRevealMs,
  buildOrdinal, buildSelectionStep, buildRowState,
  buildStepRows, buildOrderOf, buildOrderAdd, buildOrderRemove, buildOrderMove, buildWritePlan,
  buildStepLabel, buildAddOrdinal, buildMarkTargets, buildMarkText, buildMarkKey, buildStepKey, BUILD_KEY_PASS,
  BUILD_ROW_NONE, BUILD_ROW_MIXED, BUILD_ROW_EMPTY,
  buildBadgeBox, EDITABLE_DIVE_MAX_BUILD, EDITABLE_DIVE_DECK_ONLY_COMMON_KEYS, EDITABLE_DIVE_LEAF_ONLY_KEYS,
  slideAddRefusal, slideDeleteRefusal, slideStaleRefusal, slideIdsOf, naturalSlideOrder, withSlideOrder,
  orderWithInsert, slideOfEl, slideFieldEq, slideTrees, slideZOffset,
  listKindOf, textTagOf, textFontSize, listDepthOf, listAlpha, listRoman, listMarker, listItems,
  indentText, LIST_MAX_DEPTH, LIST_INDENT_EM, LIST_MARKER_EM, LIST_BULLETS, LIST_TAB_SIZE,
  AUTOFIT_LADDER, AUTOFIT_GEN_KEYS, autofitOn, autofitScale, autofitPercent, autofitGen,
  autofitPick, autofitReadout,
  ghostTextOf, ghostVisible, GHOST_SURFACES, AUTO_TEXT_MIN_H, tapTarget, gestureIsTap,
  textCommitChanged, slideBackgroundWrite,
  SLIDE_LAYOUTS, slideLayout, slideLayoutElements, slideLayoutRecord,
  NOTES_STRIP_H, NOTES_HEADER_H, ROW_LABEL_W, SLIDE_LABEL_W,
  buildNewSlide, buildDuplicatedSlide, buildDeletedSlide, buildSlidePatched, buildReorderedSlides,
  rootDeltaEntries, alignEntries, distributeEntries,
  groupBlockOrder, resizeRect, snapCandidates, snapAxis, snapRect,
  normCrop, roundCrop, clamp01, clampZoom, roundZoom,
  PANEL_LIMITS, PANEL_SHRINK_ORDER, PANEL_KEYS, PANEL_SHOWN_DEFAULT,
  panelWidthNumber, clampPanelWidth, clampPanelDrag, panelDragRequest, clampPanelWidths,
  panelBudgetFeasible, panelRowWidth, inspectorHiddenHolds, layersHiddenHolds,
  togglePanelShown, panelsShownFor,
  PANE_MIN_WIDTH, PANE_MAX_WIDTH, CANVAS_MIN_WIDTH, LEFT_PANE_DEFAULT, RIGHT_PANE_DEFAULT,
  FILM_MIN_WIDTH, FILM_MAX_WIDTH, FILM_DEFAULT_WIDTH,
  FILM_PAD_X, FILM_NUM_W, FILM_NUM_GAP, FILM_CAPTION_H, FILM_ROW_GAP,
  filmThumbBox, filmRowHeight, filmWindow, filmSlotAt, filmDropIndex, groupLeavesBySlide,
  FILM_NO_DROP, filmDragTarget, filmAutoscrollDelta, filmDragEnd, filmDragStale, filmDeckSig,
  resolveTextStyle, textStyleOf, highlightBox, baselineDyOf, parentOf, N, numOrNull, byteLen,
  tokenizeSQL, sqlTokenLines, sqlGutterCells,
  normTable, tableWithRow, tableWithCol, tableWithCell, tableCellText, tableTrack, tableCommitValue,
  normTableBorder, isLiveSQL, isNumericCell, numericColsOf,
  sqlTableAlign, sqlTableLimit, sqlTableColumns, sqlTableRows, sqlTableCaption, sqlTableCellText,
  sqlTableResultColumns, sqlTableRowCapacity, sqlTableColCapacity, sqlTableThumbBands, sqlTablePruneColumns,
  sqlTableLine, sqlTableTitleH, sqlTableBoxH, sqlTableBoxW,
  SQLTABLE_LINE_H, SQLTABLE_CAPTION_H, SQLTABLE_CAPTION_FS, SQLTABLE_MIN_COL_W,
  SQLTABLE_CELL_PAD_X, SQLTABLE_CELL_PAD_Y, SQLTABLE_TITLE_LINE_H, SQLTABLE_TITLE_GAP,
  sqlTableTextStyle, newSqlTableElement, liveTitleStyle,
  sqlTableHeaderOn, sqlTableStriped, sqlTableRowFill, sqlTableCell, sqlTableThumbBand,
  SQLTABLE_DEFAULT_SQL, SQLTABLE_DEFAULT_LIMIT, SQLTABLE_ROW_H, SQLTABLE_FORMAT_OPTS,
  SQLTABLE_ALIGN_OPTS, SQLTABLE_TEXT_DEFAULTS, SQLTABLE_TEXT_TARGETS,
  SQLTABLE_HEADER_FILL, SQLTABLE_ZEBRA_FILL, TABLE_DEFAULTS,
  FMT,
  EDITABLE_DIVE_TYPES, EDITABLE_DIVE_TYPE_KEYS, EDITABLE_DIVE_MAX_TABLE_ROWS, EDITABLE_DIVE_MAX_TABLE_COLS,
  patchKeyAllowlistFingerprint,
  columnOptionsWithMissing, missingChartColumns,
  insertRect, newChartElement, CHART_DEFAULT_SQL, CHART_DEFAULT_W, CHART_DEFAULT_H,
  // The design tokens and the one stylesheet the slide edge is measured against: the edge's
  // thresholds are CONTRAST ratios, so the test computes them off the real values.
  T, SCROLLBAR_CSS,
};
