import { parseMarkdownToDashboard, lintSpec, SpecValidationError } from 'mviz';

// mviz embed mode (parseMarkdownToDashboard's embedOverride, see below) already
// strips the page chrome — the red accent bar (.red-line), the "Dashboard"
// title row (.page-title), and the theme toggle — so we no longer hand-hide
// them here. What remains is purely mdw-turbo branding: the Inter typeface,
// our type scale, and the orange (#FF9538) accent that overrides mviz's red.
const CUSTOM_CSS_OVERRIDES = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  /* Kill the browser default body margin so the frame hugs its host card. */
  html, body { margin: 0 !important; }
  .dashboard {
    max-width: 100% !important;
    padding: 20px !important;
  }
  .dashboard-section:last-child {
    margin-bottom: 0 !important;
    padding-bottom: 0 !important;
  }
  .row:last-child {
    margin-bottom: 0 !important;
  }
  html, body, .dashboard, .page-title, .section-title, .chart-title,
  .big-value, .label, .delta, .data-table, .note-content, .text-content,
  .markdown-content, .alert, h1, h2, h3, h4, h5, h6, p, span, div {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
  }
  html, body { font-size: 14px !important; }
  .section-title { font-size: 18px !important; }
  .chart-title { font-size: 16px !important; }
  .big-value { font-size: 40px !important; }
  .label { font-size: 13px !important; }
  .delta { font-size: 24px !important; }
  .delta .value { font-size: 24px !important; }
  .delta .arrow { font-size: 24px !important; }
  .delta .label { font-size: 14px !important; }
  .row { gap: 12px !important; margin-bottom: 12px !important; }
  .alert .message { font-size: 13px !important; }
  .data-table th, .data-table td { font-size: 12px !important; padding: 8px 12px !important; }
  .note-content, .text-content { font-size: 13px !important; line-height: 1.5 !important; }
  .markdown-content { font-size: 14px !important; line-height: 1.6 !important; }
  .markdown-content h1 { font-size: 28px !important; }
  .markdown-content h2 { font-size: 22px !important; }
  .markdown-content h3 { font-size: 18px !important; }
  .markdown-content p, .markdown-content li { font-size: 14px !important; }
  .markdown-content code { font-size: 13px !important; }
  /* Override mviz's red accent to mdw-turbo orange (chart series, deltas,
     heatmap negatives). The .red-line top bar itself is stripped by embed mode. */
  :root { --red: #FF9538 !important; }
</style>
`;

/** Script injected into mviz iframes to report their content height via postMessage.
 * This avoids needing allow-same-origin on the iframe sandbox. */
const HEIGHT_REPORTER_SCRIPT = `
<script>
(function() {
  function reportHeight() {
    var h = document.body ? document.body.scrollHeight : 0;
    if (h > 0) parent.postMessage({ type: 'mviz-height', height: h }, '*');
  }
  if (document.readyState === 'complete') reportHeight();
  else window.addEventListener('load', reportHeight);
  new MutationObserver(reportHeight).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(reportHeight, 300);
  setTimeout(reportHeight, 1000);
})();
<\/script>
`;

function injectCssOverrides(html: string): string {
  let result = html;

  // Inject CSS into <head>
  const headCloseIndex = result.indexOf('</head>');
  if (headCloseIndex !== -1) {
    result = result.slice(0, headCloseIndex) + CUSTOM_CSS_OVERRIDES + result.slice(headCloseIndex);
  } else {
    result = CUSTOM_CSS_OVERRIDES + result;
  }

  // Inject height reporter before </body> (or at end)
  const bodyCloseIndex = result.indexOf('</body>');
  if (bodyCloseIndex !== -1) {
    result = result.slice(0, bodyCloseIndex) + HEIGHT_REPORTER_SCRIPT + result.slice(bodyCloseIndex);
  } else {
    result += HEIGHT_REPORTER_SCRIPT;
  }

  return result;
}

function sanitizeMvizMarkdown(markdown: string): string {
  return markdown.replace(
    /```(big_value|bar|line|table|sparkline|text|note|alert|textarea|delta|area|pie|scatter|heatmap|waterfall|funnel|sankey|boxplot|histogram|calendar|combo|dumbbell|xmr|pct_bar|donut)([^\n]*)\n([\s\S]*?)```/g,
    (match, chartType, sizeSpec, jsonContent) => {
      try {
        const parsed = JSON.parse(jsonContent.trim());

        const sanitize = (obj: unknown): unknown => {
          if (obj === null || obj === undefined) return '';
          if (Array.isArray(obj)) return obj.map(sanitize);
          if (typeof obj === 'object') {
            return Object.entries(obj as Record<string, unknown>).reduce((acc, [key, value]) => {
              acc[key] = sanitize(value);
              return acc;
            }, {} as Record<string, unknown>);
          }
          return obj;
        };

        let sanitized = sanitize(parsed) as Record<string, unknown>;

        if (chartType === 'table' && sanitized.columns && sanitized.data) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const columns = sanitized.columns as Array<Record<string, any>>;
          const data = sanitized.data as Array<Record<string, unknown>>;
          const transformedColumns = columns.map(col => ({
            ...col,
            id: col.id ?? col.key,
            title: col.title ?? col.label,
          }));
          const columnIds = transformedColumns.map(c => c.id).filter(Boolean);
          const sanitizedData = data.map(row => {
            const newRow: Record<string, unknown> = { ...row };
            columnIds.forEach(id => {
              if (newRow[id] === undefined || newRow[id] === null) newRow[id] = '';
            });
            return newRow;
          });
          sanitized = { ...sanitized, columns: transformedColumns, data: sanitizedData };
        }

        return `\`\`\`${chartType}${sizeSpec}\n${JSON.stringify(sanitized)}\n\`\`\``;
      } catch {
        return match;
      }
    }
  );
}

