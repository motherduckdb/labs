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

  it('escapes Slack mrkdwn mention/link injection in body cells so they render inert', () => {
    const source = [
      '```table',
      JSON.stringify({
        type: 'table',
        columns: [{ id: 'note', title: 'Note' }],
        data: [
          { note: '<@U12345> please review' },
          { note: '<#C67890|general> channel' },
          { note: '<!here> urgent' },
          { note: '<!channel> all' },
          { note: '<https://evil.example|Click me>' },
        ],
      }),
      '```',
    ].join('\n');
    const md = tableBlockToMarkdown(source);
    expect(md).not.toBeNull();
    expect(md).not.toContain('<@U12345>');
    expect(md).not.toContain('<#C67890|general>');
    expect(md).not.toContain('<!here>');
    expect(md).not.toContain('<!channel>');
    expect(md).not.toContain('<https://evil.example|Click me>');
    expect(md).toContain('&lt;@U12345&gt;');
    // The pipe inside the mention is also a table-cell delimiter, so it gets
    // the existing backslash-escape treatment on top of entity-escaping.
    expect(md).toContain('&lt;#C67890\\|general&gt;');
    expect(md).toContain('&lt;!here&gt;');
    expect(md).toContain('&lt;!channel&gt;');
    expect(md).toContain('&lt;https://evil.example\\|Click me&gt;');
  });

  it('escapes ampersands and brackets in header cells too', () => {
    const source = [
      '```table',
      JSON.stringify({
        type: 'table',
        columns: [{ id: 'a', title: '<@U1> & <#C2>' }],
        data: [{ a: 'x' }],
      }),
      '```',
    ].join('\n');
    const md = tableBlockToMarkdown(source);
    expect(md).not.toBeNull();
    expect(md?.split('\n')[0]).toBe('| &lt;@U1&gt; &amp; &lt;#C2&gt; |');
  });

  it('escapes bare & before < / > so entities are not double-escaped', () => {
    const source = [
      '```table',
      JSON.stringify({
        type: 'table',
        columns: [{ id: 'a', title: 'A' }],
        data: [{ a: 'Tom & Jerry <script>' }],
      }),
      '```',
    ].join('\n');
    const md = tableBlockToMarkdown(source);
    expect(md).toContain('Tom &amp; Jerry &lt;script&gt;');
  });

  it('still escapes pipes and newlines alongside mrkdwn entities', () => {
    const source = [
      '```table',
      JSON.stringify({
        type: 'table',
        columns: [{ id: 'a', title: 'A' }],
        data: [{ a: 'a|b\nc <@U1>' }],
      }),
      '```',
    ].join('\n');
    const md = tableBlockToMarkdown(source);
    expect(md).toContain('a\\|b c &lt;@U1&gt;');
  });

  it('leaves plain cell content unchanged', () => {
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
});
