/**
 * Malloy runtime — in-process compile (getSQL) + local run, backed by
 * @malloydata/malloy + @malloydata/db-duckdb over the local DuckDB file.
 *
 * The "model" is the concatenation of every malloy/models/*.malloy file (the
 * per-file split exists for agent navigation via the store, NOT for Malloy's
 * import system — so we compile them as one unit and strip any `import` lines).
 *
 * COMPILE + local RUN happen here against data/dabstep.duckdb. The scored answer
 * and exploration execute on MotherDuck via MCP — the compiled SQL this module
 * returns is what gets sent there. Local run is for the translation-check only.
 */
import { SingleConnectionRuntime, type Runtime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DB_PATH } from './load.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(REPO_ROOT, 'malloy', 'models');

export interface Diagnostic {
  code?: string;
  message: string;
  severity?: string;
}
export type Row = Record<string, unknown>;
export interface CompileResult {
  ok: boolean;
  sql?: string;
  diagnostics?: Diagnostic[];
}
export interface RunResult {
  ok: boolean;
  sql?: string;
  rows?: Row[];
  diagnostics?: Diagnostic[];
}

/** Field/source inventory for the linter symbol table. */
export interface ModelInventory {
  sources: string[];
  fieldsBySource: Record<string, string[]>;
  /** Per source, the names of its VIEWS (query fields) — the surfaces worth
   *  smoke-executing at build time (they exercise joins/measures, so they catch
   *  binder/scope errors that compile but fail at execution). */
  viewsBySource: Record<string, string[]>;
}

/**
 * Order model files so every source is defined before it's referenced (Malloy
 * compiles them as one concatenated unit and needs definition-before-use). We
 * parse each file's `source:`/`query:` definitions, build a file→file dependency
 * graph from cross-file references, and topologically sort it (Kahn's). Ties
 * break stably (bases first, then name). On a dependency CYCLE we fall back to a
 * bases-first alphabetical order. Exported for testing.
 */
