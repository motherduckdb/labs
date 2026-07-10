/**
 * Dispatch for completed mviz fence blocks (see `src/core/mviz-fence.ts`,
 * which hands the agentic loop `{ id, source, html }` per finished
 * ` ```<type> ... ``` ` block).
 *
 * `source` is the full fenced block text, delimiters included, e.g.:
 *
 *   ```table size=[16,4]
 *   {"type":"table","columns":[{"id":"product","title":"Product"}],"data":[{"product":"Widget"}]}
 *   ```
 *
 * A block classifies as `'table'` only when every fence type inside it is
 * `table` — any `bar` / `line` / `dumbbell` presence (alone or mixed with a
 * table) makes it a `'chart'`, which the caller renders as a PNG instead.
 */

import { ENABLED_MVIZ_TYPES_PATTERN } from '../core/mviz-types';

const FENCE_TYPE_SRC = '```(' + ENABLED_MVIZ_TYPES_PATTERN + ')(?=\\s)';
const MAX_TABLE_ROWS = 30;

export type MvizBlockKind = 'table' | 'chart';

export function classifyMvizBlock(source: string): MvizBlockKind {
  const types = collectFenceTypes(source);
  return types.size === 1 && types.has('table') ? 'table' : 'chart';
}

function collectFenceTypes(source: string): Set<string> {
  const types = new Set<string>();
  const re = new RegExp(FENCE_TYPE_SRC, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    types.add(match[1]);
  }
  if (types.size > 0) return types;

  // Defensive fallback for a bare "<type> ...\n{...}" source with no ```
  // delimiters (e.g. if a caller passes the fence body rather than the
  // whole block).
  const firstLine = source.trimStart().split('\n')[0]?.trim() ?? '';
  const bareType = firstLine.replace(/^```/, '').split(/\s+/)[0];
  if (bareType) types.add(bareType);
  return types;
}

/**
 * Render a `table`-classified mviz block as a GitHub markdown table string,
 * capped at 30 rows. Returns null when the spec can't be parsed (malformed
 * JSON, missing columns/data) — the caller should fall back to a chart PNG.
 */
export function tableBlockToMarkdown(source: string): string | null {
  const body = extractTableJsonBody(source);
  if (body === null) return null;

  let spec: unknown;
  try {
    spec = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof spec !== 'object' || spec === null) return null;

  const table = normalizeTableSpec(spec as Record<string, unknown>);
  if (!table) return null;

  return renderMarkdownTable(table.header, table.rows);
}

function extractTableJsonBody(source: string): string | null {
  const fenced = /```table(?:[^\n]*)\n([\s\S]*?)\n```/.exec(source);
  if (fenced) return fenced[1];

  const firstNewline = source.indexOf('\n');
  if (firstNewline === -1) return null;
  const opener = source.slice(0, firstNewline).trim().replace(/^```/, '');
  if (!opener.startsWith('table')) return null;
  return source.slice(firstNewline + 1).trim();
}

interface NormalizedTable {
  header: string[];
  rows: string[][];
}

function normalizeTableSpec(spec: Record<string, unknown>): NormalizedTable | null {
  const rawColumns = spec.columns;
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) return null;

  // Columnar shape: columns: string[], rows: unknown[][] (mviz's ColumnarData).
  if (typeof rawColumns[0] === 'string') {
    const header = rawColumns as string[];
    const rawRows = spec.rows;
    if (!Array.isArray(rawRows)) return null;
    const rows = rawRows.map((row) => (Array.isArray(row) ? row.map(cellToString) : header.map(() => '')));
    return { header, rows };
  }

  // Structured shape: columns: ColumnDef[] (id/title, or field/label, or key), data: Record[].
  const colDefs = rawColumns as Array<Record<string, unknown>>;
  const ids = colDefs.map((c) => stringOrEmpty(c.id ?? c.field ?? c.key));
  if (ids.some((id) => id.length === 0)) return null;
  const titles = colDefs.map((c, idx) => stringOrEmpty(c.title ?? c.label) || ids[idx]);

  const rawData = spec.data;
  if (!Array.isArray(rawData)) return null;

  const rows = rawData.map((record) => {
    if (typeof record !== 'object' || record === null) return ids.map(() => '');
    const r = record as Record<string, unknown>;
    return ids.map((id) => cellToString(r[id]));
  });

  return { header: titles, rows };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cellToString).join(', ');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('value' in v) return cellToString(v.value);
    return JSON.stringify(value);
  }
  return String(value);
}

function renderMarkdownTable(header: string[], rows: string[][]): string {
  const escape = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const visibleRows = rows.slice(0, MAX_TABLE_ROWS);

  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...visibleRows.map((row) => `| ${header.map((_h, idx) => escape(row[idx] ?? '')).join(' | ')} |`),
  ];

  const extra = rows.length - visibleRows.length;
  if (extra > 0) {
    lines.push('', `_…${extra} more rows_`);
  }

  return lines.join('\n');
}
