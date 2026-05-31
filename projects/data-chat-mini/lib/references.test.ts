import { describe, it, expect } from 'vitest';
import { parseReference } from './references';

describe('parseReference', () => {
  it('parses plain db.schema.table', () => {
    expect(parseReference('mdw.main.foo')).toMatchObject({
      database: 'mdw', schema: 'main', table: 'foo', label: 'mdw.main.foo', isShare: false,
    });
  });

  it('strips the md: prefix', () => {
    expect(parseReference('md:nba.main.box_scores')).toMatchObject({
      database: 'nba', schema: 'main', table: 'box_scores', isShare: false,
    });
  });

  it('strips the database: typed prefix', () => {
    expect(parseReference('database:duckoffee.main.orders')).toMatchObject({
      database: 'duckoffee', schema: 'main', table: 'orders', label: 'duckoffee.main.orders',
    });
  });

  it('flags share paths and keeps the raw label', () => {
    const r = parseReference('md:_share/name/abc-123');
    expect(r.isShare).toBe(true);
    expect(r.table).toBeUndefined();
    expect(r.label).toBe('md:_share/name/abc-123');
  });

  it('tolerates a bare database name', () => {
    expect(parseReference('database:mydb')).toMatchObject({ database: 'mydb', table: undefined });
  });
});
