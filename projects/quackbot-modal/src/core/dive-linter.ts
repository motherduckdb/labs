/**
 * In-memory ESLint pass over Dive source — advisory feedback to the LLM
 * after save_dive/update_dive/edit_dive_content. Only the `react-hooks`
 * plugin is loaded, so we catch conditional hook calls and missing effect
 * deps without hauling in the app's own lint config. The Linter instance
 * is module-level so the cost is paid once per warm function instance.
 *
 * Scope: advisory only. Violations are appended to the tool result so the
 * model can self-correct. They never block the save.
 */

import { Linter } from 'eslint';
// eslint-plugin-react-hooks has no types shipped; the ESLint Linter.verify
// config just needs `rules` and `meta` on each plugin entry.
import reactHooksPlugin from 'eslint-plugin-react-hooks';

const linter = new Linter();

const DIVE_LINT_CONFIG = {
  files: ['**/*.{js,jsx}'],
  plugins: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    'react-hooks': reactHooksPlugin as any,
  },
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
  languageOptions: {
    ecmaVersion: 'latest' as const,
    sourceType: 'module' as const,
    parserOptions: {
      ecmaVersion: 'latest' as const,
      sourceType: 'module' as const,
      ecmaFeatures: { jsx: true },
    },
  },
} satisfies Linter.Config;

export interface DiveLintResult {
  violations: Array<{ rule: string; line: number; message: string; severity: 'warning' | 'error' }>;
}

/**
 * Lint a Dive source string against the react-hooks rule set. Returns the
 * list of violations (may be empty). A parse error yields an empty result —
 * the compiled Dive will surface its own syntax error at render time, so
 * there's no need to double-report here.
 */
export function lintDiveSource(source: string): DiveLintResult {
  if (!source || typeof source !== 'string') {
    return { violations: [] };
  }
  let messages;
  try {
    messages = linter.verify(source, DIVE_LINT_CONFIG, { filename: 'dive.jsx' });
  } catch {
    return { violations: [] };
  }
  const violations = messages
    .filter(m => m.ruleId && m.ruleId.startsWith('react-hooks/'))
    .map(m => ({
      rule: m.ruleId!,
      line: m.line ?? 0,
      message: m.message,
      severity: m.severity === 2 ? ('error' as const) : ('warning' as const),
    }));
  return { violations };
}

/**
 * Format lint violations as a short advisory block appended to the tool
 * result. Returned string is empty when there are no violations.
 */
export function formatLintAdvisory(result: DiveLintResult): string {
  if (result.violations.length === 0) return '';
  const lines = result.violations.map(v =>
    `  - [${v.severity}] line ${v.line} (${v.rule}): ${v.message}`
  );
  return [
    '',
    '--- Dive lint (react-hooks) ---',
    'The Dive saved, but the linter flagged the following issues. Consider fixing them before the user views the Dive:',
    ...lines,
  ].join('\n');
}

/**
 * Best-effort extraction of Dive source from a save/update/edit tool call.
 * save_dive and update_dive carry the source in `args.content`.
 * edit_dive_content applies a string replacement, so we return null — there's
 * no full-source view without re-reading the dive, which we skip for v1.
 * Returns null when the source isn't available or isn't a string.
 */
export function extractDiveSourceForLint(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'save_dive' && toolName !== 'update_dive') return null;
  const content = args.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}
