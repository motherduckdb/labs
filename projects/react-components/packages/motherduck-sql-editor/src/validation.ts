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
  // like `FROM allowed.s.t JOIN other.s.secret ...` slips through.
  const crossDbRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  for (const m of normalizedQuery.matchAll(crossDbRe)) {
    const referencedDb = m[1];
    if (referencedDb !== allowedUpper) {
      return {
        isValid: false,
        error: `Cross-database reference to '${referencedDb.toLowerCase()}' is not allowed`,
      };
    }
  }

  if (normalizedQuery.includes('DROP DATABASE') || normalizedQuery.includes('DROP SCHEMA')) {
    const dropMatch = normalizedQuery.match(/DROP\s+(DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/);
    if (dropMatch) {
      const targetDb = dropMatch[2].toLowerCase().replace(/['"]/g, '');
      if (targetDb !== allowedDatabase.toLowerCase()) {
        return createValidationError('DROP DATABASE');
      }
    }
  }

  if (normalizedQuery.includes('DELETE FROM')) {
    const deleteMatch = normalizedQuery.match(/DELETE\s+FROM\s+([^\s.]+\.)?([^\s.]+)\.([^\s;]+)/);
    if (deleteMatch) {
      const dbName = deleteMatch[2]?.toLowerCase();
      if (dbName && dbName !== allowedDatabase.toLowerCase()) {
        return { isValid: false, error: `DELETE on '${dbName}' is not allowed` };
      }
    }
  }

  if (normalizedQuery.includes('DROP TABLE')) {
    const m = normalizedQuery.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s.]+\.)?([^\s.]+)\.([^\s;]+)/);
    if (m) {
      const dbName = m[2]?.toLowerCase();
      if (dbName && dbName !== allowedDatabase.toLowerCase()) {
        return { isValid: false, error: `DROP TABLE on '${dbName}' is not allowed` };
      }
    }
  }

  if (normalizedQuery.includes('COPY')) {
    const m = normalizedQuery.match(/COPY\s+([^\s.]+\.)?([^\s.]+)\.([^\s;]+)/);
    if (m) {
      const dbName = m[2]?.toLowerCase();
      if (dbName && dbName !== allowedDatabase.toLowerCase()) {
        return { isValid: false, error: `COPY on '${dbName}' is not allowed` };
      }
    }
  }

  return { isValid: true };
}
