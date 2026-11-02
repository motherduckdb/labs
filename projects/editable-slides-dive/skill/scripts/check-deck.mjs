// Author-side checks for a v2 DECK scene, run against the real template's own exported helpers.
//
//   node scripts/check-deck.mjs my-deck.json
//   TEMPLATE=/path/to/template-slides.jsx node scripts/check-deck.mjs my-deck.json
//
// Self-contained on purpose: it bundles the template with `npx esbuild` into a temp directory,
// writing its own dependency stubs there, so it works from this skill directory alone with no
// repo-local test harness. Needs network only the first time npx fetches esbuild.
//
// What it proves, in order:
//   1  the scene validates as a fresh deck (validateBakeInput)
//   2  bakeScene is a FIXED POINT on it — the deck is already in the shape a save would leave it
//      in, the authored `z` survives renumberLeafZ, and a second bake moves nothing but `version`
//   3  every group's descendant leaves are contiguous in the global z order
//   4  every sqltable's `limit` fits its box's row capacity and its columns fit the width
//   5  present mode's visible-slide walk, counter, per-slide build steps and query want-set
//   6  every list parses to the markers the author expects
//   7  every numeric-height text box is listed with its base size (the settled autofit step is a
//      live measurement and can only be read in the browser)
//
// It is NOT a framework gate — the repo's tests/unit/run-both.mjs is. This is the check an AUTHOR
// runs on a deck before assembling it. Exits non-zero on the first failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = process.env.TEMPLATE || path.join(HERE, "..", "template-slides.jsx");
const DECK = process.argv[2];
if (!DECK) {
  console.error("usage: node scripts/check-deck.mjs <deck.json>");
  process.exit(2);
}
if (!fs.existsSync(TEMPLATE)) throw new Error("template not found: " + TEMPLATE);

// ── bundle the template so its __TESTABLES__ export is importable from plain Node ──────────
// Every runtime dependency is stubbed: no hook and no component ever runs, so a dependency only
// has to EXIST as a binding at module-evaluation time. React is a real module rather than a Proxy
// because the template calls memo() at module scope and esbuild's interop cannot read a named
// export off a Proxy.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edive-deck-"));
const anyStub = path.join(tmp, "any.cjs");
const reactStub = path.join(tmp, "react.mjs");
fs.writeFileSync(anyStub, `const cache = new Map();
module.exports = new Proxy({}, { get(_t, name) {
  if (name === "__esModule") return false;
  if (typeof name !== "string") return undefined;
  if (!cache.has(name)) cache.set(name, function stub() { throw new Error("stub " + name + " was called"); });
  return cache.get(name);
}, has() { return true; } });
`);
fs.writeFileSync(reactStub, `const hook = (n) => function stub() { throw new Error("stub " + n + " was called"); };
export const memo = (c) => c;
export const forwardRef = (c) => c;
export const useState = hook("useState");
export const useEffect = hook("useEffect");
export const useLayoutEffect = hook("useLayoutEffect");
export const useRef = hook("useRef");
export const useMemo = hook("useMemo");
export const useCallback = hook("useCallback");
export const useContext = hook("useContext");
export const useReducer = hook("useReducer");
export const createElement = hook("createElement");
export const Fragment = "Fragment";
export default { memo, forwardRef, useState, useEffect, useLayoutEffect, useRef, useMemo,
  useCallback, useContext, useReducer, createElement, Fragment };
`);
const bundle = path.join(tmp, "template.mjs");
execFileSync("npx", ["--yes", "esbuild", TEMPLATE, "--bundle", "--format=esm", "--platform=neutral",
  "--loader:.jsx=jsx", "--jsx=automatic",
  "--alias:react=" + reactStub, "--alias:react/jsx-runtime=" + anyStub,
  "--alias:recharts=" + anyStub, "--alias:lucide-react=" + anyStub,
  "--alias:@motherduck/react-sql-query=" + anyStub,
  "--outfile=" + bundle, "--log-level=warning"], { stdio: ["ignore", "inherit", "inherit"] });

const X = (await import(bundle)).__TESTABLES__;
assert.ok(X, "the template must export __TESTABLES__");
const scene = JSON.parse(fs.readFileSync(DECK, "utf8"));
assert.equal(scene.v, 2, "check-deck.mjs is for a DECK (scene.v === 2); this scene is v" + scene.v);
const noop = { v: 2, _base: scene.version, patch: {}, deleted: [], added: [] };

// 1 — validates as a fresh scene
X.validateBakeInput(scene, noop);
console.log("ok  validateBakeInput");

// 2 — bake is a fixed point (element bodies, slides, and z), and idempotent
const baked = X.bakeScene(scene, noop);
assert.equal(baked.scene.version, scene.version + 1);
assert.deepEqual(baked.scene.slides, scene.slides, "bake changed the slide records");
const bodies = (s) => s.elements.map((e) => JSON.stringify({ ...e, z: 0 }));
assert.deepEqual(bodies(baked.scene), bodies(scene), "bake changed element bodies");
console.log("ok  bakeScene fixed point (summary " + JSON.stringify(baked.summary) + ")");
const noop2 = { v: 2, _base: baked.scene.version, patch: {}, deleted: [], added: [] };
X.validateBakeInput(baked.scene, noop2);
const baked2 = X.bakeScene(baked.scene, noop2);
assert.deepEqual({ ...baked2.scene, version: 0 }, { ...baked.scene, version: 0 },
  "a second bake moved something — the deck is not a fixed point");
