/**
 * Deterministic Malloy linter — runs BEFORE every compile/run/submit. Returns
 * { fixedSrc, fixes } so fixes are logged and shown to the agent. Mechanical
 * fixes ONLY — never changes what is computed (semantic restructuring is left to
 * compiler-error feedback). The symbol table comes from the compiled model's own
 * vocabulary (MalloyRuntime.describe()), NEVER from the train questions — that's
 * what keeps the linter task-general for the optimization phase.
 */
import type { ModelInventory } from './malloy-runtime.js';

export interface LintResult {
  fixedSrc: string;
  fixes: string[];
}

/** Known raw-SQL function normalizations (typed `!` escapes Malloy requires). */
const FUNCTION_FIXES: Array<{ re: RegExp; to: string; note: string }> = [
  { re: /\blist_contains\s*\(/g, to: 'list_contains!boolean(', note: 'list_contains -> list_contains!boolean (raw SQL escape)' },
  { re: /\blen\s*\(/g, to: 'len!number(', note: 'len -> len!number (raw SQL escape on arrays)' },
];

export function buildSymbolSet(inv: ModelInventory): Set<string> {
  const s = new Set<string>();
  for (const src of inv.sources) s.add(src);
  for (const fields of Object.values(inv.fieldsBySource)) for (const f of fields) s.add(f);
  return s;
}

export function lintMalloy(src: string, symbols: Set<string>): LintResult {
  const fixes: string[] = [];
  let out = src;

  // 1. Strip markdown fences / leading `malloy:` label / surrounding prose.
  const fence = out.match(/```(?:malloy)?\s*\n([\s\S]*?)```/);
  if (fence) {
    out = fence[1];
    fixes.push('stripped markdown code fence');
  }
  const leading = out.replace(/^\s*malloy:\s*\n/, '');
  if (leading !== out) {
    out = leading;
    fixes.push("stripped leading 'malloy:' label");
  }
  out = out.trim();

  // 2. Prefix a bare `source -> { ... }` pipeline with `run:`.
  if (/^[A-Za-z_][\w]*\s*->/.test(out) && !/^\s*run:/.test(out)) {
    out = `run: ${out}`;
    fixes.push("prefixed bare pipeline with 'run:'");
  }

  // 3. Known function-name normalization (only if not already escaped with `!`).
  for (const { re, to, note } of FUNCTION_FIXES) {
    // Skip occurrences already written as the escaped form.
    const escapedForm = to.slice(0, -1); // e.g. 'list_contains!boolean'
    if (out.includes(escapedForm)) continue;
    if (re.test(out)) {
      out = out.replace(re, to);
      fixes.push(note);
    }
    re.lastIndex = 0;
  }

  // 4. Identifier casing: a bare token that case-insensitively matches exactly
  //    one known symbol but differs in case -> canonical casing.
  if (symbols.size) {
    const lowerMap = new Map<string, string[]>();
    for (const sym of symbols) {
      const k = sym.toLowerCase();
      const arr = lowerMap.get(k) ?? [];
      arr.push(sym);
      lowerMap.set(k, arr);
    }
    out = out.replace(/[A-Za-z_][\w]*/g, (tok) => {
      if (symbols.has(tok)) return tok; // already canonical
      const matches = lowerMap.get(tok.toLowerCase());
      if (matches && matches.length === 1 && matches[0] !== tok) {
        fixes.push(`cased '${tok}' -> '${matches[0]}'`);
        return matches[0];
      }
      return tok;
    });
  }

  return { fixedSrc: out, fixes };
}