export function orderModelFilesByDependency(files: string[], bodyOf: Record<string, string>): string[] {
  const defRe = /(?:^|\n)[ \t]*(?:source|query):[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+is\b/g;
  const definerOf = new Map<string, string>(); // source name -> file that defines it
  const definedIn = new Map<string, Set<string>>(); // file -> names it defines
  for (const f of files) {
    const names = new Set<string>();
    for (const m of (bodyOf[f] ?? '').matchAll(defRe)) {
      names.add(m[1]);
      if (!definerOf.has(m[1])) definerOf.set(m[1], f);
    }
    definedIn.set(f, names);
  }
  // file -> set of files it depends on (references a source defined elsewhere).
  const deps = new Map<string, Set<string>>();
  for (const f of files) {
    const own = definedIn.get(f)!;
    const d = new Set<string>();
    for (const [name, def] of definerOf) {
      if (def === f || own.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(bodyOf[f] ?? '')) d.add(def);
    }
    deps.set(f, d);
  }
  const rank = (f: string) => (f.endsWith('_base.malloy') ? 0 : 1); // bases first
  const cmp = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
  const indeg = new Map(files.map((f) => [f, deps.get(f)!.size]));
  const ready = files.filter((f) => indeg.get(f) === 0).sort(cmp);
  const order: string[] = [];
  while (ready.length) {
    const f = ready.shift()!;
    order.push(f);
    for (const g of files) {
      if (deps.get(g)!.has(f)) {
        indeg.set(g, indeg.get(g)! - 1);
        if (indeg.get(g) === 0) {
          ready.push(g);
          ready.sort(cmp);
        }
      }
    }
  }
  if (order.length !== files.length) {
    // Dependency cycle — fall back to the stable bases-first heuristic.
    return [...files.filter((f) => rank(f) === 0).sort(), ...files.filter((f) => rank(f) === 1).sort()];
  }
  return order;
}

export class MalloyRuntime {
  private connection: DuckDBConnection;
  private runtime: Runtime;
  private modelText: string | null = null;
  private modelsDir: string;

  /**
   * `databasePath`:
   *   - `md:<db>` → Malloy connects to MotherDuck (compiles AND runs there, via the
   *     motherduck extension). This is the path the EVAL uses, so the answer executes
   *     on the same engine it compiled against — no local→MotherDuck SQL skew.
   *   - a local file (default `data/dabstep.duckdb`) → used for fast build-time compile
   *     validation and credential-free tests. Unqualified `duckdb.table('payments')`
   *     resolves in BOTH (local file + md:<db> default catalog), so one layer works for both.
   */
  constructor(opts: { databasePath?: string; modelsDir?: string } = {}) {
    const databasePath = opts.databasePath ?? LOCAL_DB_PATH;
    const isMd = databasePath.startsWith('md:');
    if (isMd && process.env.MOTHERDUCK_TOKEN) process.env.motherduck_token = process.env.MOTHERDUCK_TOKEN;
    this.connection = new DuckDBConnection({
      name: 'duckdb',
      databasePath,
      ...(isMd ? { additionalExtensions: ['motherduck'] } : {}),
    });
    this.runtime = new SingleConnectionRuntime({ connection: this.connection });
    this.modelsDir = opts.modelsDir ?? MODELS_DIR;
  }

  /** Concatenate all model files into one compilation unit (cached). */
  async loadModelText(force = false): Promise<string> {
    if (this.modelText !== null && !force) return this.modelText;
    // Malloy compiles these as ONE unit and needs definition-before-use, so files
    // must be concatenated in DEPENDENCY order (a source defined before any source
    // that references it) — per the Malloy docs the single highest-value ordering
    // rule. We topologically sort by actual source references rather than relying
    // on a naming convention (alphabetical/`cN_` prefix), which is fragile.
    const all = (await readdir(this.modelsDir)).filter((f) => f.endsWith('.malloy'));
    const bodyOf: Record<string, string> = {};
    for (const f of all) {
      // Strip `import "..."` lines — everything is one unit here.
      bodyOf[f] = (await readFile(path.join(this.modelsDir, f), 'utf8')).replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, '');
    }
    const files = orderModelFilesByDependency(all, bodyOf);
    this.modelText = files.map((f) => `// === ${f} ===\n${bodyOf[f]}`).join('\n\n');
    return this.modelText;
  }

  private toDiagnostics(err: unknown): Diagnostic[] {
    const problems = (err as { problems?: Array<{ code?: string; message: string; severity?: string }> })?.problems;
    if (Array.isArray(problems) && problems.length) {
      return problems.map((p) => ({ code: p.code, message: p.message, severity: p.severity }));
    }
    return [{ message: err instanceof Error ? err.message : String(err) }];
  }

  /** Compile a Malloy query to DuckDB SQL without executing it. */
  async compile(querySrc: string): Promise<CompileResult> {
    try {
      const model = await this.loadModelText();
      const sql = await this.runtime.loadModel(model).loadQuery(querySrc).getSQL();
      return { ok: true, sql };
    } catch (err) {
      return { ok: false, diagnostics: this.toDiagnostics(err) };
    }
  }

  /** Compile + run the query against the connection (MotherDuck for eval, local for
   *  tests). Returns rows as objects. This is Malloy-native execution — the answer
   *  runs on the same engine it compiled against, so no cross-engine SQL skew.
   *  `rowLimit` caps exploration output (default 50). The SCORED answer must pass
   *  a large explicit cap (see ANSWER_ROW_LIMIT) — Malloy's own default caps at 50,
   *  which silently truncates list answers (a 155-row answer was being cut to 50). */
  async run(querySrc: string, rowLimit = 50): Promise<RunResult> {
    try {
      const model = await this.loadModelText();
      const runnable = this.runtime.loadModel(model).loadQuery(querySrc);
      const sql = await runnable.getSQL();
      const result = await runnable.run({ rowLimit });
      const rows = result.data.toObject() as Row[];
      return { ok: true, sql, rows };
    } catch (err) {
      return { ok: false, diagnostics: this.toDiagnostics(err) };
    }
  }

  /** Source + field inventory from the compiled model (linter symbol table). */
  async describe(): Promise<ModelInventory> {
    const model = await this.loadModelText();
    const compiled = await this.runtime.loadModel(model).getModel();
    const sources: string[] = [];
    const fieldsBySource: Record<string, string[]> = {};
    const viewsBySource: Record<string, string[]> = {};
    for (const explore of compiled.explores) {
      sources.push(explore.name);
      fieldsBySource[explore.name] = explore.allFields.map((f) => f.name);
      viewsBySource[explore.name] = explore.allFields
        .filter((f) => typeof (f as { isQueryField?: () => boolean }).isQueryField === 'function' && (f as { isQueryField: () => boolean }).isQueryField())
        .map((f) => f.name);
    }
    return { sources, fieldsBySource, viewsBySource };
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
