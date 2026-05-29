import { describe, it, expect } from 'vitest';
import { isReadOnlySql } from './sql-guard';

describe('isReadOnlySql', () => {
  it('allows ordinary read queries', () => {
    expect(isReadOnlySql('SELECT * FROM t')).toBe(true);
    expect(isReadOnlySql('  select a, b from t where x = 1  ')).toBe(true);
    expect(isReadOnlySql('WITH c AS (SELECT 1) SELECT * FROM c')).toBe(true);
    expect(isReadOnlySql('FROM t SELECT *')).toBe(true);
    expect(isReadOnlySql('SELECT count(*) FROM t;')).toBe(true); // trailing ; trimmed
  });

  it('rejects statement stacking', () => {
    expect(isReadOnlySql('SELECT 1; DROP TABLE t')).toBe(false);
  });

  it('rejects EXPLAIN ANALYZE (it executes its argument)', () => {
    expect(isReadOnlySql('EXPLAIN ANALYZE DELETE FROM t')).toBe(false);
    expect(isReadOnlySql('explain analyze insert into t values (1)')).toBe(false);
  });

  it('rejects mutations, including ones hidden behind a read-only prefix', () => {
    expect(isReadOnlySql('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadOnlySql('UPDATE t SET x = 1')).toBe(false);
    expect(isReadOnlySql('DELETE FROM t')).toBe(false);
    expect(isReadOnlySql('DROP TABLE t')).toBe(false);
    expect(isReadOnlySql('ATTACH \'md:_share/x\' AS x')).toBe(false);
    expect(isReadOnlySql('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toBe(false);
    expect(isReadOnlySql('PRAGMA database_list')).toBe(false);
  });

  it('rejects empty / non-read entry points', () => {
    expect(isReadOnlySql('')).toBe(false);
    expect(isReadOnlySql('   ')).toBe(false);
    expect(isReadOnlySql('CALL foo()')).toBe(false);
  });
});
