import { describe, expect, it } from 'vitest';
import { toMarkdownBlocks, toMrkdwn } from './markdown';

describe('toMarkdownBlocks', () => {
  it('returns a single block for short text', () => {
    const blocks = toMarkdownBlocks('hello world');
    expect(blocks).toEqual([{ type: 'markdown', text: 'hello world' }]);
  });

  it('returns nothing for empty text', () => {
    expect(toMarkdownBlocks('')).toEqual([]);
  });

  it('packs multiple paragraphs into one block when they fit', () => {
    const text = 'para one\n\npara two\n\npara three';
    const blocks = toMarkdownBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(text);
  });

  it('splits into multiple blocks on paragraph boundaries when over the limit', () => {
    const paragraph = 'x'.repeat(7000);
    const text = [paragraph, paragraph, paragraph].join('\n\n');
    const blocks = toMarkdownBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.type).toBe('markdown');
      expect(block.text.length).toBeLessThanOrEqual(12_000);
    }
    // Rejoining recovers the paragraphs (each own block here, none merged).
    expect(blocks.map((b) => b.text)).toEqual([paragraph, paragraph, paragraph]);
  });

  it('hard-splits a single paragraph that exceeds the limit on its own', () => {
    const huge = 'y'.repeat(30_000);
    const blocks = toMarkdownBlocks(huge);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.text.length).toBeLessThanOrEqual(12_000);
    }
    expect(blocks.map((b) => b.text).join('')).toBe(huge);
  });
});

describe('toMrkdwn', () => {
  it('converts bold', () => {
    expect(toMrkdwn('this is **bold** text')).toBe('this is *bold* text');
  });

  it('converts italic (asterisk and underscore forms)', () => {
    expect(toMrkdwn('this is *italic*')).toBe('this is _italic_');
    expect(toMrkdwn('this is _italic_')).toBe('this is _italic_');
  });

  it('converts links', () => {
    expect(toMrkdwn('see [the docs](https://example.com/docs)')).toBe(
      'see <https://example.com/docs|the docs>'
    );
  });

  it('converts headings to a standalone bold line', () => {
    expect(toMrkdwn('# Big Heading')).toBe('*Big Heading*');
    expect(toMrkdwn('### Smaller Heading')).toBe('*Smaller Heading*');
  });

  it('converts a hyphen list to bullets', () => {
    expect(toMrkdwn('- one\n- two\n  - nested')).toBe('• one\n• two\n  • nested');
  });

  it('keeps fenced code blocks verbatim, untouched by other conversions', () => {
    const input = 'before\n\n```js\nconst x = **not bold**;\n```\n\nafter';
    const result = toMrkdwn(input);
    expect(result).toContain('```js\nconst x = **not bold**;\n```');
  });

  it('converts a markdown table into an aligned code-block', () => {
    const input = '| Name | Score |\n| --- | --- |\n| Alice | 10 |\n| Bob | 2 |';
    const result = toMrkdwn(input);
    expect(result.startsWith('```\n')).toBe(true);
    expect(result.endsWith('\n```')).toBe(true);
    expect(result).toContain('Name');
    expect(result).toContain('Alice');
    // Header/separator/rows are all aligned to the same column width.
    const lines = result.split('\n').filter((l) => l !== '```');
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('combines bold, links, and lists in one pass', () => {
    const input = '- **Important**: read [the guide](https://example.com)';
    expect(toMrkdwn(input)).toBe('• *Important*: read <https://example.com|the guide>');
  });
});
