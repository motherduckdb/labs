// The supply and demand plan as a real spreadsheet (Univer). Each region x
// category gets three rows:
//   Demand     from the scenario's demand source (locked: change it with the levers)
//   Supply     planned weekly receipts: type, paste or use a formula to override
//              a week (yellow), delete to revert; saved to MotherDuck
//   Inventory  end-of-week on-hand stock, a live formula on the two rows above:
//              =MAX(0, previous week + supply [+ subcontract units] - demand),
//              starting from the on-hand column. Locked: you can open a cell to see
//              which cells feed it, but any change is put back.
// Hovering an overridden supply cell shows who made the edit. Overrides made in
// this session are a stronger yellow than ones saved earlier.
// The header row's Metric / Region / Category cells carry filter dropdowns
// (./GridFilterDropdown, an HTML overlay on the canvas). Region and category
// narrow the cells the parent passes in; metric hides the other metrics' rows
// (hidden, not removed, so the inventory formulas still read them).
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { loadUniver } from "./univer-runtime";
import { HORIZON, overrideKey, type SupplyCell } from "./engine";
import { C } from "./theme";
import { ColumnFilterDropdown, FilterButton, useApplyOnOutsideClick } from "./GridFilterDropdown";

/** A planner edit of one supply cell; units null clears the override. */
export type CellEdit = { region: string; category: string; week_idx: number; units: number | null };

export type EditInfo = { by?: string; at?: string; session: boolean };

/** A header-row filter on one of the label columns; value [] = all. */
export type GridFilter = { col: number; label: string; options: string[]; value: string[]; onChange: (v: string[]) => void };

type Props = {
  cells: SupplyCell[];
  weeks: string[];
  editable: boolean;
  /** Weeks that run short with no action (header tint). */
  shortWeeks: Set<number>;
  /** overrideKey(region, category, week) -> who made the override, and whether it was this session. */
  edits: Record<string, EditInfo>;
  onEdit: (edits: CellEdit[]) => void;
  onBlocked: (message: string) => void;
  /** Dropdowns on the header row's label cells. */
  filters?: GridFilter[];
  /** Metrics shown (empty = all); the other metrics' rows, and their total rows, are hidden. */
  metricSel?: string[];
};

const SHEET_ID = "supply";
const START_COL = 3;
const FIRST_WEEK_COL = 4;
const TOTAL_COL = FIRST_WEEK_COL + HORIZON;
const DEMAND = 0;
const SUPPLY = 1;
const INVENTORY = 2;
export const METRICS = ["Demand", "Supply", "Inventory"];

// Light tints of the chart's series colours (demand ink, supply sky, inventory duck).
export const ROW_BG = ["#EFEFEE", "#E4F3FF", "#FFEEDC"];
export const SERIES = { demand: C.ink, supply: C.darkerSky, inventory: C.duck };
export const OVERRIDE_NOW = C.lighterSun; // edited in this session
export const OVERRIDE_PREV = "#FCF8C4"; // edited in an earlier session
const SHORT_BG = "#FFDCD9";
const MSG = {
  demand: "Demand comes from the demand source. Change it with the levers on the left.",
  inventory: "Inventory is calculated from demand and supply, so it can't be edited.",
  locked: "Only the Supply rows can be edited.",
};

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const weekLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** 0-based sheet row of a region x category's metric row. */
const rowOf = (i: number, metric: number) => 1 + 3 * i + metric;
const normF = (f: string) => f.replace(/\s+/g, "").toUpperCase();
/** Sheet rows the metric filter hides: the filtered-out metrics' rows and total rows. */
function hiddenRows(n: number, metricSel: string[]) {
  const out: number[] = [];
  if (!metricSel.length) return out;
  for (let m = DEMAND; m <= INVENTORY; m++) {
    if (metricSel.includes(METRICS[m])) continue;
    for (let i = 0; i < n; i++) out.push(rowOf(i, m));
    out.push(1 + 3 * n + m);
  }
  return out.sort((a, b) => a - b);
}

