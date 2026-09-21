// node run_dive_browser.mjs <dive.tsx> <rows.json> <screenshot.png> [options-json]
//
// The real thing: the generated Dive bundled with esbuild (only the MotherDuck SQL hook and
// lucide are swapped for mocks), opened in headless Chromium via Playwright, with the real
// Vega bundle the Dive carries and the rows fetched from MotherDuck. Waits until every
// Vega chart has drawn, screenshots the whole page at the Dive width and prints a JSON
// report (chart SVG count, the text every Vega SVG contains, alerts, console errors).
//
// options: {"width": 880, "expectVega": n, "timeout": 60000, "actions": [...]}
// actions (each followed by a report in `steps`):
//   {"type": "hover", "chart": i, "index": j}        hover the j-th data mark of the i-th Vega chart
//   {"type": "clickMark", "chart": i, "index": j}    click it; the snapshot's popup_url is the tab it opened
//   {"type": "select", "key": k, "value": v}         pick an option in a <select> control
//   {"type": "multiselect", "key": k, "values": [..]} open the popover and tick exactly these members
//   {"type": "daterange", "key": k, "values": [s, e]} fill both date inputs
//   {"type": "input", "key": k, "value": v}          type into a text/number control and commit
//   {"type": "checkbox", "key": k, "value": bool}
//   {"type": "tab", "slug": s} | {"type": "details", "index": i} | {"type": "page", "n": p}
//   {"type": "click", "selector": css}
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const [diveTsx, rowsJson, screenshotPng, optionsJson] = process.argv.slice(2);
const options = { width: 880, expectVega: 0, timeout: 90000, actions: [], ...(optionsJson ? JSON.parse(optionsJson) : {}) };
const outDir = resolve(here, "build", "browser-" + basename(diveTsx, ".tsx"));
mkdirSync(outDir, { recursive: true });

