/**
 * Malloy file store — hierarchical retrieval over malloy/models/*.malloy + their
 * _meta/*.yaml sidecars. Replaces the baseline's context_store/semantic_lookup:
 * progressive disclosure, but the retrieval unit is compilable Malloy.
 *
 *   listFiles()                  -> domains, each with file count + one-liner
 *   listFiles(['fees'])          -> per-file summary + its exports (name/kind/summary)
 *   getFile(['fees.malloy'])     -> full .malloy source
 *
 * Metadata lives in YAML sidecars (NOT frontmatter) so the .malloy files stay
 * compilable. Sidecars are the artifact the optimization phase tunes; the store
 * itself is task-general (navigation only).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(REPO_ROOT, 'malloy', 'models');
const META_DIR = path.join(REPO_ROOT, 'malloy', '_meta');

export interface ExportMeta {
  name: string;
  kind: string;
  summary: string;
}
export interface FileMeta {
  file: string;
  domain: string;
  summary: string;
  exports: ExportMeta[];
  provides_for?: string[];
  body: string;
}

export class MalloyStore {
  private byFile = new Map<string, FileMeta>();
  private byDomain = new Map<string, FileMeta[]>();
  private loaded = false;

  constructor(private modelsDir = MODELS_DIR, private metaDir = META_DIR) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const files = (await readdir(this.modelsDir)).filter((f) => f.endsWith('.malloy')).sort();
    for (const file of files) {
      const body = await readFile(path.join(this.modelsDir, file), 'utf8');
      const metaPath = path.join(this.metaDir, file.replace(/\.malloy$/, '.yaml'));
      let meta: Partial<FileMeta> = {};
      try {
        meta = (parseYaml(await readFile(metaPath, 'utf8')) as Partial<FileMeta>) ?? {};
      } catch {
        // No sidecar yet — synthesize a minimal one so the file is still navigable.
      }
      const fm: FileMeta = {
        file,
        domain: meta.domain ?? file.replace(/\.malloy$/, ''),
        summary: meta.summary ?? `(no metadata) ${file}`,
        exports: meta.exports ?? [],
        provides_for: meta.provides_for,
        body,
      };
      this.byFile.set(file, fm);
      const list = this.byDomain.get(fm.domain) ?? [];
      list.push(fm);
      this.byDomain.set(fm.domain, list);
    }
    this.loaded = true;
  }

  /** No domains -> the domain list; with domains -> files + exports in them. */
  listFiles(domains?: string[]): string {
    if (!domains || domains.length === 0) {
      const lines = ['Malloy model domains (call list_malloy_files(domains=[...]) to see files):'];
      for (const [domain, files] of this.byDomain) {
        const nExports = files.reduce((n, f) => n + f.exports.length, 0);
        lines.push(`- ${domain} (${files.length} file${files.length === 1 ? '' : 's'}, ${nExports} exports) — ${files[0]?.summary ?? ''}`);
      }
      return lines.join('\n');
    }
    const lines: string[] = [];
    const unknown: string[] = [];
    for (const d of domains) {
      const files = this.byDomain.get(d.trim());
      if (!files) {
        unknown.push(d.trim());
        continue;
      }
      for (const f of files) {
        lines.push(`### ${f.file}  [${f.domain}] — ${f.summary}`);
        for (const e of f.exports) lines.push(`    - ${e.name} (${e.kind}) — ${e.summary}`);
      }
    }
    if (unknown.length) {
      lines.push(`\n[unknown domains: ${unknown.join(', ')}. Valid: ${[...this.byDomain.keys()].join(', ')}]`);
    }
    return lines.join('\n') || '(no files)';
  }

  /** Full source of the named files. */
  getFile(files: string[]): string {
    const chunks: string[] = [];
    const unknown: string[] = [];
    for (const f of files) {
      const key = f.trim();
      const fm = this.byFile.get(key) ?? this.byFile.get(`${key}.malloy`);
      if (fm) chunks.push(`### ${fm.file}\n${fm.body}`);
      else unknown.push(key);
    }
    if (unknown.length) {
      chunks.push(`[unknown files: ${unknown.join(', ')}. Valid: ${[...this.byFile.keys()].join(', ')}]`);
    }
    return chunks.join('\n\n') || '(no files found)';
  }

  /** Total bytes of the central layer (a conciseness metric, recorded in run_metadata). */
  centralLayerChars(): number {
    let n = 0;
    for (const f of this.byFile.values()) n += f.body.length;
    return n;
  }

  allExportNames(): string[] {
    const names: string[] = [];
    for (const f of this.byFile.values()) for (const e of f.exports) names.push(e.name);
    return names;
  }
}