function inventoryFormula(i: number, w: number, sub: number) {
  const col = colName(FIRST_WEEK_COL + w);
  const prev = colName(FIRST_WEEK_COL + w - 1); // week 1 reads the on-hand column
  const a1 = (metric: number) => rowOf(i, metric) + 1;
  return `=MAX(0,${prev}${a1(INVENTORY)}+${col}${a1(SUPPLY)}${sub > 0 ? `+${sub}` : ""}-${col}${a1(DEMAND)})`;
}

type OvState = 0 | 1 | 2; // none, earlier session, this session
const ovState = (cell: SupplyCell, w: number, edits: Record<string, EditInfo>): OvState =>
  !cell.overridden[w] ? 0 : edits[overrideKey(cell.region, cell.category, w)]?.session ? 2 : 1;
const supplyStyle = (s: OvState) => (s === 2 ? "supNow" : s === 1 ? "supPrev" : "sup");
const supplyBg = (s: OvState) => (s === 2 ? OVERRIDE_NOW : s === 1 ? OVERRIDE_PREV : ROW_BG[SUPPLY]);

type Expected = {
  demand: number[][];
  supply: number[][];
  ov: OvState[][];
  sub: number[];
  short: Set<number>;
  /** "row|col" -> the formula a locked formula cell must hold. */
  formulas: Map<string, string>;
  /** "row|col" -> the value a locked plain cell must hold (labels, on-hand, blanks). */
  values: Map<string, string | number>;
};

