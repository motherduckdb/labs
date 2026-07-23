/**
 * bench-dive-guide.ts — Phase 3 of MCP_MIGRATION_PLAN.md.
 *
 * Decide with data whether quackbot's ~40K-token local Gemini dive-guide
 * override (`buildGeminiDiveGuide`) can be replaced by the stock server guide
 * plus the thin supplement (`buildGeminiDiveSupplement`). Runs three arms
 * through the REAL agentic loop against the REAL MotherDuck MCP with the
 * Gemini model forced, and measures dive-authoring quality per arm.
 *
 *   A. stock       — real get_dive_guide({client:'other'}), no supplement
 *   B. stock+supp  — real stock guide + buildGeminiDiveSupplement() appended
 *   C. override    — current full local override (baseline)
 *
 * The arm is selected purely by the `resolveGeminiDiveGuide` seam on
 * runAgenticLoop; everything else (system prompt, tools, MCP client, model,
 * temperature) is identical to production.
 *
 * Task set × N runs (default 3 prompts × 3 runs = 9 runs/arm, 27 total).
 * Every dive the model saves is tracked and deleted before exit (delete_dive
 * via the PAT directly — the bot's block on that tool is a bot concern, not a
 * script one), then list_dives is swept for any 'bench-p3' stragglers.
 *
 * Run (never source the whole .env — the plan notes zsh chokes on the
 * unquoted & in DATABASE_URL; this script reads only the keys it needs):
 *   npx tsx scripts/bench-dive-guide.ts
 *
 * Env knobs: BENCH_N (runs per prompt, default 3), BENCH_THINKING
 * (default 'low'), BENCH_MODEL (default google/gemini-3-flash-preview),
 * BENCH_ARMS (comma list of A,B,C — default all).
 *
 * Never logs secrets.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { runAgenticLoop, type RunAgenticLoopOpts, type ThinkingLevel } from '../src/core/agentic-loop';
import { createMCPClient, getFilteredTools, mcpToolsToAnthropicFormat } from '../src/core/mcp-client';
import { buildSystemPrompt } from '../src/core/system-prompt';
import { fetchQueryGuideBlock } from '../src/core/query-guide';
import { dispatchTool as realDispatchTool } from '../src/core/tool-dispatch';
import { buildGeminiDiveSupplement } from '../src/core/gemini-dive-guide';
import type { ModelProfile } from '../src/core/llm-client';
import type { TurnSink } from '../src/core/turn-sink';

// ---------------------------------------------------------------------------
// Env — parse only the keys we need out of the bot .env, into process.env.
// ---------------------------------------------------------------------------

const ENV_PATH = process.env.BENCH_ENV_PATH ?? '/Users/jacobmatson/code/labs/projects/quackbot/.env';

function loadEnvKeys(path: string, keys: string[]): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read ${path} — set BENCH_ENV_PATH to the bot's .env`);
  }
  const wanted = new Set(keys);
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && wanted.has(m[1])) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ---------------------------------------------------------------------------
// Task set — dive-authoring prompts over the sample_data share.
// ---------------------------------------------------------------------------

const TITLE_PREFIX = 'bench-p3';

interface Task {
  key: string;
  prompt: string;
}

const TASKS: Task[] = [
  {
    key: 'taxi',
    prompt:
      `Build a dive showing NYC yellow taxi trips per day, then save it to MotherDuck. ` +
      `Title it exactly "${TITLE_PREFIX}-taxi". The data is the NYC taxi table in the sample_data share. ` +
      `Go ahead and save it — you have my approval to save the dive.`,
  },
  {
    key: 'air',
    prompt:
      `Build a dive of WHO ambient air-quality readings — the average measured value by country, top 15 — ` +
      `then save it to MotherDuck. Title it exactly "${TITLE_PREFIX}-air". The data is who.ambient_air_quality ` +
      `in the sample_data share. Go ahead and save it — you have my approval to save the dive.`,
  },
  {
    key: 'multi',
    prompt:
      `Build a dive with two charts from the NYC taxi table in the sample_data share: ` +
      `(a) daily trip counts for trips carrying more than 1 passenger, and ` +
      `(b) the average total fare per day over that same "more than 1 passenger" filter. ` +
      `Then save it to MotherDuck. Title it exactly "${TITLE_PREFIX}-multi". ` +
      `Go ahead and save it — you have my approval to save the dive.`,
  },
];

// ---------------------------------------------------------------------------
// Arms — differ ONLY in how the Gemini get_dive_guide is resolved.
// ---------------------------------------------------------------------------

type ArmId = 'A' | 'B' | 'C';

const ARMS: Record<ArmId, { label: string; resolve?: RunAgenticLoopOpts['resolveGeminiDiveGuide'] }> = {
  A: {
    label: 'stock (passthrough)',
    resolve: async (fetchStock) => fetchStock(),
  },
  B: {
    label: 'stock + supplement',
    resolve: async (fetchStock) => `${await fetchStock()}\n\n${buildGeminiDiveSupplement()}`,
  },
  C: {
    label: 'full local override (baseline)',
    // Historical arm. When this benchmark was run, the loop default WAS the full
    // ~40K-token override (buildGeminiDiveGuide), so `undefined` selected it. Phase 3
    // then deleted that override in favor of stock+supplement, so `undefined` now
    // aliases arm B — arm C is no longer reproducible from this tree. The original
    // C numbers are frozen in bench-p3-results.md (first-attempt saves 4/9, ~2.6×
    // the token cost of B). Left here to document what was compared.
    resolve: undefined,
  },
};

// ---------------------------------------------------------------------------
// Per-run metrics.
// ---------------------------------------------------------------------------

interface RunMetrics {
  arm: ArmId;
  task: string;
  iteration: number;
  finishReason: string;
  calledDiveGuide: boolean;
  saveAttempts: number; // save_dive calls
  diveWriteAttempts: number; // save_dive + update_dive + edit_dive_content
  firstSaveSucceeded: boolean; // first save_dive returned non-error
  anySaveSucceeded: boolean;
  lintAdvisoryCount: number;
  // source checks on the first save_dive content
  hasDefaultExport: boolean;
  hasRequiredDbExport: boolean;
  usesCorrectHook: boolean;
  usesWrongHook: boolean;
  sourceLeaked: boolean;
  diveIds: string[];
  error?: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

function extractDiveId(content: string): string | undefined {
  try {
    const j = JSON.parse(content.trim());
    const id = j?.dive?.id ?? j?.id ?? j?.uuid;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    /* not JSON */
  }
  const m = content.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m?.[0];
}

