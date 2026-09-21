// node run_dive.mjs <dive.tsx> <rows.json> [options-json]  ->  prints a JSON report of the rendered DOM.
//
// Bundles the generated Dive with esbuild (the MotherDuck SQL hook and lucide swapped for
// mocks), mounts it in jsdom with the rows the Python side fetched from MotherDuck, waits
// until nothing is loading, and reports every data-dependent piece of the DOM in document
// order. The Vega bundle is mocked here (chart pixels are checked in run_dive_browser.mjs);
// d3-format / d3-time-format are the real libraries, so number and date strings are what
// the Dive prints.
//
// options: {"clickTab": n}  click the n-th tab button after the first render and report again.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as d3f from "d3-format";
import * as d3t from "d3-time-format";

const here = dirname(fileURLToPath(import.meta.url));
const [diveTsx, rowsJson, optionsJson] = process.argv.slice(2);
const options = optionsJson ? JSON.parse(optionsJson) : {};
const outDir = resolve(here, "build", "jsdom-" + basename(diveTsx, ".tsx"));
mkdirSync(outDir, { recursive: true });

// 1. Bundle: the Dive + a mount script, with the two runtime-only imports swapped for mocks.
const entry = resolve(outDir, "entry.tsx");
writeFileSync(entry, `
import { createRoot } from "react-dom/client";
import Dive, { REQUIRED_DATABASES } from ${JSON.stringify(resolve(diveTsx))};
globalThis.__REQUIRED_DATABASES__ = REQUIRED_DATABASES;
createRoot(document.getElementById("root")).render(<Dive />);
`);
await build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "browser", jsx: "automatic",
  outfile: resolve(outDir, "out.js"), logLevel: "warning",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: { "@motherduck/react-sql-query": resolve(here, "mock-md-sql.js"), "lucide-react": resolve(here, "mock-lucide.js") },
});

// 2. A DOM, with the pieces the Dive expects from the browser: the vega globals (mocked —
//    chart pixels are not under test here) and d3 formatting, which the Dive uses for numbers.
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: "https://example.test/" });
const w = dom.window;
for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "Event", "CustomEvent", "MouseEvent"]) {
  if (!(k in globalThis)) globalThis[k] = w[k];
}
globalThis.window = w; globalThis.document = w.document;
w.vegaEmbed = async (el, spec) => { el.innerHTML = `<svg data-mock-vega="1" width="${spec.width ?? 100}" height="100"></svg>`; return { view: { finalize() {} } }; };
w.vega = { defaultLocale: () => ({ format: d3f.format, formatPrefix: d3f.formatPrefix, utcFormat: d3t.utcFormat, timeFormat: d3t.timeFormat }) };
globalThis.__DIVE_ROWS__ = JSON.parse(readFileSync(rowsJson, "utf8"));

// 3. Mount and wait until nothing is loading any more.
await import(pathToFileURL(resolve(outDir, "out.js")).href);
const settle = async () => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!w.document.querySelector(".animate-pulse")) break;
  }
  await new Promise((r) => setTimeout(r, 150));
};
await settle();

// 4. Report.
const $ = (sel, root = w.document) => [...root.querySelectorAll(sel)];
const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const font = (el) => (el?.style?.fontFamily || "");