function buildSnapshot(cells: SupplyCell[], weeks: string[], short: Set<number>, edits: Record<string, EditInfo>, metricSel: string[]) {
  const n = cells.length;
  const lastDataA1 = 3 * n + 1;
  const cellData: Record<number, Record<number, any>> = {};
  const formulas = new Map<string, string>();
  const values = new Map<string, string | number>();
  const put = (r: number, c: number, cell: any, locked = true) => {
    (cellData[r] ??= {})[c] = cell;
    if (!locked) return;
    if (cell.f) formulas.set(`${r}|${c}`, cell.f);
    else values.set(`${r}|${c}`, cell.v ?? "");
  };
  const header = ["Metric", "Region", "Category", "On hand"];
  header.forEach((v, c) => put(0, c, { v, s: c < START_COL ? "hdrL" : "hdr" })); // label headers: left, clear of the filter button
  weeks.forEach((w, i) => put(0, FIRST_WEEK_COL + i, { v: `W${i + 1} · ${weekLabel(w)}`, s: short.has(i) ? "hdrShort" : "hdr" }));
  put(0, TOTAL_COL, { v: "26-wk total", s: "hdr" });

  cells.forEach((cell, i) => {
    const sum = (r: number) => `=SUM(${colName(FIRST_WEEK_COL)}${r + 1}:${colName(TOTAL_COL - 1)}${r + 1})`;
    const sub = cell.subcontract[0] ?? 0;
    for (const m of [DEMAND, SUPPLY, INVENTORY]) {
      const r = rowOf(i, m);
      const k = ["d", "s", "i"][m];
      put(r, 0, { v: METRICS[m], s: `${k}Label` });
      put(r, 1, { v: cell.region, s: `${k}Label` });
      put(r, 2, { v: cell.category, s: `${k}Label` });
      put(r, START_COL, m === INVENTORY ? { v: cell.start_inventory, s: "iNum" } : { v: "", s: `${k}Num` });
      for (let w = 0; w < HORIZON; w++) {
        const c = FIRST_WEEK_COL + w;
        if (m === DEMAND) put(r, c, { v: cell.demand[w], s: "dNum" }, false);
        else if (m === SUPPLY) put(r, c, { v: cell.receipts[w], s: supplyStyle(ovState(cell, w, edits)) }, false);
        else put(r, c, { f: inventoryFormula(i, w, sub), s: "iNum" });
      }
      put(r, TOTAL_COL, m === INVENTORY ? { v: "", s: "iTot" } : { f: sum(r), s: `${k}Tot` });
    }
  });

  // Totals over the rows shown: SUMIF on the Metric column.
  const tot = 1 + 3 * n;
  for (const m of [DEMAND, SUPPLY, INVENTORY]) {
    const r = tot + m;
    put(r, 0, { v: METRICS[m], s: "totLabel" });
    put(r, 1, { v: "Total", s: "totLabel" });
    put(r, 2, { v: "All shown", s: "totLabel" });
    for (let c = START_COL; c <= TOTAL_COL; c++) {
      const blank = (m === INVENTORY && c === TOTAL_COL) || (m !== INVENTORY && c === START_COL);
      put(r, c, blank ? { v: "", s: "totNum" }
        : { f: `=SUMIF($A$2:$A$${lastDataA1},"${METRICS[m]}",${colName(c)}2:${colName(c)}${lastDataA1})`, s: "totNum" });
    }
  }

  const numfmt = { pattern: "#,##0" };
  const line = (cl: string) => ({ b: { s: 1, cl: { rgb: cl } } });
  const groupEnd = line(C.darkSand);
  const base = { fs: 10, cl: { rgb: C.ink } };
  const num = (bg: string, extra: any = {}) => ({ ...base, n: numfmt, ht: 3, bg: { rgb: bg }, ...extra });
  const columnData: Record<number, any> = { 0: { w: 78 }, 1: { w: 84 }, 2: { w: 92 }, [START_COL]: { w: 70 }, [TOTAL_COL]: { w: 96 } };
  for (let w = 0; w < HORIZON; w++) columnData[FIRST_WEEK_COL + w] = { w: 80 };
  const rowData: Record<number, any> = {};
  for (const r of hiddenRows(n, metricSel)) rowData[r] = { hd: 1 };
  const snapshot = {
    id: "supply-plan",
    name: "Supply and demand plan",
    appVersion: "0.25.1",
    locale: "enUS",
    styles: {
      hdr: { ...base, bl: 1, bg: { rgb: C.sand }, bd: line(C.ink), ht: 2 },
      hdrL: { ...base, bl: 1, bg: { rgb: C.sand }, bd: line(C.ink), ht: 1 },
      hdrShort: { ...base, bl: 1, bg: { rgb: SHORT_BG }, bd: line(C.ink), ht: 2 },
      dLabel: { ...base, bg: { rgb: ROW_BG[DEMAND] } },
      sLabel: { ...base, bg: { rgb: ROW_BG[SUPPLY] } },
      iLabel: { ...base, bg: { rgb: ROW_BG[INVENTORY] }, bd: groupEnd },
      dNum: num(ROW_BG[DEMAND]),
      sNum: num(ROW_BG[SUPPLY]),
      iNum: num(ROW_BG[INVENTORY], { bd: groupEnd }),
      sup: num(ROW_BG[SUPPLY]),
      supPrev: num(OVERRIDE_PREV, { bl: 1 }),
      supNow: num(OVERRIDE_NOW, { bl: 1 }),
      dTot: num(ROW_BG[DEMAND], { bl: 1 }),
      sTot: num(ROW_BG[SUPPLY], { bl: 1 }),
      iTot: num(ROW_BG[INVENTORY], { bl: 1, bd: groupEnd }),
      totLabel: { ...base, bl: 1, bg: { rgb: C.snow } },
      totNum: num(C.snow, { bl: 1 }),
    },
    sheetOrder: [SHEET_ID],
    sheets: {
      [SHEET_ID]: {
        id: SHEET_ID,
        name: "Supply and demand (units)",
        rowCount: tot + 3 + 4,
        columnCount: TOTAL_COL + 3,
        defaultRowHeight: 22,
        defaultColumnWidth: 80,
        freeze: { xSplit: FIRST_WEEK_COL, ySplit: 1, startRow: 1, startColumn: FIRST_WEEK_COL },
        columnData,
        rowData,
        cellData,
      },
    },
  };
  return { snapshot, formulas, values };
}

