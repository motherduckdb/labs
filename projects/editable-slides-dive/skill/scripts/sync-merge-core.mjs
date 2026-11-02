#!/usr/bin/env node

import { constants as fsConstants, accessSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(here);
const corePath = path.join(skillDir, "merge-core.mjs");
const BASE_TEMPLATE = path.join(skillDir, "template.jsx");
const SLIDES_TEMPLATE = path.join(skillDir, "template-slides.jsx");
const checkOnly = process.argv.includes("--check");

function between(source, start, end, label) {
  const first = source.indexOf(start);
  const second = source.indexOf(end);
  if (first < 0 || second < 0 || second <= first) throw new Error(`missing ${label} sentinels`);
  if (source.indexOf(start, first + start.length) >= 0 || source.indexOf(end, second + end.length) >= 0) {
    throw new Error(`duplicate ${label} sentinels`);
  }
  return { start: first, bodyStart: first + start.length, bodyEnd: second };
}

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

const core = readFileSync(corePath, "utf8");
// The fingerprint of THIS core, computed by the core itself and emitted as a LITERAL into every
// template (and so into every assembled dive). The Save service already publishes its own
// fingerprint on /api/health, which makes "the service is behind the dive" visible. The reverse —
// "the DIVE is behind the service" — had nothing at all, and it is the direction that leaves an
// author permanently unable to save: the launch path runs the dive's own INLINE core, so a bag aimed
// at a dive assembled before a new element type existed bakes and renders and then fails every later
// save from that dive's own Save button. Emitting the number here lets the service name which side
// is behind instead of only that they disagree.
const { patchKeyAllowlistFingerprint } = await import(pathToFileURL(corePath).href);
const fingerprint = patchKeyAllowlistFingerprint();
const inlineRegion = between(core, "// __INLINE_CORE_START__", "// __INLINE_CORE_END__", "inline core");
const inline = core
  .slice(inlineRegion.bodyStart, inlineRegion.bodyEnd)
  .trim()
  .replace(/^export\s+(?=(?:class|function|const)\b)/gm, "");

const generated = [
  "",
  "// Generated from merge-core.mjs. Run scripts/sync-merge-core.mjs; do not edit this region.",
  inline,
  "",
  "// The fingerprint of the core above, emitted so a consumer that has only this SOURCE can tell",
  "// which side of a version skew it is looking at. See scripts/sync-merge-core.mjs.",
  `const EDITABLE_DIVE_CORE_FINGERPRINT = ${JSON.stringify(fingerprint)};`,
  "",
].join("\n");

// template.jsx (the base template) is always required — a missing/typo'd path is a hard error
// in both write and --check mode. template-slides.jsx is a committed, permanently expected
// file, so --check requires it too (so "not yet forked" can't be confused with "accidentally
// deleted or renamed"); write mode still tolerates its absence, so the script keeps functioning
// if the fork is deliberately removed mid-refactor.
const templateSpecs = [
  { path: BASE_TEMPLATE, optional: false },
  { path: SLIDES_TEMPLATE, optional: !checkOnly },
];

// Phase 1 — read + validate every in-scope template and compute its full output buffer in
// memory. Nothing is written in this phase. Only once every template has succeeded does phase 2
// (below) write anything, so a problem with one template (duplicate sentinels, unreadable,
// unwritable) never leaves the tree half-synced with the others already rewritten.
const plan = [];
for (const { path: templatePath, optional } of templateSpecs) {
  if (!existsSync(templatePath)) {
    if (optional) {
      console.warn("skip (not found): " + templatePath);
      continue;
    }
    fail("template not found: " + templatePath);
  }

  let template;
  try {
    template = readFileSync(templatePath, "utf8");
  } catch (e) {
    fail("could not read " + templatePath + ": " + e.message);
  }

  let templateRegion;
  try {
    templateRegion = between(template, "// __MERGE_CORE_START__", "// __MERGE_CORE_END__", "template core");
  } catch (e) {
    fail(templatePath + ": " + e.message);
  }

  const next = template.slice(0, templateRegion.bodyStart) + generated + template.slice(templateRegion.bodyEnd);

  if (!checkOnly && next !== template) {
    try {
      accessSync(templatePath, fsConstants.W_OK);
    } catch (e) {
      fail("cannot write " + templatePath + ": " + e.message);
    }
  }

  plan.push({ path: templatePath, template, next });
}

if (checkOnly) {
  let drifted = false;
  for (const { path: templatePath, template, next } of plan) {
    if (next !== template) {
      console.error("merge core drift in " + templatePath + ": run editable-dive/scripts/sync-merge-core.mjs");
      drifted = true;
    }
  }
  if (drifted) process.exit(1);
  console.log("ok: template merge core matches merge-core.mjs");
} else {
  // Phase 2 — every template validated above; write the ones that actually changed.
  for (const { path: templatePath, template, next } of plan) {
    if (next !== template) {
      writeFileSync(templatePath, next, "utf8");
      console.log("updated " + templatePath);
    }
  }
}
