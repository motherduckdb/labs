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

export type FieldKind = 'measure' | 'dimension' | 'view';

/** Flatten the per-source field-kind map into one name→kind map for the linter's
 *  `select:` split. A name that is a measure in one source but a dimension in
 *  another is AMBIGUOUS → recorded as 'view' so the split declines (never
 *  guesses). */
export function buildKindMap(inv: ModelInventory): Map<string, FieldKind> {
  const m = new Map<string, FieldKind>();
  for (const kinds of Object.values(inv.fieldKindBySource)) {
    for (const [name, k] of Object.entries(kinds)) {
      const prev = m.get(name);
      if (prev === undefined) m.set(name, k);
      else if (prev !== k) m.set(name, 'view'); // ambiguous across sources
    }
  }
  return m;
}

/** The `duckdb.sql(...)` raw-SQL escape hatch, matched tolerant of whitespace
 *  (`duckdb . sql (`). Used by both the eval (reject agent answers that embed raw
 *  SQL) and the build harness (reject a layer that embeds raw SQL). */
const RAW_SQL_RE = /\bduckdb\s*\.\s*sql\s*\(/gi;

/** True if `src` wraps raw SQL via `duckdb.sql(...)`. The escape hatch is
 *  PROHIBITED — both in the agent's per-query Malloy answer AND in the authored
 *  semantic layer. The eval steers the agent off it (to submit_answer / the SQL
 *  arm when enabled); the build gate rejects it. */
export function detectRawSqlInMalloy(src: string): boolean {
  RAW_SQL_RE.lastIndex = 0;
  return RAW_SQL_RE.test(src);
}

/** How many `duckdb.sql(...)` escape hatches appear in `src`. The build harness
 *  uses this so a layer EDIT that ADDS a new raw-SQL block is rejected while a
 *  pre-existing block (grandfathered) does not block an unrelated edit. */
export function countRawSqlInMalloy(src: string): number {
  return (src.match(RAW_SQL_RE) ?? []).length;
}

/** Aggregate functions for SYNTACTIC detection in the select/calculate/where
 *  rules. Window-only funcs (row_number, rank, lag, …) are deliberately excluded
 *  so `calculate:` of a real window op is never demoted to `aggregate:`. */
const AGG_FUNCS = [
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp', 'median', 'count_approx',
];
const AGG_CALL_RE = new RegExp(`\\b(?:${AGG_FUNCS.join('|')})\\s*\\(`, 'i');
/** Does an expression contain an aggregate call (e.g. `sum(x)`, `count()`)? */
function isAggExpr(expr: string): boolean {
  return AGG_CALL_RE.test(expr);
}

/** Function-call cast forms the agent writes out of SQL habit → Malloy `::type`. */
const CAST_FIXES: Array<{ re: RegExp; type: string }> = [
  { re: /\bstring_type\s*\(\s*([^()]+?)\s*\)/g, type: 'string' },
  { re: /\bnumber_type\s*\(\s*([^()]+?)\s*\)/g, type: 'number' },
  { re: /\bdate_type\s*\(\s*([^()]+?)\s*\)/g, type: 'date' },
];

/** Split `s` on top-level (paren/bracket/brace depth 0) matches of the GLOBAL
 *  `sepRe`. Operates on MASKED text, so separators inside strings/comments are
 *  already @@n@@ placeholders and never split. O(n²) but Malloy clauses are short. */
function topLevelParts(s: string, sepRe: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0) {
      sepRe.lastIndex = i;
      const m = sepRe.exec(s);
      if (m && m.index === i && m[0].length > 0) {
        parts.push(s.slice(last, i));
        i += m[0].length;
        last = i;
        continue;
      }
    }
    i++;
  }
  parts.push(s.slice(last));
  return parts;
}

/** Does `s` contain a top-level match of `sepRe` (e.g. a top-level ` or `)? */
function hasTopLevel(s: string, sepRe: RegExp): boolean {
  return topLevelParts(s, sepRe).length > 1;
}

/** Classify one `select:` item as a measure (→ aggregate:) or a dimension
 *  (→ group_by:). Syntactic aggregate calls are decisive; bare field names use
 *  the compiled field-kind map. Anything we can't prove → 'unknown' (decline). */