function describeTable(table) {
  const wrapper = table.parentElement; // <div style="overflow-x:auto"> from Table()
  const titleBlock = wrapper.firstElementChild !== table ? wrapper.firstElementChild : null;
  const after = table.nextElementSibling;
  const pager = after && after.classList.contains("dcd-pager") ? after : null;
  // a pie legend table shares its card (the Chart() wrapper) with a Vega chart
  const legend = !!table.closest("[style*=\"min-width\"]")?.querySelector("svg[data-mock-vega]");
  return {
    kind: legend ? "legend" : "table",
    title: titleBlock ? txt(titleBlock.firstElementChild) : "",
    subtitle: titleBlock && titleBlock.children.length > 1 ? txt(titleBlock.children[1]) : "",
    headers: $("thead th", table).map(txt),
    header_align: $("thead th", table).map((th) => th.style.textAlign),
    header_rule: $("thead th", table).map((th) => th.style.borderBottom)[0] || "",
    header_visible: !!table.querySelector("thead"),
    rows: $("tbody tr", table).map((tr) => $("td", tr).map(txt)),
    cell_align: $("tbody tr", table).map((tr) => $("td", tr).map((td) => td.style.textAlign)),
    cell_font: $("tbody tr", table).map((tr) => $("td", tr).map((td) => font(td))),
    row_background: $("tbody tr", table).map((tr) => tr.style.background || tr.style.backgroundColor || ""),
    swatches: $("tbody tr", table).map((tr) => $("td span", tr).map((sp) => sp.style.background || sp.style.backgroundColor || "")),
    table_font: font(table),
    // dct's paginator: the "Rows a–b of n" label (``more``, for the tail check) and the page items
    more: pager ? txt(pager.querySelector(".dcd-pager-label")) : "",
    pager: pager ? { label: txt(pager.querySelector(".dcd-pager-label")), items: $("button", pager).map(txt), current: txt(pager.querySelector("[aria-current=page]")) } : null,
    empty: after && after.tagName === "DIV" && !pager ? txt(after) : "",
    // the in-cell spark marks, one entry per cell that drew one, carrying where it sits:
    // a mark with nothing to draw leaves no element at all, so the grid has holes
    cell_sparks: $("tbody tr", table).flatMap((tr, row) => $("td", tr).flatMap((td, col) => {
      const svg = td.querySelector("svg");
      return !svg ? [] : [{
      row, col,
      width: Number(svg.getAttribute("width")), height: Number(svg.getAttribute("height")),
      shapes: $("rect, line, polyline, polygon, circle, text", svg).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: el.tagName.toLowerCase() === "text" ? txt(el) : undefined,
        ...Object.fromEntries(["x", "y", "width", "height", "rx", "x1", "y1", "x2", "y2", "cx", "cy", "r", "points", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-size", "font-family", "text-anchor", "dominant-baseline"]
          .map((name) => [name, el.getAttribute(name)])
          .filter(([, v]) => v !== null)),
      })),
    }];
    })),
    cell_links: $("tbody tr", table).map((tr) => $("td", tr).map((td) => td.querySelector("a.dcd-cell-link")?.getAttribute("href") || null)),
    row_links: $("tbody tr", table).map((tr) => tr.getAttribute("data-dcd-row-href")),
    header_links: $("thead th", table).map((th) => th.querySelector("a")?.getAttribute("href") || null),
  };
}

function describeKpi(svg) {
  const texts = $("text", svg);
  const value = texts[0];
  const spans = value ? $("tspan", value).map(txt) : [];
  return {
    kind: "kpi",
    value: txt(value),
    value_spans: spans,
    value_font: value?.getAttribute("font-family") || "",
    value_fill: $("tspan", value || svg).map((s) => s.getAttribute("fill")).filter(Boolean)[0] || null,
    label: txt(texts[1]),
    label_lines: texts[1] ? $("tspan", texts[1]).map(txt) : [],
    support: txt(texts[2]),
    texts: texts.map(txt),
    width: svg.getAttribute("width"),
    height: svg.getAttribute("height"),
    href: svg.closest("a")?.getAttribute("href") || null,
  };
}

