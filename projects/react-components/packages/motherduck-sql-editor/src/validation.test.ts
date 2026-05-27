import { describe, expect, it } from 'vitest';
import { validateQuerySecurity } from './validation';

const ok = (query: string, db = 'allowed') => {
  const result = validateQuerySecurity(query, db);
  if (!result.isValid) {
    throw new Error(`expected to pass but was rejected: ${result.error} — query: ${query}`);
  }
};

const blocked = (query: string, db = 'allowed') => {
  const result = validateQuerySecurity(query, db);
  if (result.isValid) {
    throw new Error(`expected to be blocked but passed — query: ${query}`);
  }
  return result.error!;
};

describe('validateQuerySecurity — passes', () => {
  it('simple SELECT', () => ok('SELECT 1'));
  it('SELECT from unqualified table', () => ok('SELECT * FROM users'));
  it('SELECT from schema.table in active db', () => ok('SELECT * FROM main.users'));
  it('SELECT from allowed db (3-part)', () => ok('SELECT * FROM allowed.main.users'));
  it('SELECT with quoted allowed db', () => ok('SELECT * FROM "allowed".main.users'));
  it('DELETE on allowed db (3-part) is NOT rejected as cross-db', () =>
    ok('DELETE FROM allowed.main.users WHERE id = 1'));
  it('DELETE on 2-part (schema.table) in active db is NOT treated as cross-db', () =>
    ok("DELETE FROM main.users WHERE id = 1"));
  it('DROP TABLE on allowed db', () => ok('DROP TABLE allowed.main.users'));
  it('DROP TABLE on 2-part in active db', () => ok('DROP TABLE main.users'));
  it('COPY on allowed db', () => ok("COPY allowed.main.users TO 'out.csv'"));
  it('DROP DATABASE on allowed db', () => ok('DROP DATABASE allowed'));
  it('case-insensitive db match', () => ok('SELECT * FROM ALLOWED.main.users'));
  it('whitespace variations in SELECT do not trip guards', () =>
    ok('SELECT\n*\nFROM\nallowed.main.users'));
});

describe('validateQuerySecurity — USE/ATTACH/DETACH blocked', () => {
  it('USE other', () => expect(blocked('USE other')).toMatch(/USE/));
  it('USE\\nother (newline)', () => expect(blocked('USE\nother')).toMatch(/USE/));
  it('USE\\tother (tab)', () => expect(blocked('USE\tother')).toMatch(/USE/));
  it("ATTACH 'foo' AS bar", () => expect(blocked("ATTACH 'foo' AS bar")).toMatch(/ATTACH/));
  it('ATTACH with leading newline', () => expect(blocked("ATTACH\n'foo' AS bar")).toMatch(/ATTACH/));
  it('DETACH foo', () => expect(blocked('DETACH foo')).toMatch(/DETACH/));
  it('DETACH\\nfoo', () => expect(blocked('DETACH\nfoo')).toMatch(/DETACH/));
});

describe('validateQuerySecurity — cross-db references blocked', () => {
  it('bare cross-db SELECT', () =>
    expect(blocked('SELECT * FROM other.main.secret')).toMatch(/other/));
  it('quoted cross-db SELECT', () =>
    expect(blocked('SELECT * FROM "other".main.secret')).toMatch(/other/));
  it('SECOND reference is cross-db (first is allowed)', () =>
    expect(blocked('SELECT * FROM allowed.s.t JOIN other.s.secret ON true')).toMatch(/other/));
  it('mixed quoted/bare with cross-db second ref', () =>
    expect(blocked('SELECT * FROM "allowed".s.t JOIN "other".s.x ON true')).toMatch(/other/));
});

describe('validateQuerySecurity — destructive cross-db ops blocked', () => {
  // For DROP DATABASE/SCHEMA the error message comes from the destructive
  // guard. For the 3-part forms (DELETE/DROP TABLE/COPY), the earlier
  // cross-db scan catches them first — either path is acceptable; we just
  // assert the query is rejected.
  it('DROP DATABASE other', () =>
    expect(blocked('DROP DATABASE other')).toMatch(/DROP DATABASE/));
  it('DROP\\nDATABASE other (newline between keywords)', () =>
    expect(blocked('DROP\nDATABASE other')).toMatch(/DROP DATABASE/));
  it('DROP SCHEMA other', () =>
    expect(blocked('DROP SCHEMA other')).toMatch(/DROP DATABASE/));
  it('DELETE FROM other.s.t', () => blocked('DELETE FROM other.main.t WHERE 1=1'));
  it('DELETE\\nFROM other.s.t', () => blocked('DELETE\nFROM other.main.t WHERE 1=1'));
  it('DROP TABLE other.s.t', () => blocked('DROP TABLE other.main.t'));
  it('DROP TABLE IF EXISTS other.s.t', () => blocked('DROP TABLE IF EXISTS other.main.t'));
  it('COPY other.s.t TO file', () => blocked("COPY other.main.t TO 'out.csv'"));
});