// Chat text should never contain dive source; these markers are the tell.
const LEAK_MARKERS = [
  'export default function',
  'REQUIRED_DATABASES',
  'useSQLQuery',
  '@motherduck/react-sql-query',
  '```tsx',
  '```jsx',
];

function detectLeak(chatText: string): boolean {
  return LEAK_MARKERS.some((m) => chatText.includes(m));
}

// ---------------------------------------------------------------------------
// One run of the real agentic loop.
// ---------------------------------------------------------------------------

async function runOne(
  client: Client,
  tools: RunAgenticLoopOpts['tools'],
  systemPrompt: string,
  profile: ModelProfile,
  thinkingLevel: ThinkingLevel,
  arm: ArmId,
  task: Task,
  iteration: number,
  createdDiveIds: Set<string>,
): Promise<RunMetrics> {
  const m: RunMetrics = {
    arm,
    task: task.key,
    iteration,
    finishReason: 'n/a',
    calledDiveGuide: false,
    saveAttempts: 0,
    diveWriteAttempts: 0,
    firstSaveSucceeded: false,
    anySaveSucceeded: false,
    lintAdvisoryCount: 0,
    hasDefaultExport: false,
    hasRequiredDbExport: false,
    usesCorrectHook: false,
    usesWrongHook: false,
    sourceLeaked: false,
    diveIds: [],
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
  };

  let firstSaveRecorded = false;
  let chatText = '';

  const sink: TurnSink = {
    onText: (c) => { chatText += c; },
    onThinking: () => {},
    onThinkingDone: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onMvizPending: () => {},
    onMvizBlock: () => {},
    onUsage: (u) => {
      m.promptTokens += u.promptTokens ?? 0;
      m.completionTokens += u.completionTokens ?? 0;
      m.cost += (u as { cost?: number }).cost ?? 0;
    },
    onError: () => {},
    onAuthExpired: () => {},
    onTurnComplete: () => {},
  };

  // Wrap the real dispatcher: record dive-write metrics, pass everything else
  // through untouched so the loop behaves exactly as in production.
  const dispatchToolImpl: RunAgenticLoopOpts['dispatchToolImpl'] = async (o) => {
    const name = o.name;
    if (name === 'get_dive_guide') m.calledDiveGuide = true;
    if (name === 'save_dive' || name === 'update_dive' || name === 'edit_dive_content') {
      m.diveWriteAttempts++;
    }
    if (name === 'save_dive') {
      m.saveAttempts++;
      const src = typeof o.args.content === 'string' ? (o.args.content as string) : '';
      if (!firstSaveRecorded) {
        firstSaveRecorded = true;
        m.hasDefaultExport = /export\s+default\s+function/.test(src);
        m.hasRequiredDbExport = /export\s+const\s+REQUIRED_DATABASES\s*=/.test(src);
        m.usesCorrectHook = src.includes('@motherduck/react-sql-query') && /\buseSQLQuery\b/.test(src);
        m.usesWrongHook = src.includes('@motherduck/wasm-client') || /\buseQuery\b/.test(src);
      }
    }

    let res;
    try {
      res = await realDispatchTool(o);
    } catch (err) {
      if (name === 'save_dive' && !firstSaveRecorded) firstSaveRecorded = true;
      throw err;
    }

    if (name === 'save_dive') {
      const ok = !res.isError;
      if (m.saveAttempts === 1) m.firstSaveSucceeded = ok;
      if (ok) {
        m.anySaveSucceeded = true;
        const id = extractDiveId(res.content);
        if (id) { m.diveIds.push(id); createdDiveIds.add(id); }
      }
      if (/--- Dive lint \(react-hooks\) ---/.test(res.content)) m.lintAdvisoryCount++;
    }
    return res;
  };

  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: task.prompt }];

  const runPromise = runAgenticLoop({
    messages,
    turnStartIndex: messages.length - 1,
    profile,
    thinkingLevel,
    client,
    tools,
    systemPrompt,
    sink,
    taskId: `bench:${arm}:${task.key}:${iteration}`,
    runId: `bench_${Date.now()}`,
    requestText: task.prompt,
    historyLength: 0,
    dispatchToolImpl,
    // Auto-approve the durable save_dive write (the bench is the "user").
    confirmTool: async () => true,
    ...(ARMS[arm].resolve ? { resolveGeminiDiveGuide: ARMS[arm].resolve } : {}),
  });

  const TIMEOUT_MS = 300_000;
  try {
    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('run timeout')), TIMEOUT_MS)),
    ]);
    m.finishReason = result.finishReason;
  } catch (err) {
    m.error = err instanceof Error ? err.message : String(err);
    m.finishReason = 'error';
  }

  m.sourceLeaked = detectLeak(chatText);
  return m;
}