const MVIZ_TYPES_PATTERN = 'big_value|bar|line|table|sparkline|text|note|alert|textarea|delta|area|pie|scatter|heatmap|waterfall|funnel|sankey|boxplot|histogram|calendar|combo|dumbbell|xmr|pct_bar|donut';

// Default widths per chart type (from mviz docs)
const DEFAULT_WIDTHS: Record<string, number> = {
  big_value: 4, delta: 4, sparkline: 4, empty_space: 4,
  bar: 8, line: 8, area: 8, pie: 8, scatter: 8, bubble: 8,
  funnel: 8, sankey: 8, heatmap: 8, histogram: 8, boxplot: 8,
  waterfall: 8, combo: 8, mermaid: 8,
  dumbbell: 12,
  table: 16, textarea: 16, calendar: 16, xmr: 16,
  alert: 16, note: 16, text: 16,
};

function getBlockWidth(header: string): number {
  const sizeMatch = header.match(/size=\[(\d+)/);
  if (sizeMatch) return parseInt(sizeMatch[1], 10);
  // Extract chart type and use default
  const typeMatch = header.match(new RegExp('(' + MVIZ_TYPES_PATTERN + ')'));
  if (typeMatch) return DEFAULT_WIDTHS[typeMatch[1]] ?? 8;
  return 16; // assume full width if unknown
}

/**
 * Smart row packing: collapse blank lines between adjacent mviz blocks
 * only when they fit on the same row (cumulative width ≤ 16 columns).
 */
function packRows(markdown: string): string {
  // Split into blocks and gaps. A "block" is a ```type ... ``` section.
  const blockRe = new RegExp('(```(?:' + MVIZ_TYPES_PATTERN + ')[^\\n]*\\n[\\s\\S]*?```)', 'g');
  const parts: Array<{ type: 'block'; content: string; width: number } | { type: 'gap'; content: string }> = [];

  let lastIndex = 0;
  let match;
  while ((match = blockRe.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'gap', content: markdown.slice(lastIndex, match.index) });
    }
    const header = match[1].split('\n')[0];
    parts.push({ type: 'block', content: match[1], width: getBlockWidth(header) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < markdown.length) {
    parts.push({ type: 'gap', content: markdown.slice(lastIndex) });
  }

  // Now rebuild: collapse gaps between blocks when they'd fit on one row
  let result = '';
  let rowWidth = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.type === 'block') {
      if (rowWidth > 0 && rowWidth + part.width <= 16) {
        // Fits on current row — join directly (no blank line)
        result += '\n';
      } else {
        // New row — keep any preceding gap as-is, reset row width
        rowWidth = 0;
      }
      result += part.content;
      rowWidth += part.width;
    } else {
      // Gap (non-block content: blank lines, headings, text between blocks)
      const isBlankOnly = /^\s*$/.test(part.content);
      if (isBlankOnly) {
        // Check if next part is a block that fits on the current row
        const next = parts[i + 1];
        if (next?.type === 'block' && rowWidth > 0 && rowWidth + next.width <= 16) {
          // Skip the blank gap — we'll join the blocks
          continue;
        }
        // Otherwise keep the gap (forces new row)
        result += part.content;
        rowWidth = 0;
      } else {
        // Non-blank content (headings, prose) — keep as-is, reset row
        result += part.content;
        rowWidth = 0;
      }
    }
  }

  return result;
}

