/**
 * Shared parsers for MCP tool responses (#98).
 *
 * MotherDuck's MCP tools return text content that can come back in several
 * shapes: a JSON object with a `databases` field, a top-level array, an
 * array of objects with `alias`/`name`, a JSON wrapper around a markdown
 * `context` blob, or just plain markdown. Each consumer was open-coding
 * their own parser and the duplicates were drifting — a fix in one route
 * could miss a sibling. This module consolidates the parsers so MCP
 * response-shape changes have one obvious place to update.
 */

/**
 * Pull a flat list of database names from the `list_databases` MCP
 * response. Tolerates: top-level JSON array, `{ databases: [...] }`,
 * objects with `alias`/`name`, and a plain-text fallback (`#`/`-`-prefixed
 * comment lines stripped).
 *
 * Returns an empty array on unrecognised shapes — the caller is
 * responsible for surfacing that as an error if it's not load-bearing.
 */
export function parseDatabaseNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.databases)
        ? parsed.databases
        : null;
    if (!list) {
      // `databases` field but not an array — pass through as-is when it
      // contains strings; preserves old behavior in app/api/databases/route.ts.
      if (parsed && Array.isArray(parsed.databases)) return parsed.databases;
      return [];
    }
    const names = (list as Array<unknown>).map((db) => {
      if (typeof db === 'string') return db;
      if (db && typeof db === 'object') {
        const d = db as { alias?: unknown; name?: unknown };
        if (typeof d.alias === 'string') return d.alias;
        if (typeof d.name === 'string') return d.name;
      }
      return '';
    });
    return names.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'));
  }
}

/**
 * Return the raw object array from `list_databases` when callers need
 * the full per-row metadata (alias, name, type, …). Returns `[]` on
 * non-array shapes or non-JSON responses.
 */
export function parseRawDatabases(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    if (parsed && Array.isArray(parsed.databases)) {
      return parsed.databases.filter((row: unknown): row is Record<string, unknown> => !!row && typeof row === 'object');
    }
  } catch {
    /* fall through */
  }
  return [];
}

export interface SchemaTable {
  schema: string;
  name: string;
  type: string;
  comment?: string;
  fragmentCount?: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  comment?: string;
  fragmentCount?: number;
}

/**
 * Parse `list_tables` MCP response. Tolerates both the JSON wrapper
 * (`{ success, tables: [...] }`) and a bare JSON array. Returns an empty
 * list on unparseable input — the caller should treat that as "no tables
 * loaded yet" rather than an error.
 */
export function parseTables(raw: string): SchemaTable[] {
  try {
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tables)
        ? parsed.tables
        : null;
    if (!list) return [];
    return (list as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(row => ({
        schema: typeof row.schema === 'string' ? row.schema : 'main',
        name: typeof row.name === 'string' ? row.name : '',
        type: typeof row.type === 'string' ? row.type : 'table',
        comment: typeof row.comment === 'string' ? row.comment : undefined,
        fragmentCount: extractFragmentCount(row.context),
      }))
      .filter(t => t.name);
  } catch {
    return [];
  }
}

/**
 * Parse `list_columns` MCP response into a list of columns.
 */
export function parseColumns(raw: string): SchemaColumn[] {
  try {
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.columns)
        ? parsed.columns
        : null;
    if (!list) return [];
    return (list as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(row => ({
        name: typeof row.name === 'string' ? row.name : '',
        type: typeof row.type === 'string' ? row.type : '',
        nullable: row.nullable !== false,
        comment: typeof row.comment === 'string' ? row.comment : undefined,
        fragmentCount: extractFragmentCount(row.context),
      }))
      .filter(c => c.name);
  } catch {
    return [];
  }
}

export interface DiveSummary {
  /** UUID — matches the `dive:UUID` reference format on fragments. */
  id: string;
  /** Human title; falls back to a short UUID slice when missing. */
  title: string;
  /** Database the dive lives in, when reported. */
  database?: string;
}

/**
 * Parse `list_dives` MCP response into a flat list. Tolerates the JSON
 * wrapper (`{ success, dives: [...] }`), a bare array, or an `items` key.
 * Used by `/api/dives` to surface dive metadata in the schema browser so
 * `dive:UUID` refs can render their human title instead of the bare UUID.
 */
export function parseDives(raw: string): DiveSummary[] {
  try {
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.dives)
        ? parsed.dives
        : Array.isArray(parsed?.items)
          ? parsed.items
          : null;
    if (!list) return [];
    return (list as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(row => {
        const id = typeof row.id === 'string'
          ? row.id
          : typeof row.dive_id === 'string'
            ? row.dive_id
            : typeof row.uuid === 'string'
              ? row.uuid
              : '';
        const title = typeof row.title === 'string' && row.title.length > 0
          ? row.title
          : typeof row.name === 'string' && row.name.length > 0
            ? row.name
            : '';
        const database = typeof row.database === 'string' ? row.database : undefined;
        return { id, title, database };
      })
      .filter(d => d.id);
  } catch {
    return [];
  }
}

export interface RelatedGuide {
  uuid: string;
  topic: string;
  title: string;
  description: string;
  access: string;
}

/**
 * Parse the `relatedGuides` field on a `list_tables` MCP response — guides
 * the server attests are about this database (via structured catalog
 * references), including the caller's private (`access: "user"`) guides.
 * Tolerates a missing/absent key. `topic` may legitimately be `''` (a
 * root-level guide); rows without a string `uuid` are dropped since there's
 * nothing to link to. Returns an empty list on unparseable input.
 */
export function parseRelatedGuides(raw: string): RelatedGuide[] {
  try {
    const parsed = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed?.relatedGuides) ? parsed.relatedGuides : null;
    if (!list) return [];
    return (list as Array<Record<string, unknown>>)
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map(row => ({
        uuid: typeof row.uuid === 'string' ? row.uuid : '',
        topic: typeof row.topic === 'string' ? row.topic : '',
        title: typeof row.title === 'string' ? row.title : '',
        description: typeof row.description === 'string' ? row.description : '',
        access: typeof row.access === 'string' ? row.access : '',
      }))
      .filter(g => g.uuid);
  } catch {
    return [];
  }
}

/**
 * The MCP `context` field is a freeform string like `"3 context fragments"`
 * or `"0 context fragments"`. Pull the leading integer out so we can use it
 * as a hint without trusting the exact phrasing.
 */
function extractFragmentCount(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.match(/^(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/**
 * MCP `query_context_layer` returns either a JSON wrapper `{ context: "<md>" }`
 * or the markdown body directly. Normalise to the markdown so downstream
 * parsers can do their job without each one re-implementing the unwrap.
 */
export function unwrapContextString(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.context === 'string') return parsed.context;
  } catch {
    /* not JSON — the response is already markdown */
  }
  return raw;
}
