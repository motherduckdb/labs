// Render each Vega-Lite spec against two sets of rows with the Dive's own bundle, the way
// template.tsx does (the rows are a named dataset the spec points at), and print a
// fingerprint of each SVG. A chart that draws the same picture for both did not read them.
import { readFileSync } from "node:fs";

const [bundlePath, jobPath] = process.argv.slice(2);
globalThis.window = globalThis;
new Function("require", "exports", "module", "define", readFileSync(bundlePath, "utf8"))(undefined, undefined, undefined, undefined);

const digest = (s) => s.length + ":" + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const out = {};
for (const job of JSON.parse(readFileSync(jobPath, "utf8"))) {
  const drawn = [];
  for (const rows of job.rows) {
    const vl = vegaLite.compile({ ...job.spec, datasets: { ...job.spec.datasets, dcd_rows: rows } }).spec;
    drawn.push(digest(await new vega.View(vega.parse(vl), { renderer: "none" }).toSVG()));
  }
  out[job.id] = drawn;
}
console.log(JSON.stringify(out));