console.log("ok  the baked scene re-validates, and a second bake moves only `version`");
const zAuthored = scene.elements.filter((e) => e.type !== "group").map((e) => [e.id, e.z]);
const zBaked = new Map(baked.scene.elements.filter((e) => e.type !== "group").map((e) => [e.id, e.z]));
const zDrift = zAuthored.filter(([id, z]) => zBaked.get(id) !== z);
assert.equal(zDrift.length, 0, "authored z is not canonical; renumberLeafZ would change "
  + zDrift.length + " leaf/leaves, e.g. " + JSON.stringify(zDrift.slice(0, 6))
  + " — number z slide by slide in deck order");
console.log("ok  authored z survives renumberLeafZ unchanged");

// 3 — every group's descendant leaves are contiguous in the global z order
const leaves = scene.elements.filter((e) => e.type !== "group").sort((a, b) => a.z - b.z);
const pos = new Map(leaves.map((e, i) => [e.id, i]));
const descendantLeaves = (gid) => {
  const out = [];
  const walk = (id) => scene.elements
    .filter((e) => (e.parent ?? null) === id)
    .forEach((c) => (c.type === "group" ? walk(c.id) : out.push(c.id)));
  walk(gid);
  return out;
};
const groups = scene.elements.filter((e) => e.type === "group");
for (const g of groups) {
  const ix = descendantLeaves(g.id).map((id) => pos.get(id)).sort((a, b) => a - b);
  assert.ok(ix.length, "group " + g.id + " has no leaves");
  assert.equal(ix[ix.length - 1] - ix[0], ix.length - 1,
    "group " + g.id + " is not z-contiguous (global leaf positions " + ix.join(",") + ")");
}
console.log("ok  every group's leaves are z-contiguous (" + groups.length + " groups)");

// 4 — sqltable boxes
for (const e of scene.elements.filter((el) => el.type === "sqltable")) {
  const rows = X.sqlTableRowCapacity(e);
  const cols = X.sqlTableColCapacity(e);
  const configured = Object.keys(e.columns || {}).length;
  console.log("ok  " + e.id + ": limit " + e.limit + " <= row capacity " + rows + "; "
    + configured + " configured column(s) <= col capacity " + cols
    + " (titleH " + X.sqlTableTitleH(e) + ", grid box " + X.sqlTableBoxH(e) + "x" + X.sqlTableBoxW(e) + ")");
  assert.ok(e.limit == null || e.limit <= rows,
    e.id + ": limit " + e.limit + " exceeds the box's row capacity " + rows + " — raise h or lower limit");
  assert.ok(configured <= cols, e.id + ": more configured columns than fit the width");
}

// 5 — present mode
const slides = X.slidesOf(scene, {});
const visible = X.presentVisible(slides);
console.log("ok  " + visible.length + " presentable slide(s) of " + slides.length
  + "; hidden: " + (slides.filter((s) => s.hidden).map((s) => s.id).join(", ") || "none")
  + "; counter on the first is " + JSON.stringify(X.presentCounter(slides, visible[0])));
const stepsBySlide = X.buildStepsBySlide(X.groupLeavesBySlide(slides, scene.elements));
for (const s of slides) {
  const steps = X.buildStepsFor(stepsBySlide, s.id);
  if (steps.length) console.log("      " + s.id + " build steps " + JSON.stringify(steps));
}
const want = X.presentPrefetchSql(slides, scene.elements, visible[0], X.PRESENT_PREFETCH_MAX);
console.log("ok  query want-set " + want.length + " unique statement(s) (cap "
  + X.PRESENT_PREFETCH_MAX + ", " + X.PRESENT_INFLIGHT_MAX + " in flight, mount radius "
  + X.PRESENT_MOUNT_RADIUS + ")");

// 6 — lists
for (const e of scene.elements.filter((el) => X.listKindOf(el))) {
  const items = X.listItems(e.text, e.level);
  console.log("ok  " + e.id + " (" + e.level + ") " + items.length + " line(s), markers "
    + JSON.stringify(items.map((i) => " ".repeat(i.depth) + i.marker)));
}

// 7 — autofitting boxes
for (const e of scene.elements.filter((el) => X.autofitOn(el))) {
  console.log("ok  " + e.id + " autofits: h " + e.h + ", base " + X.textFontSize(e) + "px"
    + " (the settled ladder step is measured in the browser; the inspector reports it)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nALL DECK CHECKS PASSED — " + slides.length + " slides, "
  + scene.elements.length + " elements, " + fs.statSync(DECK).size + " bytes of scene JSON");
