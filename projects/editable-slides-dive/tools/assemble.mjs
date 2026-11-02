// Assemble a deck Dive: copy template-slides.jsx verbatim and patch ONLY its three sentinel regions.
//   SHARE_PATH=md:_share/<db>/<uuid> SHARE_ALIAS=<db> node assemble.mjs <deck.json> <save-flight-id> [out=dive.jsx]
// SHARE_PATH/SHARE_ALIAS are the database the deck reads (images table, chart/sqltable SQL).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [scenePath, flightId, out = "dive.jsx"] = process.argv.slice(2);
const { SHARE_PATH, SHARE_ALIAS } = process.env;
const TEMPLATE = process.env.TEMPLATE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skill", "template-slides.jsx");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!scenePath || !UUID.test(flightId || "") || !SHARE_PATH || !SHARE_ALIAS) {
  console.error("usage: SHARE_PATH=… SHARE_ALIAS=… node assemble.mjs <scene.json> <save-flight-id> [out]");
  process.exit(1);
}
let src = fs.readFileSync(TEMPLATE, "utf8");
const scene = fs.readFileSync(scenePath, "utf8").trimEnd();
const parsed = JSON.parse(scene);

function patch(start, end, body) {
  const s = src.indexOf(start), e = src.indexOf(end);
  if (s < 0 || e < 0 || src.indexOf(start, s + 1) >= 0) throw new Error("sentinel missing or duplicated: " + start);
  src = src.slice(0, s + start.length) + "\n" + body + "\n" + src.slice(e);
}
patch("// __DBS_START__", "// __DBS_END__", `export const REQUIRED_DATABASES = [
  { type: "share", path: "${SHARE_PATH}", alias: "${SHARE_ALIAS}" },
];`);
patch("// __SAVE_FLIGHT_START__", "// __SAVE_FLIGHT_END__", `const SAVE_FLIGHT_ID = "${flightId}";`);
patch("// __SCENE_START__", "// __SCENE_END__", "const SCENE = " + scene + ";");

const bad = src.split("\n").filter((l) => /className/.test(l) && /\[/.test(l));
if (bad.length) throw new Error("tailwind bracket classes present");
if (!UUID.test(parsed.diveId || "")) console.warn("WARN: SCENE.diveId missing — Save disabled until it is set");
const kb = Buffer.byteLength(src) / 1024;
if (kb > 896) throw new Error(`assembled file is ${kb.toFixed(1)} KB, over the 896 KB band`);
if (kb > 768) console.warn(`WARN: ${kb.toFixed(1)} KB, inside the 768–896 KB warning band`);
fs.writeFileSync(out, src);
console.log(`${out}: ${kb.toFixed(1)} KB, ${parsed.elements.length} elements, version ${parsed.version}, diveId ${parsed.diveId}`);