export default function SupplyGrid({ cells, weeks, editable, shortWeeks, edits, onEdit, onBlocked, filters = [], metricSel = [] }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);
  const univerRef = useRef<any>(null);
  const expectedRef = useRef<Expected | null>(null);
  const propsRef = useRef({ cells, editable, edits, onEdit, onBlocked, metricSel });
  propsRef.current = { cells, editable, edits, onEdit, onBlocked, metricSel };
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // Last value sent per cell: the formula engine re-emits a result several
  // times; only the first one is a change worth saving.
  const sentRef = useRef<Record<string, { units: number | null; at: number }>>({});
  // Last time each locked cell was put back (guards against a revert loop).
  const revertedRef = useRef<Record<string, number>>({});
  const mouseRef = useRef({ x: 0, y: 0 });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  // Header filter overlays: where each filtered column's header cell sits over the canvas.
  const [hdrBoxes, setHdrBoxes] = useState<Record<number, { left: number; top: number; width: number; height: number }>>({});
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const filterApplyRef = useRef<(() => void) | null>(null);
  useApplyOnOutsideClick(openFilter != null, filterApplyRef, () => setOpenFilter(null));
  const hidingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const offs: any[] = [];
    (async () => {
      try {
        const g = await loadUniver();
        if (disposed || !hostRef.current) return;
        const { Univer, LocaleType, mergeLocales, UniverInstanceType } = g.UniverCore;
        const univer = new Univer({
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: mergeLocales(
              g.UniverDesignEnUS, g.UniverUiEnUS, g.UniverDocsUiEnUS, g.UniverSheetsEnUS,
              g.UniverSheetsUiEnUS, g.UniverSheetsFormulaUiEnUS, g.UniverSheetsNumfmtUiEnUS,
            ),
          },
        });
        univer.registerPlugin(g.UniverEngineRender.UniverRenderEnginePlugin);
        univer.registerPlugin(g.UniverEngineFormula.UniverFormulaEnginePlugin);
        univer.registerPlugin(g.UniverUi.UniverUIPlugin, { container: hostRef.current, header: true, toolbar: false, footer: false, contextMenu: true });
        univer.registerPlugin(g.UniverDocs.UniverDocsPlugin);
        univer.registerPlugin(g.UniverDocsUi.UniverDocsUIPlugin);
        univer.registerPlugin(g.UniverSheets.UniverSheetsPlugin);
        univer.registerPlugin(g.UniverSheetsUi.UniverSheetsUIPlugin);
        univer.registerPlugin(g.UniverSheetsFormula.UniverSheetsFormulaPlugin);
        univer.registerPlugin(g.UniverSheetsFormulaUi.UniverSheetsFormulaUIPlugin);
        univer.registerPlugin(g.UniverSheetsNumfmt.UniverSheetsNumfmtPlugin);
        univer.registerPlugin(g.UniverSheetsNumfmtUi.UniverSheetsNumfmtUIPlugin);
        const p = propsRef.current;
        const short = new Set(shortWeeks);
        const { snapshot, formulas, values } = buildSnapshot(p.cells, weeks, short, p.edits, p.metricSel);
        univer.createUnit(UniverInstanceType.UNIVER_SHEET, snapshot);
        expectedRef.current = {
          demand: p.cells.map((c) => c.demand.slice()),
          supply: p.cells.map((c) => c.receipts.slice()),
          ov: p.cells.map((c) => c.overridden.map((_, w) => ovState(c, w, p.edits))),
          sub: p.cells.map((c) => c.subcontract[0] ?? 0),
          short,
          formulas,
          values,
        };
        const api = g.UniverCoreFacade.FUniver.newAPI(univer);
        univerRef.current = univer;
        apiRef.current = api;
        offs.push(api.addEvent(api.Event.CommandExecuted, (ev: any) => {
          if (ev?.id === "sheet.mutation.set-range-values") handleMutation(ev.params);
          // rows unhidden from the row header or menu: keep the metric filter's rows hidden
          else if (ev?.id === "sheet.mutation.set-row-visible" && !hidingRef.current) setTimeout(() => applyHidden(false), 0);
        }));
        // Header cells move when columns are resized, the sheet zooms or the grid resizes.
        for (const name of ["SheetSkeletonChanged", "SheetZoomChanged"]) {
          if (api.Event[name]) offs.push(api.addEvent(api.Event[name], () => requestAnimationFrame(() => measureHeader())));
        }
        const ro = new ResizeObserver(() => requestAnimationFrame(() => measureHeader()));
        if (wrapRef.current) ro.observe(wrapRef.current);
        offs.push({ dispose: () => ro.disconnect() });
        // Locked cells: no editor, except Inventory weeks, which open so the
        // formula's input cells are highlighted (any change is put back).
        offs.push(api.addEvent(api.Event.BeforeSheetEditStart, (ev: any) => {
          const kind = classify(ev?.row, ev?.column);
          if (kind === "inventory") return;
          if (kind === "supply" && propsRef.current.editable) return;
          ev.cancel = true;
          propsRef.current.onBlocked(kind === "supply" ? "" : kind === "demand" ? MSG.demand : MSG.locked);
        }));
        const hover = (ev: any) => {
          // CellPointerMove carries the pointer event: position the tooltip from it.
          const pe = ev?.event;
          const box = wrapRef.current?.getBoundingClientRect();
          if (box && pe && typeof pe.clientX === "number") mouseRef.current = { x: pe.clientX - box.left, y: pe.clientY - box.top };
          showTip(ev?.row, ev?.column);
        };
        for (const name of ["CellPointerMove", "CellHover"]) {
          if (api.Event[name]) offs.push(api.addEvent(api.Event[name], hover));
        }
        (window as any).__spGrid = { api, univer }; // for e2e tests
        setStatus("ready");
        requestAnimationFrame(() => measureHeader());
      } catch (e: any) {
        console.error("[SupplyGrid]", e);
        setError(String(e?.message ?? e));
        setStatus("error");
      }
    })();
    return () => {
      disposed = true;
      try {
        for (const off of offs) off?.dispose?.();
        univerRef.current?.dispose?.();
      } catch {
        /* ignore */
      }
      univerRef.current = null;
      apiRef.current = null;
      delete (window as any).__spGrid;
    };
    // weeks never change for a mounted grid; the parent remounts it per scenario and filter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sheet() {
    return apiRef.current?.getActiveWorkbook?.()?.getSheetBySheetId?.(SHEET_ID) ?? apiRef.current?.getActiveWorkbook?.()?.getActiveSheet?.();
  }

  /** Positions the header filter buttons over the frozen header cells (canvas coordinates x zoom). */
  function measureHeader(retry = 0) {
    if (!apiRef.current) return;
    const ws = sheet();
    const wrap = wrapRef.current;
    const canvas = hostRef.current?.querySelector<HTMLCanvasElement>('canvas[id^="univer-sheet-main-canvas"]'); // not the formula bar's canvas
    // the sheet canvas renders a little after the unit is created
    if (!ws || !wrap || !canvas || !canvas.getBoundingClientRect().width) {
      if (retry < 50) setTimeout(() => measureHeader(retry + 1), 100);
      return;
    }
    const box = wrap.getBoundingClientRect();
    const cv = canvas.getBoundingClientRect();
    const zoom = Number(ws.getZoom?.() ?? 1) || 1;
    const next: Record<number, { left: number; top: number; width: number; height: number }> = {};
    for (const c of [0, 1, 2]) {
      try {
        const r = ws.getRange(0, c, 1, 1).getCellRect();
        next[c] = { left: cv.left - box.left - wrap.clientLeft + r.left * zoom, top: cv.top - box.top - wrap.clientTop + r.top * zoom, width: r.width * zoom, height: r.height * zoom };
      } catch {
        /* not rendered yet */
      }
    }
    setHdrBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }

  /** Hides the rows the metric filter leaves out (and, unless onlyHide, shows the rest). */
  function applyHidden(showOthers = true) {
    const api = apiRef.current;
    const n = expectedRef.current?.demand.length ?? 0;
    if (!api || !n) return;
    const hide = hiddenRows(n, propsRef.current.metricSel);
    const range = (r: number) => ({ startRow: r, endRow: r, startColumn: 0, endColumn: TOTAL_COL, rangeType: 1 /* ROW */ });
    const base = { unitId: "supply-plan", subUnitId: SHEET_ID };
    hidingRef.current = true;
    try {
      // mutations, not commands: filtering stays out of the undo stack
      if (showOthers) api.executeCommand("sheet.mutation.set-row-visible", { ...base, ranges: [{ ...range(1), endRow: 3 * n + 3 }] });
      if (hide.length) api.executeCommand("sheet.mutation.set-row-hidden", { ...base, ranges: hide.map(range) });
    } finally {
      hidingRef.current = false;
    }
  }

  /** What a sheet cell is: an editable supply week, a demand / inventory week, or another locked cell. */
  function classify(r: number, c: number): "supply" | "demand" | "inventory" | "locked" | "none" {
    const n = expectedRef.current?.demand.length ?? 0;
    if (r == null || c == null || r < 0 || c < 0) return "none";
    if (r >= 1 && r <= 3 * n && c >= FIRST_WEEK_COL && c < TOTAL_COL) {
      const m = (r - 1) % 3;
      return m === SUPPLY ? "supply" : m === DEMAND ? "demand" : "inventory";
    }
    return "locked";
  }

  function showTip(r: number, c: number) {
    if (classify(r, c) !== "supply") return setTip(null);
    const { cells: cs, edits: ed } = propsRef.current;
    const cell = cs[Math.floor((r - 1) / 3)];
    const w = c - FIRST_WEEK_COL;
    if (!cell?.overridden[w]) return setTip(null);
    const e = ed[overrideKey(cell.region, cell.category, w)];
    const who = e?.by || "an unknown user";
    const when = e?.session ? "this session"
      : e?.at ? new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    setTip({ ...mouseRef.current, text: `Edited by ${who}${when ? ` · ${when}` : ""}` });
  }

  function handleMutation(params: any) {
    const exp = expectedRef.current;
    const cellValue = params?.cellValue;
    if (!exp || !cellValue || (params.subUnitId && params.subUnitId !== SHEET_ID)) return;
    const touched: Array<[number, number]> = [];
    const locked: Array<[number, number]> = [];
    let hasFormula = false;
    for (const rs of Object.keys(cellValue)) {
      const r = Number(rs);
      for (const cs of Object.keys(cellValue[rs] ?? {})) {
        const c = Number(cs);
        const cell = cellValue[rs][cs];
        if (!cell || !("v" in cell || "f" in cell || "p" in cell || "si" in cell)) continue; // style-only
        const kind = classify(r, c);
        if (kind === "none") continue;
        if (kind !== "supply") {
          locked.push([r, c]);
          continue;
        }
        const i = Math.floor((r - 1) / 3);
        if (!cell.f && !cell.si && Number(cell.v) === exp.supply[i][c - FIRST_WEEK_COL] && cell.v !== "" && cell.v != null) continue; // our own write
        if (cell.f || cell.si) hasFormula = true;
        touched.push([r, c]);
      }
    }
    if (locked.length) setTimeout(() => restoreLocked(locked), 60);
    if (!touched.length) return;
    // Read back after the formula engine settles, so pasted formulas resolve.
    const settle = (attempt: number) => {
      const ws = sheet();
      const pending = hasFormula && attempt < 15 && touched.some(([r, c]) => {
        const v = ws?.getRange(r, c, 1, 1)?.getValue?.();
        const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : Number(v);
        return v == null || v === "" || (typeof v === "string" && v.startsWith("=")) || n === exp.supply[Math.floor((r - 1) / 3)][c - FIRST_WEEK_COL];
      });
      if (pending) setTimeout(() => settle(attempt + 1), 100);
      else apply();
    };
    const apply = () => {
      const { cells: cs, editable, onEdit, onBlocked } = propsRef.current;
      const e = expectedRef.current!;
      if (!editable) {
        onBlocked("");
        for (const [r, c] of touched) writeSupply(r, c);
        return;
      }
      const ws = sheet();
      const edits: CellEdit[] = [];
      for (const [r, c] of touched) {
        const i = Math.floor((r - 1) / 3);
        const cell = cs[i];
        const w = c - FIRST_WEEK_COL;
        let raw: any = ws?.getRange(r, c, 1, 1)?.getValue?.();
        if (typeof raw === "string") raw = raw.replace(/[,\s]/g, "");
        const blank = raw == null || raw === "";
        const num = Number(raw);
        if (!blank && (!Number.isFinite(num) || num < 0)) {
          writeSupply(r, c);
          continue;
        }
        const units = blank ? null : Math.round(num);
        if (units != null && units === e.supply[i][w] && cell.overridden[w]) continue; // unchanged
        if (units == null && !cell.overridden[w]) {
          writeSupply(r, c);
          continue;
        }
        const k = `${r}|${c}`;
        const prev = sentRef.current[k];
        if (prev && prev.units === units && Date.now() - prev.at < 5000) continue;
        sentRef.current[k] = { units, at: Date.now() };
        edits.push({ region: cell.region, category: cell.category, week_idx: w, units });
      }
      if (edits.length) onEdit(edits);
    };
    setTimeout(() => settle(0), hasFormula ? 120 : 30);
  }

  /** Put locked cells (demand, inventory formulas, labels, totals) back the way the plan has them. */
  function restoreLocked(list: Array<[number, number]>) {
    const exp = expectedRef.current;
    const ws = sheet();
    if (!exp || !ws) return;
    let message = "";
    for (const [r, c] of list) {
      const key = `${r}|${c}`;
      const kind = classify(r, c);
      const range = ws.getRange(r, c, 1, 1);
      let want: { f?: string; v?: string | number };
      if (kind === "demand") want = { v: exp.demand[Math.floor((r - 1) / 3)][c - FIRST_WEEK_COL] };
      else if (exp.formulas.has(key)) want = { f: exp.formulas.get(key)! };
      else if (exp.values.has(key)) want = { v: exp.values.get(key)! };
      else continue;
      let ok: boolean;
      if (want.f != null) ok = normF(String(range.getFormula?.() ?? "")) === normF(want.f);
      else {
        const v = range.getValue?.();
        // getValue() can return the formatted text ("1,152") of a number cell.
        const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : Number(v);
        ok = typeof want.v === "number" ? n === want.v && v !== "" && v != null : String(v ?? "") === want.v;
      }
      if (ok) continue;
      if (Date.now() - (revertedRef.current[key] ?? 0) < 1500) continue; // already put back just now
      revertedRef.current[key] = Date.now();
      if (want.f != null) range.setFormula(want.f);
      else range.setValue(want.v);
      message ||= kind === "inventory" ? MSG.inventory : kind === "demand" ? MSG.demand : MSG.locked;
    }
    if (message) propsRef.current.onBlocked(message);
  }

  function writeSupply(r: number, c: number) {
    const exp = expectedRef.current;
    const ws = sheet();
    if (!exp || !ws) return;
    ws.getRange(r, c, 1, 1).setValues([[exp.supply[Math.floor((r - 1) / 3)][c - FIRST_WEEK_COL]]]);
  }

  // Push engine output into the grid whenever the plan changes. Inventory
  // recalculates by itself (formulas); only changed runs of cells are written.
  useEffect(() => {
    const exp = expectedRef.current;
    const ws = sheet();
    if (status !== "ready" || !exp || !ws) return;
    const next: Expected = {
      ...exp,
      demand: cells.map((c) => c.demand.slice()),
      supply: cells.map((c) => c.receipts.slice()),
      ov: cells.map((c) => c.overridden.map((_, w) => ovState(c, w, edits))),
      sub: cells.map((c) => c.subcontract[0] ?? 0),
      short: new Set(shortWeeks),
      formulas: new Map(exp.formulas),
    };
    cells.forEach((_, i) => {
      if (next.sub[i] === exp.sub[i]) return;
      for (let w = 0; w < HORIZON; w++) next.formulas.set(`${rowOf(i, INVENTORY)}|${FIRST_WEEK_COL + w}`, inventoryFormula(i, w, next.sub[i]));
    });
    expectedRef.current = next;
    const writeRuns = (metric: number, now: number[][], before: number[][]) => now.forEach((row, i) => {
      let w = 0;
      while (w < HORIZON) {
        if (row[w] === before[i][w]) { w++; continue; }
        const start = w;
        while (w < HORIZON && row[w] !== before[i][w]) w++;
        ws.getRange(rowOf(i, metric), FIRST_WEEK_COL + start, 1, w - start).setValues([row.slice(start, w)]);
      }
    });
    writeRuns(DEMAND, next.demand, exp.demand);
    writeRuns(SUPPLY, next.supply, exp.supply);
    cells.forEach((_, i) => {
      if (next.sub[i] === exp.sub[i]) return;
      ws.getRange(rowOf(i, INVENTORY), FIRST_WEEK_COL, 1, HORIZON).setFormulas([Array.from({ length: HORIZON }, (_, w) => inventoryFormula(i, w, next.sub[i]))]);
    });
    next.ov.forEach((row, i) => row.forEach((s, w) => {
      if (s === exp.ov[i][w]) return;
      const range = ws.getRange(rowOf(i, SUPPLY), FIRST_WEEK_COL + w, 1, 1);
      range.setBackgroundColor(supplyBg(s));
      range.setFontWeight?.(s ? "bold" : "normal");
    }));
    for (let w = 0; w < HORIZON; w++) {
      if (next.short.has(w) !== exp.short.has(w)) ws.getRange(0, FIRST_WEEK_COL + w, 1, 1).setBackgroundColor(next.short.has(w) ? SHORT_BG : C.sand);
    }
  }, [cells, edits, shortWeeks, status]);

  const metricKey = metricSel.join(",");
  const appliedMetricRef = useRef(metricKey);
  useEffect(() => {
    if (status !== "ready" || appliedMetricRef.current === metricKey) return;
    appliedMetricRef.current = metricKey;
    applyHidden();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricKey, status]);

  return (
    <div ref={wrapRef} style={{ position: "relative", height: "100%", minHeight: 0, border: `2px solid ${C.ink}`, borderRadius: 2, background: "#fff" }}
      onMouseMove={(e) => {
        const box = wrapRef.current?.getBoundingClientRect();
        if (!box) return;
        mouseRef.current = { x: e.clientX - box.left, y: e.clientY - box.top };
        setTip((t) => (t ? { ...t, ...mouseRef.current } : t));
      }}
      onMouseLeave={() => setTip(null)}>
      <div ref={hostRef} data-testid="supply-grid" style={{ position: "absolute", inset: 0 }} />
      {status === "ready" && filters.map((f) => {
        const b = hdrBoxes[f.col];
        if (!b) return null;
        const size = Math.min(18, b.height - 4);
        return (
          <React.Fragment key={f.col}>
            <FilterButton label={f.label} active={f.value.length > 0} open={openFilter === f.col}
              onClick={() => setOpenFilter((o) => (o === f.col ? null : f.col))}
              style={{ left: b.left + b.width - size - 3, top: b.top + (b.height - size) / 2, width: size, height: size, zIndex: 15 }} />
            {openFilter === f.col && (
              <ColumnFilterDropdown label={f.label} values={f.options} currentSelection={f.value.length ? new Set(f.value) : null} applyRef={filterApplyRef}
                // fit inside the grid (its container clips): the value list scrolls
                style={{ left: b.left, top: b.top + b.height + 2, maxHeight: Math.max(160, Math.min(350, (wrapRef.current?.clientHeight ?? 400) - b.top - b.height - 8)) }}
                onApply={(sel) => {
                  setOpenFilter(null);
                  f.onChange(sel == null ? [] : f.options.filter((o) => sel.has(o)));
                }}
                onCancel={() => setOpenFilter(null)} />
            )}
          </React.Fragment>
        );
      })}
      {tip && (
        <div role="tooltip" data-testid="edit-tooltip" style={{
          position: "absolute", left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 9999) - 240), top: tip.y + 18, zIndex: 20, pointerEvents: "none",
          padding: "4px 8px", background: C.ink, color: C.white, borderRadius: 2, fontSize: 12, whiteSpace: "nowrap",
        }}>{tip.text}</div>
      )}
      {status !== "ready" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: C.snow }}>
          {status === "loading" ? (
            <div className="animate-pulse text-sm" style={{ color: C.darkGrey }}>Loading the spreadsheet engine…</div>
          ) : (
            <p role="alert" className="text-sm" style={{ color: C.darkWatermelon, padding: 16 }}>Spreadsheet failed to load: {error}</p>
          )}
        </div>
      )}
    </div>
  );
}