const entry = resolve(outDir, "entry.tsx");
writeFileSync(entry, `
import { createRoot } from "react-dom/client";
import Dive from ${JSON.stringify(resolve(diveTsx))};
createRoot(document.getElementById("root")).render(<Dive />);
`);
await build({
  entryPoints: [entry], bundle: true, format: "iife", platform: "browser", jsx: "automatic",
  outfile: resolve(outDir, "out.js"), logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@motherduck/react-sql-query": resolve(here, "mock-md-sql.js"), "lucide-react": resolve(here, "mock-lucide.js") },
});
writeFileSync(resolve(outDir, "rows.js"), "globalThis.__DIVE_ROWS__ = " + readFileSync(rowsJson, "utf8") + ";");
writeFileSync(resolve(outDir, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}</style></head>
<body><div id="root"></div><script src="rows.js"></script><script src="out.js"></script></body></html>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: options.width, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(pathToFileURL(resolve(outDir, "index.html")).href);
const settled = async (n) => {
  await page.waitForFunction(
    (n) => !document.querySelector(".animate-pulse") && document.querySelectorAll("svg.marks").length >= n,
    n,
    { timeout: options.timeout },
  );
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(500);
};
await settled(options.expectVega);

const snapshot = () => page.evaluate(() => {
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const $ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isData = (l) => !!l && (/[⁡⁢⁣⁤]/.test(l) || l.includes(":"));
  const dataMarks = (svg) => $(".role-mark [aria-label]", svg).filter((m) => isData(m.getAttribute("aria-label")));
  const tooltip = document.querySelector(".dcd-tooltip");
  return {
    vega_svgs: $("svg.marks").length,
    marks_texts: $("svg.marks").map((svg) => $("text", svg).map(txt).filter(Boolean)),
    marks_sizes: $("svg.marks").map((svg) => [svg.getAttribute("width"), svg.getAttribute("height")]),
    marks_paths: $("svg.marks").map((svg) => $("path", svg).map((p) => p.getAttribute("d") || "").filter((d) => d.startsWith("M") && d.includes("A"))),
    // dct's tooltip content per mark: the description expression Vega evaluated (aria-label)
    marks_aria: $("svg.marks").map((svg) => dataMarks(svg).map((m) => m.getAttribute("aria-label"))),
    // the href Vega evaluated for each mark (dct's encoding.href); a click opens it via handleHref
    marks_hrefs: $("svg.marks").map((svg) => dataMarks(svg).map((m) => (m.__data__ && m.__data__.href) || null)),
    marks_opacity: $("svg.marks").map((svg) => dataMarks(svg).map((m) => m.style.opacity || "")),
    tooltip: tooltip && tooltip.style.display !== "none" ? {
      text: txt(tooltip),
      rows: $(".dcd-tt-header, .dcd-tt-series, .dcd-tt-value, .dcd-tt-total, .dcd-tt-row, .dcd-tt-more", tooltip).map((r) => ({ kind: r.className.replace("dcd-tt-", ""), text: txt(r), active: r.getAttribute("data-active") })),
      style: { background: tooltip.style.background, fontSize: tooltip.style.fontSize, border: tooltip.style.border, borderRadius: tooltip.style.borderRadius },
    } : null,
    alerts: $("[role=alert]").map(txt),
    tables: $("table").map((t) => $("tbody tr", t).length),
    table_rows: $("table").map((t) => $("tbody tr", t).map((tr) => $("td", tr).map(txt))),
    table_cell_fonts: $("table").map((t) => $("tbody tr:first-child td", t).map((td) => getComputedStyle(td).fontFamily)),
    table_cell_align: $("table").map((t) => $("tbody tr:first-child td", t).map((td) => getComputedStyle(td).textAlign)),
    // the in-cell spark marks of the first row, with the cell they were sized against
    table_cell_sparks: $("table").map((t) => $("tbody tr:first-child td", t).flatMap((td, col) => {
      const svg = td.querySelector("svg");
      return svg ? [{ col, cell: td.clientWidth, width: Number(svg.getAttribute("width")), height: Number(svg.getAttribute("height")) }] : [];
    })),
    table_links: $("table").map((t) => ({
      cells: $("tbody tr", t).map((tr) => $("td", tr).map((td) => { const a = td.querySelector("a.dcd-cell-link"); return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") } : null; })),
      rows: $("tbody tr", t).map((tr) => tr.getAttribute("data-dcd-row-href")),
      row_anchor_hrefs: $("tbody tr", t).map((tr) => [...new Set($("a.dcd-row-link", tr).map((a) => a.getAttribute("href")))]),
      headers: $("thead th", t).map((th) => th.querySelector("a")?.getAttribute("href") || null),
    })),
    pagers: $(".dcd-pager").map((p) => ({ label: txt(p.querySelector(".dcd-pager-label")), items: $("button", p).map(txt), current: txt(p.querySelector("[aria-current=page]")), clickable: $("button[data-dcd-page]", p).map((b) => b.getAttribute("data-dcd-page")) })),
    kpi_values: $("svg").filter((s) => !s.classList.contains("marks") && !s.parentElement.classList.contains("dcd-svg") && !s.closest("table")).map((s) => txt(s.querySelector("text"))),
    kpi_hrefs: $("svg").filter((s) => !s.classList.contains("marks") && !s.parentElement.classList.contains("dcd-svg") && !s.closest("table")).map((s) => { const a = s.closest("a"); return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") } : null; }),
    tabs: $("[data-dcd-tab]").map((b) => ({ slug: b.getAttribute("data-dcd-tab"), title: txt(b), active: b.getAttribute("aria-selected") === "true", weight: getComputedStyle(b).fontWeight })),
    details: $("[data-dcd-details]").map((s) => ({ key: s.getAttribute("data-dcd-details"), expanded: s.getAttribute("data-expanded") === "true", summary: txt(s.querySelector("button")) })),
    variables: $("[data-dcd-var]").map((v) => ({ key: v.getAttribute("data-dcd-var"), input: v.getAttribute("data-dcd-input"), label: txt(v.querySelector("label")), text: txt(v), opacity: getComputedStyle(v).opacity })),
    variable_notes: $(".dcd-variable-notes").map(txt),
    dive_state: globalThis.__DIVE_STATE__ || {},
    sql_log: globalThis.__DIVE_SQL_LOG__ || [],
    // one card per chart, in layout order: the Chart() wrapper (min-width:0 + card padding)
    chart_boxes: (() => {
      const seen = new Set();
      const boxes = [];
      for (const el of $("svg.marks, table, [role=alert], svg")) {
        if (el.parentElement?.classList.contains("dcd-svg") || el.closest("table") && el.tagName !== "TABLE") continue;
        if (el.tagName === "svg" && !el.classList.contains("marks") && !el.closest("[style*=\"min-width\"]")) continue;
        const card = el.closest("[style*=\"min-width\"]");
        if (!card || seen.has(card)) continue;
        seen.add(card);
        const b = card.getBoundingClientRect();
        boxes.push({ x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.width, h: b.height });
      }
      return boxes;
    })(),
    body_text: txt(document.body),
    page_height: document.documentElement.scrollHeight,
    fonts_loaded: document.fonts ? [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/^["']|["']$/g, "")).filter((v, i, a) => a.indexOf(v) === i) : [],
    fonts_declared: document.fonts ? [...document.fonts].map((f) => f.family.replace(/^["']|["']$/g, "")).filter((v, i, a) => a.indexOf(v) === i) : [],
  };
});

const report = await snapshot();
const contentHeight = await page.evaluate(() => {
  const main = document.querySelector("main");
  const footer = main.querySelector(":scope > footer");
  return Math.ceil(footer.getBoundingClientRect().bottom + parseFloat(getComputedStyle(main).paddingBottom));
});
await page.setViewportSize({ width: options.width, height: contentHeight });
await page.screenshot({ path: screenshotPng, clip: { x: 0, y: 0, width: options.width, height: contentHeight } });
report.content_height = contentHeight;

// Scripted interactions, each followed by a fresh snapshot.
const control = (key) => `[data-dcd-var="${key}"]`;
report.steps = [];
let lastPopup = null;
for (const a of options.actions) {
  if (a.type === "hover") {
    const marks = page.locator("svg.marks").nth(a.chart).locator(".role-mark [aria-label]");
    const n = await marks.count();
    let seen = -1, target = null;
    for (let i = 0; i < n; i++) {
      const l = await marks.nth(i).getAttribute("aria-label");
      if (l && (/[⁡⁢⁣⁤]/.test(l) || l.includes(":"))) { seen += 1; if (seen === a.index) { target = marks.nth(i); break; } }
    }
    if (!target) throw new Error(`hover: chart ${a.chart} has no data mark #${a.index}`);
    await target.scrollIntoViewIfNeeded();
    await target.hover({ force: true });
    await page.waitForTimeout(300);
  } else if (a.type === "clickMark") {
    // click the j-th data mark; Vega's handleHref opens the mark's href in a new tab (target from the loader)
    const marks = page.locator("svg.marks").nth(a.chart).locator(".role-mark [aria-label]");
    const n = await marks.count();
    let seen = -1, target = null;
    for (let i = 0; i < n; i++) {
      const l = await marks.nth(i).getAttribute("aria-label");
      if (l && (/[\u2061\u2062\u2063\u2064]/.test(l) || l.includes(":"))) { seen += 1; if (seen === a.index) { target = marks.nth(i); break; } }
    }
    if (!target) throw new Error(`clickMark: chart ${a.chart} has no data mark #${a.index}`);
    const popup = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await target.click({ force: true });
    const p = await popup;
    lastPopup = p ? p.url() : null;
    if (p) await p.close();
  } else if (a.type === "select") {
    await page.selectOption(`${control(a.key)} select`, a.value == null ? "" : String(a.value));
  } else if (a.type === "multiselect") {
    const c = page.locator(control(a.key));
    await c.locator("button").click();
    for (const o of await c.locator("[role=option][data-value]").all()) {
      const v = await o.getAttribute("data-value");
      const want = a.values.includes(v);
      const is = (await o.getAttribute("aria-selected")) === "true";
      if (want !== is) { await o.locator("input").click(); await page.waitForTimeout(100); }
    }
    await page.mouse.click(1, 1); // close the popover
  } else if (a.type === "daterange") {
    await page.fill(`${control(a.key)} [data-dcd-range=start]`, a.values[0]);
    await page.fill(`${control(a.key)} [data-dcd-range=end]`, a.values[1]);
  } else if (a.type === "input") {
    const inp = page.locator(`${control(a.key)} input`);
    await inp.fill(String(a.value));
    await inp.press("Enter");
  } else if (a.type === "checkbox") {
    await page.locator(`${control(a.key)} input[type=checkbox]`).setChecked(!!a.value);
  } else if (a.type === "tab") {
    await page.click(`[data-dcd-tab="${a.slug}"]`);
  } else if (a.type === "details") {
    await page.locator("[data-dcd-details] > button").nth(a.index).click();
  } else if (a.type === "page") {
    await page.click(`[data-dcd-page="${a.n}"]`);
  } else if (a.type === "click") {
    await page.click(a.selector);
  } else {
    throw new Error(`unknown action ${JSON.stringify(a)}`);
  }
  if (a.type !== "hover" && a.type !== "clickMark") await settled(a.expectVega ?? 0);
  const snap = await snapshot();
  if (a.type === "clickMark") snap.popup_url = lastPopup;
  report.steps.push(snap);
}
await browser.close();
report.console_errors = consoleErrors;
process.stdout.write(JSON.stringify(report));