// ---------------------------------------------------------------------------
// Aggregation + reporting.
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${((100 * n) / d).toFixed(0)}%`;
}

interface ArmAgg {
  runs: number;
  savedRuns: number; // runs with >=1 save_dive attempt
  firstSaveSuccess: number;
  anySaveSuccess: number;
  totalSaveAttempts: number;
  totalDiveWriteAttempts: number;
  defaultExport: number;
  requiredDb: number;
  correctHook: number;
  wrongHook: number;
  leaks: number;
  lintTotal: number;
  calledGuide: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

function aggregate(rows: RunMetrics[]): ArmAgg {
  const a: ArmAgg = {
    runs: 0, savedRuns: 0, firstSaveSuccess: 0, anySaveSuccess: 0,
    totalSaveAttempts: 0, totalDiveWriteAttempts: 0, defaultExport: 0,
    requiredDb: 0, correctHook: 0, wrongHook: 0, leaks: 0, lintTotal: 0,
    calledGuide: 0, errors: 0, promptTokens: 0, completionTokens: 0, cost: 0,
  };
  for (const r of rows) {
    a.runs++;
    if (r.saveAttempts > 0) a.savedRuns++;
    if (r.firstSaveSucceeded) a.firstSaveSuccess++;
    if (r.anySaveSucceeded) a.anySaveSuccess++;
    a.totalSaveAttempts += r.saveAttempts;
    a.totalDiveWriteAttempts += r.diveWriteAttempts;
    if (r.saveAttempts > 0) {
      if (r.hasDefaultExport) a.defaultExport++;
      if (r.hasRequiredDbExport) a.requiredDb++;
      if (r.usesCorrectHook) a.correctHook++;
      if (r.usesWrongHook) a.wrongHook++;
    }
    if (r.sourceLeaked) a.leaks++;
    a.lintTotal += r.lintAdvisoryCount;
    if (r.calledDiveGuide) a.calledGuide++;
    if (r.error) a.errors++;
    a.promptTokens += r.promptTokens;
    a.completionTokens += r.completionTokens;
    a.cost += r.cost;
  }
  return a;
}

function armTable(aggs: Record<ArmId, ArmAgg>, arms: ArmId[]): string {
  const rows: Array<[string, (a: ArmAgg) => string]> = [
    ['runs', (a) => String(a.runs)],
    ['called get_dive_guide', (a) => `${a.calledGuide}/${a.runs}`],
    ['runs with a save attempt', (a) => `${a.savedRuns}/${a.runs}`],
    ['first-attempt save success', (a) => `${a.firstSaveSuccess}/${a.runs} (${pct(a.firstSaveSuccess, a.runs)})`],
    ['any save success', (a) => `${a.anySaveSuccess}/${a.runs} (${pct(a.anySaveSuccess, a.runs)})`],
    ['avg save attempts / run', (a) => (a.totalSaveAttempts / Math.max(a.runs, 1)).toFixed(2)],
    ['avg dive-write attempts / run', (a) => (a.totalDiveWriteAttempts / Math.max(a.runs, 1)).toFixed(2)],
    ['has export default function', (a) => `${a.defaultExport}/${a.savedRuns} (${pct(a.defaultExport, a.savedRuns)})`],
    ['has REQUIRED_DATABASES export', (a) => `${a.requiredDb}/${a.savedRuns} (${pct(a.requiredDb, a.savedRuns)})`],
    ['uses useSQLQuery/react-sql-query', (a) => `${a.correctHook}/${a.savedRuns} (${pct(a.correctHook, a.savedRuns)})`],
    ['uses WRONG hook (useQuery/wasm)', (a) => `${a.wrongHook}/${a.savedRuns} (${pct(a.wrongHook, a.savedRuns)})`],
    ['dive source leaked to chat', (a) => `${a.leaks}/${a.runs} (${pct(a.leaks, a.runs)})`],
    ['avg lint advisories / run', (a) => (a.lintTotal / Math.max(a.runs, 1)).toFixed(2)],
    ['errors', (a) => String(a.errors)],
    ['total prompt tokens', (a) => a.promptTokens.toLocaleString()],
    ['total completion tokens', (a) => a.completionTokens.toLocaleString()],
    ['reported cost (USD)', (a) => `$${a.cost.toFixed(4)}`],
  ];
  const header = `| metric | ${arms.map((id) => `${id} (${ARMS[id].label})`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(arms.length + 1)}`;
  const body = rows
    .map(([label, fn]) => `| ${label} | ${arms.map((id) => fn(aggs[id])).join(' | ')} |`)
    .join('\n');
  return [header, sep, body].join('\n');
}

// ---------------------------------------------------------------------------
// Cleanup — delete every dive the bench created; sweep for stragglers.
// ---------------------------------------------------------------------------

async function rawCall(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const isError = r.isError === true;
  let text: string;
  if (r.structuredContent != null) text = JSON.stringify(r.structuredContent);
  else text = Array.isArray(r.content)
    ? r.content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
    : JSON.stringify(r.content);
  return { text, isError };
}

async function cleanup(client: Client, createdDiveIds: Set<string>): Promise<string> {
  const notes: string[] = [];
  let deleted = 0;
  let failed = 0;
  for (const id of createdDiveIds) {
    try {
      const r = await rawCall(client, 'delete_dive', { id });
      if (r.isError) { failed++; notes.push(`  delete FAILED ${id}: ${r.text.slice(0, 120)}`); }
      else deleted++;
    } catch (err) {
      failed++;
      notes.push(`  delete THREW ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Sweep for stragglers matching our prefix (titles we asked for, plus any the
  // model titled off-script but that we still tracked by id above).
  let straggler = 'sweep skipped';
  try {
    const r = await rawCall(client, 'list_dives', { keywords: TITLE_PREFIX, limit: 100 });
    const j = JSON.parse(r.text);
    const dives: Array<{ id?: string; title?: string }> = j?.dives ?? j?.results ?? [];
    const remaining = dives.filter((d) => (d.title ?? '').toLowerCase().includes(TITLE_PREFIX));
    if (remaining.length === 0) {
      straggler = `list_dives(keywords:'${TITLE_PREFIX}') → 0 remaining`;
    } else {
      straggler = `list_dives(keywords:'${TITLE_PREFIX}') → ${remaining.length} remaining, deleting`;
      for (const d of remaining) {
        if (!d.id) continue;
        try {
          const dr = await rawCall(client, 'delete_dive', { id: d.id });
          if (!dr.isError) deleted++; else failed++;
        } catch { failed++; }
      }
      // re-verify
      const r2 = await rawCall(client, 'list_dives', { keywords: TITLE_PREFIX, limit: 100 });
      const j2 = JSON.parse(r2.text);
      const dives2: Array<{ title?: string }> = j2?.dives ?? j2?.results ?? [];
      const rem2 = dives2.filter((d) => (d.title ?? '').toLowerCase().includes(TITLE_PREFIX));
      straggler += `; after sweep ${rem2.length} remaining`;
    }
  } catch (err) {
    straggler = `sweep error: ${err instanceof Error ? err.message : String(err)}`;
  }
  notes.unshift(`  tracked dive ids: ${createdDiveIds.size}, deleted: ${deleted}, failed: ${failed}`);
  notes.push(`  ${straggler}`);
  return notes.join('\n');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  loadEnvKeys(ENV_PATH, ['MOTHERDUCK_TOKEN', 'MOTHERDUCK_API_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL']);
  if (!process.env.MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN missing from .env');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .env');

  const model = (process.env.BENCH_MODEL || 'google/gemini-3-flash-preview').trim();
  const thinkingLevel = ((process.env.BENCH_THINKING || 'low').trim() as ThinkingLevel);
  const N = Number(process.env.BENCH_N || '3');
  const armIds = ((process.env.BENCH_ARMS || 'A,B,C').split(',').map((s) => s.trim()) as ArmId[])
    .filter((id) => id in ARMS);

  console.log(`[bench] model=${model} thinking=${thinkingLevel} N=${N} arms=${armIds.join(',')}`);
  console.log(`[bench] deployed OPENROUTER_MODEL was '${process.env.OPENROUTER_MODEL}' — forcing Gemini for the bench`);

  const profile: ModelProfile = {
    id: model,
    maxTokens: 16384,
    supportsReasoning: true,
    provider: undefined,
    contextWindow: 1_000_000,
  };

  const client = await createMCPClient('bench-p3');
  const createdDiveIds = new Set<string>();
  const allRows: RunMetrics[] = [];

  try {
    const mcpTools = await getFilteredTools(client);
    const tools = mcpToolsToAnthropicFormat(mcpTools);
    // Pre-fetch the org query guide once (as production's handler does) and
    // reuse it across every run for a faithful, prompt-cache-stable prompt.
    const queryGuide = await fetchQueryGuideBlock(client);
    const systemPrompt = buildSystemPrompt(['sample_data'], queryGuide);
    console.log(`[bench] tools=${tools.length} queryGuide=${queryGuide ? 'prefetched' : 'null (fallback prompt)'}`);

    for (const arm of armIds) {
      for (const task of TASKS) {
        for (let i = 1; i <= N; i++) {
          const started = Date.now();
          const m = await runOne(client, tools, systemPrompt, profile, thinkingLevel, arm, task, i, createdDiveIds);
          allRows.push(m);
          console.log(
            `[bench] arm ${arm} ${task.key} #${i} — ${((Date.now() - started) / 1000).toFixed(0)}s ` +
            `finish=${m.finishReason} save1st=${m.firstSaveSucceeded} saves=${m.saveAttempts} ` +
            `hook=${m.usesCorrectHook ? 'ok' : m.usesWrongHook ? 'WRONG' : 'na'} ` +
            `reqdb=${m.hasRequiredDbExport} defexp=${m.hasDefaultExport} leak=${m.sourceLeaked} ` +
            `lint=${m.lintAdvisoryCount}${m.error ? ` err=${m.error}` : ''}`,
          );
        }
      }
    }
  } finally {
    console.log('\n[bench] cleanup…');
    const cleanupNotes = await cleanup(client, createdDiveIds);
    console.log(cleanupNotes);

    // Build report even if the run was partial.
    const aggs = {} as Record<ArmId, ArmAgg>;
    for (const arm of armIds) aggs[arm] = aggregate(allRows.filter((r) => r.arm === arm));
    const table = armTable(aggs, armIds);

    const outPath = process.env.BENCH_OUT
      ?? '/private/tmp/claude-502/-Users-jacobmatson-code-labs/d8afb6fb-4591-435a-bd54-99222abe6193/scratchpad/bench-p3-results.md';
    const md = [
      '# Phase 3 — Gemini dive-guide benchmark results',
      '',
      `- Model (forced): \`${model}\``,
      `- Thinking level: \`${thinkingLevel}\`  ·  temperature: 0.3 (loop default)`,
      `- Runs per prompt: ${N}  ·  arms: ${armIds.join(', ')}`,
      `- Deployed OPENROUTER_MODEL (not used here): \`${process.env.OPENROUTER_MODEL}\``,
      `- MCP endpoint: \`${(process.env.MOTHERDUCK_API_URL || '').replace(/\/$/, '')}/mcp\` (prod, jm_quackbot PAT)`,
      `- Query guide prefetched into system prompt: ${allRows.length ? 'yes' : 'n/a'}`,
      '',
      '## Arm-by-arm results',
      '',
      table,
      '',
      '## Per-run detail',
      '',
      '| arm | task | # | finish | called guide | saves | 1st ok | any ok | defexp | reqdb | hook | leak | lint | err |',
      `|${'---|'.repeat(14)}`,
      ...allRows.map((r) =>
        `| ${r.arm} | ${r.task} | ${r.iteration} | ${r.finishReason} | ${r.calledDiveGuide} | ${r.saveAttempts} | ` +
        `${r.firstSaveSucceeded} | ${r.anySaveSucceeded} | ${r.hasDefaultExport} | ${r.hasRequiredDbExport} | ` +
        `${r.usesCorrectHook ? 'ok' : r.usesWrongHook ? 'WRONG' : 'na'} | ${r.sourceLeaked} | ${r.lintAdvisoryCount} | ${r.error ?? ''} |`,
      ),
      '',
      '## Cleanup',
      '',
      '```',
      cleanupNotes,
      '```',
      '',
      '## Raw rows (JSON)',
      '',
      '```json',
      JSON.stringify(allRows, null, 2),
      '```',
      '',
    ].join('\n');
    writeFileSync(outPath, md);
    console.log(`\n[bench] wrote ${outPath}`);
    console.log('\n' + table + '\n');

    try { await client.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => { console.error('[bench] fatal:', err); process.exit(1); });
