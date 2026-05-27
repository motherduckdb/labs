import { SecurityValidationResult } from './types';

const createValidationError = (operation: string): SecurityValidationResult => ({
  isValid: false,
  error: `${operation} operation is not allowed in the SQL editor`,
});

/**
 * Block queries that would escape the editor's scoped database. Used to keep an
 * embedded editor pinned to one database — strip or relax for trusted contexts.
 */
export function validateQuerySecurity(query: string, allowedDatabase: string): SecurityValidationResult {
  const normalizedQuery = query.trim().toUpperCase();
  const allowedUpper = allowedDatabase.toUpperCase();

  // Use \b...\s+ rather than substring checks so whitespace forms like
  // `USE\nother`, `ATTACH\tfoo`, `DETACH\nbar` are caught.
  if (/\bUSE\s+[^\s;]+/.test(normalizedQuery)) {
    return createValidationError('USE');
  }
  if (/\bATTACH\b/.test(normalizedQuery)) {
    return createValidationError('ATTACH');
  }
  if (/\bDETACH\b/.test(normalizedQuery)) {
    return createValidationError('DETACH');
  }

  // Scan EVERY three-part reference, not just the first — otherwise a query
  // like `FROM allowed.s.t JOIN other.s.secret ...` slips through. Each
  // identifier may also be double-quoted (e.g. `"other".main.secret`), so the
  // pattern accepts either bare or quoted forms and the comparison uses the
  // unquoted name.
  const ident = '(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))';
  const crossDbRe = new RegExp(`${ident}\\s*\\.\\s*${ident}\\s*\\.\\s*${ident}`, 'g');
  for (const m of normalizedQuery.matchAll(crossDbRe)) {
    // Groups: 1=quoted-db, 2=bare-db, 3=quoted-schema, 4=bare-schema, ...
    const referencedDb = m[1] ?? m[2];
    if (referencedDb && referencedDb !== allowedUpper) {
      return {
        isValid: false,
        error: `Cross-database reference to '${referencedDb.toLowerCase()}' is not allowed`,
      };
    }
  }

  // All keyword-pair guards use \s+ rather than substring includes() so
  // whitespace forms (`DROP\nDATABASE other`, `DELETE\tFROM other.s.t`) are
  // still caught — otherwise the early-exit would skip the regex entirely.
  const dropDbRe = /\bDROP\s+(DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/g;
  for (const m of normalizedQuery.matchAll(dropDbRe)) {
    const targetDb = m[2].replace(/['"]/g, '');
    if (targetDb !== allowedUpper) {
      return createValidationError('DROP DATABASE');
    }
  }

  const deleteRe = /\bDELETE\s+FROM\s+(?:[^\s.]+\.)?([^\s.]+)\.[^\s;]+/g;
  for (const m of normalizedQuery.matchAll(deleteRe)) {
    const dbName = m[1];
    if (dbName && dbName !== allowedUpper) {
      return { isValid: false, error: `DELETE on '${dbName.toLowerCase()}' is not allowed` };
    }
  }

  const dropTableRe = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:[^\s.]+\.)?([^\s.]+)\.[^\s;]+/g;
  for (const m of normalizedQuery.matchAll(dropTableRe)) {
    const dbName = m[1];
    if (dbName && dbName !== allowedUpper) {
      return { isValid: false, error: `DROP TABLE on '${dbName.toLowerCase()}' is not allowed` };
    }
  }

  const copyRe = /\bCOPY\s+(?:[^\s.]+\.)?([^\s.]+)\.[^\s;]+/g;
  for (const m of normalizedQuery.matchAll(copyRe)) {
    const dbName = m[1];
    if (dbName && dbName !== allowedUpper) {
      return { isValid: false, error: `COPY on '${dbName.toLowerCase()}' is not allowed` };
    }
  }

  return { isValid: true };
}