// The spark bar the Dive draws itself: the primitives, so a test can hold them against the
// ones dct's own renderer writes for the same chart.
function describeSpark(svg) {
  const num = (el, name) => (el.getAttribute(name) === null ? null : Number(el.getAttribute(name)));
  return {
    kind: "spark_bar",
    width: num(svg, "width"),
    height: num(svg, "height"),
    rects: $("rect", svg).map((r) => ({ x: num(r, "x"), y: num(r, "y"), width: num(r, "width"), height: num(r, "height"), fill: r.getAttribute("fill"), rx: num(r, "rx") })),
    texts: $("text", svg).map((t) => ({
      x: num(t, "x"), y: num(t, "y"), text: txt(t),
      size: num(t, "font-size"), fill: t.getAttribute("fill"), anchor: t.getAttribute("text-anchor"),
      weight: t.getAttribute("font-weight"), style: t.getAttribute("font-style"), family: t.getAttribute("font-family"),
      kind: t.getAttribute("data-authored-kind"),
    })),
  };
}

function report() {
  const charts = [];
  for (const el of $("svg[data-mock-vega], table, [role=alert], svg")) {
    if (el.tagName === "TABLE") charts.push(describeTable(el));
    else if (el.getAttribute("role") === "alert") charts.push({ kind: "error", text: txt(el) });
    else if (el.hasAttribute("data-mock-vega")) charts.push({ kind: "vega", width: el.getAttribute("width") });
    else if (el.parentElement?.classList.contains("dcd-svg")) charts.push({ kind: "svg", text: txt(el) });
    else if (el.hasAttribute("data-dcd-spark")) charts.push(describeSpark(el));
    else if (!el.closest("table")) charts.push(describeKpi(el));
  }
  const fontsCss = w.document.getElementById("dcd-fonts")?.textContent || "";
  return {
    required_databases: globalThis.__REQUIRED_DATABASES__,
    skeletons: $(".animate-pulse").length,
    alerts: $("[role=alert]").map(txt),
    vega_charts: $("[data-mock-vega]").length,
    charts,
    tables: charts.filter((c) => c.kind === "table" || c.kind === "legend"),
    kpis: charts.filter((c) => c.kind === "kpi"),
    sparks: charts.filter((c) => c.kind === "spark_bar"),
    tabs: $("[data-dcd-tab]").map(txt),
    active_tab: $("[data-dcd-tab][aria-selected=true]").map((b) => b.getAttribute("data-dcd-tab"))[0] ?? null,
    details: $("[data-dcd-details]").map((s) => ({ key: s.getAttribute("data-dcd-details"), expanded: s.getAttribute("data-expanded") === "true", summary: txt(s.querySelector("button")) })),
    variables: $("[data-dcd-var]").map((v) => ({ key: v.getAttribute("data-dcd-var"), input: v.getAttribute("data-dcd-input"), label: txt(v.querySelector("label")), text: txt(v) })),
    variable_notes: $(".dcd-variable-notes").map(txt),
    dive_state: globalThis.__DIVE_STATE__ || {},
    sql_log: globalThis.__DIVE_SQL_LOG__ || [],
    fonts: {
      css_length: fontsCss.length,
      font_faces: (fontsCss.match(/@font-face/g) || []).length,
      data_uris: (fontsCss.match(/url\(["']?data:/g) || []).length,
      families: [...new Set([...fontsCss.matchAll(/font-family:\s*["']([^"']+)["']/g)].map((m) => m[1]))].sort(),
    },
    text: txt(w.document.body),
  };
}

const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
const out = { initial: report() };
if (options.clickTab != null) {
  const buttons = $("[data-dcd-tab]");
  const b = buttons[options.clickTab];
  if (!b) throw new Error(`no tab button #${options.clickTab}; found ${buttons.length}`);
  click(b);
  await settle();
  out.after_click = report();
}
if (options.clickDetails != null) {
  const s = $("[data-dcd-details]")[options.clickDetails];
  if (!s) throw new Error(`no details section #${options.clickDetails}`);
  click(s.querySelector("button"));
  await settle();
  out.after_details = report();
}
if (options.clickPage != null) {
  const b = $(`[data-dcd-page="${options.clickPage}"]`)[0];
  if (!b) throw new Error(`no page button ${options.clickPage}`);
  click(b);
  await settle();
  out.after_page = report();
}
process.stdout.write(JSON.stringify(out));
