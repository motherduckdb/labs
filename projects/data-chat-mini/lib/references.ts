/**
 * Parse a context-fragment reference string into its catalog parts.
 *
 * Handles the formats the model emits / MotherDuck uses:
 *   - `db.main.table`              (plain)
 *   - `md:db.main.table`           (md: protocol prefix)
 *   - `database:db.main.table`     (typed prefix)
 *   - `md:_share/name/uuid/...`    (share path — no table parts)
 */
export interface ParsedRef {
  database?: string;
  schema?: string;
  table?: string;
  /** Human-readable label, e.g. "db.main.table" or the raw share path. */
  label: string;
  /** True for `_share/...` paths we can't decompose into db.schema.table. */
  isShare: boolean;
}

export function parseReference(ref: string): ParsedRef {
  const raw = ref.trim();
  const stripped = raw.replace(/^database:/i, '').replace(/^md:/i, '');

  if (stripped.startsWith('_share/')) {
    return { label: raw, isShare: true };
  }

  const parts = stripped.split('.').filter(Boolean);
  const [database, schema, table] = parts;
  const label = parts.length ? parts.join('.') : raw;
  return { database, schema, table, label, isShare: false };
}