function classifySelectItem(item: string, kinds?: Map<string, FieldKind>): 'aggregate' | 'group_by' | 'unknown' {
  const t = item.trim();
  if (!t) return 'unknown';
  if (isAggExpr(t)) return 'aggregate';
  // `name is expr` rename → classify by the expression.
  const named = t.match(/^[A-Za-z_]\w*\s+is\s+([\s\S]+)$/);
  if (named) return isAggExpr(named[1]) ? 'aggregate' : 'group_by';
  // Bare field name → consult the compiled field-kind map when present.
  const bare = t.match(/^([A-Za-z_]\w*)$/);
  if (bare) {
    if (!kinds) return 'group_by'; // no kind info (legacy/syntax path) → assume dimension
    const k = kinds.get(bare[1]);
    if (k === 'measure') return 'aggregate';
    if (k === 'dimension') return 'group_by';
    return 'unknown'; // unknown/ambiguous field → decline rather than guess
  }
  return 'unknown'; // qualified/expression we can't classify → decline
}

/**
 * Replace string literals + comments with opaque placeholders so the text
 * rewrites below never corrupt SQL inside duckdb.sql("""...""") (count(*), ||,
 * list_contains, year, ==, &&) or comment text. Placeholders are @@<n>@@ —
 * they never match any rewrite regex (which all require a leading letter/`_`,
 * or a specific operator). restore() puts the originals back.
 */
