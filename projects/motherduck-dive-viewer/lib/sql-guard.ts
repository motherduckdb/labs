/**
 * Read-only guard for SQL the Dive viewer sends to the query proxy.
 *
 * The user's MotherDuck token is read/write, so the proxy must refuse anything
 * that could mutate. A prefix check alone is insufficient — `EXPLAIN ANALYZE
 * <stmt>` executes its argument, and a mutation can hide inside a CTE/subquery
 * — so we require BOTH a read-only entry point AND the absence of any mutation
 * keyword anywhere. Errs safe: a mutation keyword inside a string literal
 * rejects the query rather than risk executing a write.
 */

// Must START with a read-only entry point. PRAGMA/EXPLAIN are excluded:
// PRAGMA can change session state; `EXPLAIN ANALYZE` runs its argument.
const READ_ONLY_START = /^(with|select|from|values|table|show|describe|desc|summarize)\b/i;

// Must contain NONE of these as a standalone word.
const MUTATION_WORD =
  /\b(insert|update|delete|drop|create|alter|attach|detach|copy|install|load|set|reset|call|pragma|truncate|merge|upsert|grant|revoke|vacuum|checkpoint|begin|start|commit|rollback|export|import|use)\b/i;

/** True only for a single read-only statement (no stacking, no mutations). */
export function isReadOnlySql(sql: string): boolean {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!s || s.includes(';')) return false; // no statement stacking
  if (/\bexplain\s+analyze\b/i.test(s)) return false; // EXPLAIN ANALYZE executes
  return READ_ONLY_START.test(s) && !MUTATION_WORD.test(s);
}
