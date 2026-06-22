/**
 * table-spec — a table NAME plays three distinct roles: a physical DuckDB
 * reference (DESCRIBE/FROM/duckdb.table), a Malloy source identifier
 * (`<name>_base`), and a filesystem stem (`<name>_base.malloy`). Conflating them
 * breaks generic callers (hyphens `order-items`, spaces `user events`,
 * schema-qualified `main.sales_orders`, reserved words, case-sensitive/quoted
 * names). A TableSpec separates the physical `ref` (auto-quoted for SQL, used
 * verbatim inside `duckdb.table('<ref>')`) from a safe `name` (the Malloy /
 * _meta / file identifier).
 *
 * Its own module so both layer-build and glossary can use it without a cycle.
 */

export interface TableSpec {
  /** physical DuckDB reference, optionally schema-qualified, any characters —
   *  used in DESCRIBE/FROM (auto-quoted) and inside duckdb.table('<ref>'). */
  ref: string;
  /** safe identifier for the `<name>_base` source, file stem, and _meta. Must
   *  match /^[A-Za-z_]\w*$/. Defaults to a sanitized form of ref's last segment. */
  name?: string;
}
export type TableInput = string | TableSpec;
export interface NormTable { ref: string; name: string; quoted: string }

/** Quote a (possibly schema-qualified) DuckDB reference for safe SQL use:
 *  `main.sales_orders` → `"main"."sales_orders"`, `order-items` → `"order-items"`.
 *  A ref the caller already quoted (contains a ") is used verbatim. */
export function quoteDuckRef(ref: string): string {
  if (ref.includes('"')) return ref;
  return ref.split('.').map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
}

/** Derive a safe Malloy/file identifier from a table ref: its last dotted
 *  segment, non-identifier chars → '_', a leading digit '_'-prefixed. */
export function safeTableName(ref: string): string {
  const seg = ref.split('.').pop() ?? ref;
  let n = seg.replace(/"/g, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

/** Normalize TableInput[] to {ref, name, quoted}, validating each `name` is a
 *  legal Malloy identifier and that names don't collide (which would clobber a
 *  `<name>_base` file). Throws a clear, actionable error otherwise. */
export function normalizeTables(tables: TableInput[]): NormTable[] {
  const out: NormTable[] = [];
  const seen = new Map<string, string>(); // name -> ref
  for (const t of tables) {
    const ref = typeof t === 'string' ? t : t.ref;
    const name = (typeof t === 'string' ? undefined : t.name) ?? safeTableName(ref);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Table "${ref}" → invalid Malloy identifier "${name}". Pass an explicit { ref, name } whose name matches /^[A-Za-z_]\\w*$/.`);
    }
    if (seen.has(name)) {
      throw new Error(`Tables "${seen.get(name)}" and "${ref}" both map to the Malloy identifier "${name}". Disambiguate with an explicit { ref, name }.`);
    }
    seen.set(name, ref);
    out.push({ ref, name, quoted: quoteDuckRef(ref) });
  }
  return out;
}