function maskCodeSpans(src: string): { masked: string; restore: (s: string) => string } {
  const spans: string[] = [];
  const re = /("""[\s\S]*?"""|\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const masked = src.replace(re, (m) => {
    const i = spans.length;
    spans.push(m);
    return `@@${i}@@`;
  });
  const restore = (s: string) => s.replace(/@@(\d+)@@/g, (_m, i) => spans[Number(i)] ?? '');
  return { masked, restore };
}

export function lintMalloy(src: string, symbols: Set<string>, kinds?: Map<string, FieldKind>): LintResult {
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

  // 1b. Strip `import "..."` lines. The semantic layer is ALREADY loaded (the
  //     runtime concatenates all model files), so the agent's per-query Malloy
  //     must not import — relative imports fail ("must compile via a URL"), and
  //     this was the single most common eval error (~57% of run_malloy failures).
  const noImport = out.replace(/^\s*import\b[^\n]*$/gm, '');
  if (noImport !== out) {
    out = noImport.trim();
    fixes.push('stripped import statement(s) — layer is pre-loaded');
  }

  // 2. Prefix a bare `source -> { ... }` pipeline with `run:`.
  if (/^[A-Za-z_][\w]*\s*->/.test(out) && !/^\s*run:/.test(out)) {
    out = `run: ${out}`;
    fixes.push("prefixed bare pipeline with 'run:'");
  }

  // MASK strings + comments so steps 3–4 never rewrite SQL inside duckdb.sql("""…""")
  // (count(*), ||, list_contains, year, ==, &&) or comment text. Restored before return.
  const { masked, restore } = maskCodeSpans(out);
  out = masked;

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

  // 3b. Trivial SQL→Malloy operator rewrites (complementary-linter Group 3).
  const opFixes: Array<{ re: RegExp; to: string; note: string }> = [
    { re: /(?<![=!<>])==(?!=)/g, to: '=', note: '== -> =' },
    { re: /&&/g, to: ' and ', note: '&& -> and' },
    { re: /\|\|/g, to: ' or ', note: '|| -> or' },
    { re: /\bcount\(\s*\*\s*\)/gi, to: 'count()', note: 'count(*) -> count()' },
  ];
  for (const { re, to, note } of opFixes) {
    if (re.test(out)) {
      out = out.replace(re, to);
      fixes.push(note);
    }
    re.lastIndex = 0;
  }
  // count(distinct x) -> count(x) — count(expr) is already distinct in Malloy.
  out = out.replace(/\bcount\(\s*distinct\s+([^)]+)\)/gi, (_m, inner) => {
    fixes.push('count(distinct x) -> count(x)');
    return `count(${String(inner).trim()})`;
  });

  // 3c. Backtick reserved/time-keyword columns that are real fields (the marquee
  //     case: a bare `year` aborts the parse). Only words that are KNOWN symbols.
  const RESERVED = new Set(['year', 'month', 'quarter', 'week', 'day', 'hour', 'minute', 'second', 'date', 'time']);
  out = out.replace(/(?<![`\w.])([a-z_][\w]*)(?![`\w])/g, (tok) => {
    if (RESERVED.has(tok) && symbols.has(tok)) {
      fixes.push(`backticked reserved column \`${tok}\``);
      return `\`${tok}\``;
    }
    return tok;
  });

  // ── SQL-habit fixes (the agent writes SQL-shaped Malloy that won't compile).
  //    All four operate on the MASKED source, so identical text inside
  //    duckdb.sql("""…""") is never touched. Each rewrite is re-validated by the
  //    compile that tools.ts runs right after lint; the per-rule guards block the
  //    cases that would COMPILE yet compute something different (those decline +
  //    emit a hint instead of rewriting).

  // 3d. Function-call casts → `::type` (e.g. string_type(x) -> x::string). The
  //     `[^()]+?` arg refuses nested parens, so number_type(foo(x)) is left for
  //     the compiler rather than mis-rewritten.
  for (const { re, type } of CAST_FIXES) {
    out = out.replace(re, (_m, inner) => {
      fixes.push(`${type}_type(x) -> x::${type}`);
      return `${String(inner).trim()}::${type}`;
    });
    re.lastIndex = 0;
  }

  // 3e. `calculate:` of a PLAIN aggregate → `aggregate:` (calculate: is only for
  //     window ops over already-grouped rows). Guarded: a window-only keyword in
  //     the expression means it's a real calculate: — leave it.
  const CALC_RE = /\bcalculate:\s*([A-Za-z_]\w*)\s+is\s+([^\n};]+)/g;
  out = out.replace(CALC_RE, (m, name, expr) => {
    const e = String(expr);
    const windowish = /\b(over|order_by|rows|range|preceding|following|lag|lead|row_number|rank|dense_rank|cumulative|first_value|last_value|ntile|percent_rank)\b/i.test(e);
    if (isAggExpr(e) && !windowish) {
      fixes.push(`calculate: -> aggregate: (plain aggregate '${name}')`);
      return m.replace(/\bcalculate:/, 'aggregate:');
    }
    return m;
  });
  CALC_RE.lastIndex = 0;

  // 3f. Aggregate in `where:` → split into where: (row predicates) + having:
  //     (aggregate predicates). Only top-level `and`/comma conjunctions are split;
  //     a top-level `or`/`not` would change the logic, so decline + hint instead.
  const WHERE_RE = /\bwhere:\s*([^\n};]+)/g;
  out = out.replace(WHERE_RE, (m, body) => {
    const b = String(body);
    if (!isAggExpr(b)) return m; // ordinary row filter — leave it
    if (hasTopLevel(b, /\s+or\s+/gi) || /\bnot\b/i.test(b)) {
      fixes.push('aggregate in where: — move the aggregate predicate to having: (not auto-split: OR/NOT present)');
      return m;
    }
    const parts = topLevelParts(b, /\s+and\s+|\s*,\s*/gi).map((s) => s.trim()).filter(Boolean);
    const agg = parts.filter(isAggExpr);
    const row = parts.filter((p) => !isAggExpr(p));
    if (!agg.length) return m;
    if (!row.length) {
      fixes.push('where: (all-aggregate) -> having:');
      return m.replace(/\bwhere:/, 'having:');
    }
    fixes.push('split where: into where: (rows) + having: (aggregates)');
    return `where: ${row.join(' and ')}\n  having: ${agg.join(' and ')}`;
  });
  WHERE_RE.lastIndex = 0;

  // 3g. `select:` containing an aggregate → group_by: (dimensions) + aggregate:
  //     (measures). The split needs the field-kind map to classify bare names;
  //     if ANY item is unclassifiable, decline + hint (never a wrong split). A
  //     plain projection (no aggregate) is a legitimate select: — left alone.
  const SELECT_RE = /\bselect:\s*([\s\S]*?)(?=;|\n\s*(?:group_by|aggregate|where|having|order_by|limit|calculate|nest|select)\b|\s*})/g;
  out = out.replace(SELECT_RE, (m, body) => {
    const items = topLevelParts(String(body), /\s*,\s*/g).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return m;
    const cls = items.map((it) => classifySelectItem(it, kinds));
    if (!cls.includes('aggregate')) return m; // plain projection — a legit select: (leave it, even if a name is unknown)
    if (cls.includes('unknown')) {
      fixes.push('select: with aggregate — use group_by: for dimensions and aggregate: for measures (not auto-split: unclassifiable item)');
      return m;
    }
    const groups = items.filter((_, i) => cls[i] === 'group_by');
    const aggs = items.filter((_, i) => cls[i] === 'aggregate');
    const lines: string[] = [];
    if (groups.length) lines.push(`group_by: ${groups.join(', ')}`);
    lines.push(`aggregate: ${aggs.join(', ')}`);
    fixes.push('split select: into group_by: + aggregate:');
    return lines.join('\n  ');
  });
  SELECT_RE.lastIndex = 0;

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

  out = restore(out); // put string/comment spans back
  return { fixedSrc: out, fixes };
}
