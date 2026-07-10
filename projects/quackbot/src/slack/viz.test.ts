import { describe, expect, it } from 'vitest';
import { classifyMvizBlock, tableBlockToMarkdown } from './viz';

const tableSource = [
  '```table size=[16,4]',
  JSON.stringify({
    type: 'table',
    columns: [
      { id: 'product', title: 'Product' },
      { id: 'sales', title: 'Sales' },
    ],
    data: [
      { product: 'Widget', sales: 125000 },
      { product: 'Gadget', sales: 98000 },
    ],
  }),
  '```',
].join('\n');

const barSource = [
  '```bar size=[8,4]',
  JSON.stringify({ type: 'bar', data: [{ x: 'Jan', y: 10 }], x: 'x', y: 'y' }),
  '```',
].join('\n');

describe('classifyMvizBlock', () => {
  it('classifies a table block as table', () => {
    expect(classifyMvizBlock(tableSource)).toBe('table');
  });

  it('classifies bar/line/dumbbell blocks as chart', () => {
    expect(classifyMvizBlock(barSource)).toBe('chart');
    expect(classifyMvizBlock('```line size=[8,4]\n{"type":"line"}\n```')).toBe('chart');
    expect(classifyMvizBlock('```dumbbell size=[12,6]\n{"type":"dumbbell"}\n```')).toBe('chart');
  });

  it('classifies a mixed table+chart source as chart', () => {
    const mixed = `${tableSource}\n${barSource}`;
    expect(classifyMvizBlock(mixed)).toBe('chart');
  });
});

describe('tableBlockToMarkdown', () => {
  it('renders a GitHub markdown table for a table spec', () => {
    const md = tableBlockToMarkdown(tableSource);
    expect(md).toBe(
      [
        '| Product | Sales |',
        '| --- | --- |',
        '| Widget | 125000 |',
        '| Gadget | 98000 |',
      ].join('\n')
    );
  });

  it('handles the columnar {columns: string[], rows: unknown[][]} shape', () => {
    const source = [
      '```table',
      JSON.stringify({ type: 'table', columns: ['a', 'b'], rows: [[1, 2], [3, 4]] }),
      '```',
    ].join('\n');
    expect(tableBlockToMarkdown(source)).toBe(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n')
    );
  });

  it('caps at 30 rows and appends a truncation note', () => {
    const data = Array.from({ length: 35 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const source = [
      '```table',
      JSON.stringify({
        type: 'table',
        columns: [
          { id: 'id', title: 'ID' },
          { id: 'name', title: 'Name' },
        ],
        data,
      }),
      '```',
    ].join('\n');
    const md = tableBlockToMarkdown(source);
    expect(md).not.toBeNull();
    expect(md).toContain('_…5 more rows_');
    expect(md).not.toContain('row-30'); // rows 30..34 are the truncated ones
    // header + separator + 30 rows = 32 pipe-delimited lines
    expect(md?.split('\n').filter((l) => l.startsWith('|')).length).toBe(32);
  });

  it('returns null for a non-table (chart) block', () => {
    expect(tableBlockToMarkdown(barSource)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const malformed = '```table\n{not valid json\n```';
    expect(tableBlockToMarkdown(malformed)).toBeNull();
  });

  it('returns null when columns/data are missing', () => {
    const noColumns = '```table\n{"type":"table"}\n```';
    expect(tableBlockToMarkdown(noColumns)).toBeNull();
  });
});