export function processMvizMarkdown(markdown: string, theme = 'light'): string {
  const packed = packRows(markdown);
  const sanitizedMarkdown = sanitizeMvizMarkdown(packed);
  // embedOverride (8th arg, mviz ^1.7.0): strips page chrome (red accent bar,
  // title row, theme toggle), prunes unused CSS/CDN scripts, and minifies for
  // iframe embedding — the rendering path these tiles live in. Replaces the
  // manual chrome-stripping we used to carry in CUSTOM_CSS_OVERRIDES.
  const result = parseMarkdownToDashboard(
    sanitizedMarkdown,
    theme,
    undefined,
    false,
    false,
    undefined,
    'generate',
    true,
  );
  return injectCssOverrides(result.html);
}

export function hasMvizBlocks(content: string): boolean {
  return /```(big_value|bar|line|table|sparkline|text|note|alert|textarea|delta|area|pie|scatter|heatmap|waterfall|funnel|sankey|boxplot|histogram|calendar|combo|dumbbell|xmr|pct_bar|donut)\b/.test(content);
}

export interface LintResult {
  pass: boolean;
  errors: string[];
}

/**
 * Lint mviz markdown blocks. Returns errors found.
 * Extracts each JSON spec from code blocks and runs lintSpec on each.
 */
export function lintMvizMarkdown(markdown: string): LintResult {
  const errors: string[] = [];
  const blockRe = /```(big_value|bar|line|table|sparkline|text|note|alert|textarea|delta|area|pie|scatter|heatmap|waterfall|funnel|sankey|boxplot|histogram|calendar|combo|dumbbell|xmr|pct_bar|donut)[^\n]*\n([\s\S]*?)```/g;

  let match;
  let blockIndex = 0;
  while ((match = blockRe.exec(markdown)) !== null) {
    blockIndex++;
    const chartType = match[1];
    const jsonContent = match[2].trim();

    try {
      const spec = JSON.parse(jsonContent);
      // Ensure type is set for linting
      if (!spec.type) spec.type = chartType;
      lintSpec(spec);
    } catch (err) {
      if (err instanceof SpecValidationError) {
        errors.push(`Block ${blockIndex} (${chartType}): ${err.message}`);
      } else if (err instanceof SyntaxError) {
        errors.push(`Block ${blockIndex} (${chartType}): Invalid JSON — ${err.message}`);
      } else {
        errors.push(`Block ${blockIndex} (${chartType}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { pass: errors.length === 0, errors };
}
