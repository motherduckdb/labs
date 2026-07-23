/**
 * Convert GitHub-flavored markdown (the model's native output) into Slack
 * surfaces: native `markdown` Block Kit blocks (preferred) and a legacy
 * mrkdwn fallback for surfaces that don't support the markdown block type.
 */

/** Slack's `markdown` block type caps `text` at 12,000 chars. */
const MARKDOWN_BLOCK_LIMIT = 12_000;

export interface SlackMarkdownBlock {
  type: 'markdown';
  text: string;
}

/**
 * Split `text` into one or more Slack `markdown` blocks, none exceeding the
 * block's char limit. Splits on paragraph boundaries (blank lines) where
 * possible; a single paragraph longer than the limit is hard-split on line
 * breaks, and a single line longer than the limit is hard-sliced.
 */
export function toMarkdownBlocks(text: string): SlackMarkdownBlock[] {
  return chunkMarkdown(text, MARKDOWN_BLOCK_LIMIT).map((chunk) => ({
    type: 'markdown' as const,
    text: chunk,
  }));
}

function chunkMarkdown(text: string, limit: number): string[] {
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    for (const part of splitOversizedParagraph(paragraph, limit)) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= limit) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = part.length <= limit ? part : '';
        if (part.length > limit) {
          // Shouldn't happen -- splitOversizedParagraph already hard-slices --
          // but guard defensively rather than emit an oversized block.
          chunks.push(...hardSlice(part, limit));
          current = '';
        }
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];

  const lines = paragraph.split('\n');
  const parts: string[] = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (line.length > limit) {
      parts.push(...hardSlice(line, limit));
      current = '';
    } else {
      current = line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function hardSlice(text: string, limit: number): string[] {
  const slices: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    slices.push(text.slice(i, i + limit));
  }
  return slices;
}

/**
 * Fallback conversion to legacy Slack mrkdwn, for surfaces that don't accept
 * the native `markdown` block type.
 *
 * Fenced code blocks, bold runs, and headings are pulled out into plain-ASCII
 * placeholder tokens before the other regex passes run, then restored at the
 * end -- otherwise the italic pass (which turns a lone `*text*` into
 * `_text_`) would also mangle the single asterisks that bold and headings
 * leave behind.
 */
export function toMrkdwn(text: string): string {
  const codeBlocks: string[] = [];
  let working = (text ?? '').replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `@@CODE${codeBlocks.length - 1}@@`;
  });

  working = convertTables(working);

  // Lists: "- item" -> "bullet item" (preserve leading indentation).
  working = working.replace(/^(\s*)-\s+/gm, '$1• ');

  // Links: [label](url) -> <url|label>.
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>');

  // Bold **text** -> placeholder, restored to Slack bold *text* at the end.
  const boldRuns: string[] = [];
  working = working.replace(/\*\*([^*]+?)\*\*/g, (_m, inner: string) => {
    boldRuns.push(inner);
    return `@@BOLD${boldRuns.length - 1}@@`;
  });

  // Italic *text* or _text_ -> Slack italic _text_.
  working = working.replace(/\*([^*\n]+?)\*/g, '_$1_');
  working = working.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '_$1_');

  // Headings: "# Heading" -> "*Heading*" on its own line. Placeholder-protected
  // and restored after the italic pass above, so its own single asterisks
  // don't get re-mangled into underscores.
  const headingRuns: string[] = [];
  working = working.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, heading: string) => {
    headingRuns.push(heading.trim());
    return `@@HEADING${headingRuns.length - 1}@@`;
  });

  working = working.replace(/@@BOLD(\d+)@@/g, (_m, idx: string) => `*${boldRuns[Number(idx)]}*`);
  working = working.replace(/@@HEADING(\d+)@@/g, (_m, idx: string) => `*${headingRuns[Number(idx)]}*`);
  working = working.replace(/@@CODE(\d+)@@/g, (_m, idx: string) => codeBlocks[Number(idx)]);

  return working;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** Convert GFM markdown tables into aligned, monospaced text in a code block. */
function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && isTableDelimiterRow(next)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      result.push(renderAsciiTable(header, rows));
      i = j;
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function renderAsciiTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, idx) => Math.max(h.length, ...rows.map((r) => (r[idx] ?? '').length)));
  const renderRow = (cells: string[]) => cells.map((c, idx) => (c ?? '').padEnd(widths[idx])).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-|-');
  const lines = [renderRow(header), separator, ...rows.map(renderRow)];
  return '```\n' + lines.join('\n') + '\n```';
}
