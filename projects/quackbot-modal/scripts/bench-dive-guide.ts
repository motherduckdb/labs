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
 * runAgenticLoop; everything else (system prompt, tools, MCP client, model) is
 * identical to production. Supplying that seam also opts every arm into the
 * supplement branch regardless of `QUACKBOT_DIVE_SUPPLEMENT`, which is what
 * keeps arms A and B comparable now that the flag defaults off.
 *
 * NOTE (Modal migration): the LLM transport is now a dedicated Modal endpoint
 * serving ONE model — the historical "force Gemini" behaviour below is no
 * longer reachable through it. Re-running these arms on Gemini needs a
 * MODAL_INFERENCE_BASE_URL that actually serves Gemini; re-running them on K3
 * is the un-done follow-up work called out in PLAN.md §9.
 *
 * BENCH_MODEL survives that, but only as half of a pair. The model id is a
 * string in the request body — it does not route. Setting it alone just
 * mislabels a K3 run; it is meaningful ONLY together with a
 * MODAL_INFERENCE_BASE_URL pointed at an endpoint that serves that model. Even
 * then the `reported cost (USD)` column stays wrong, because cost comes from
 * `computeCostUSD`, which bills Kimi K3's rate table unconditionally. The
 * script warns about both when you set it.
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
 * (default 'low'), BENCH_MODEL (default: MODEL_ID, i.e. Kimi K3 — see the
 * pairing caveat above), BENCH_ARMS (comma list of A,B,C — default all).
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
import { CONTEXT_WINDOW, MODEL_ID, type ModelProfile } from '../src/core/llm-client';
import type { TurnSink } from '../src/core/turn-sink';

// ---------------------------------------------------------------------------
// Env — parse only the keys we need out of the bot .env, into process.env.
// ---------------------------------------------------------------------------

const ENV_PATH = process.env.BENCH_ENV_PATH ?? '/Users/jacobmatson/code/labs/projects/quackbot-modal/.env';

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

  // Generous, explicit per-run timeout: real dive-authoring runs make several
  // sequential tool calls (list_tables, query, save_dive, ...), so 5 minutes
  // gives real slow runs room without letting one hang the whole bench.
  const TIMEOUT_MS = 300_000;
  // NOTE: runAgenticLoop has no AbortController thread-through (a full
  // cancellation path through the agentic loop is out of scope for this bench
  // script), so racing it against a timeout does NOT stop it — a timed-out
  // run keeps making live model/MCP calls (with confirmTool auto-approving
  // writes) in the background after we give up waiting on it below. To keep
  // that background work from overlapping the *next* run — and to give it a
  // chance to actually finish so its save_dive lands in createdDiveIds for
  // cleanup — we block here on the abandoned runPromise until it settles, up
  // to a hard secondary cap of 2x the timeout, before returning from runOne.
  try {
    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('run timeout')), TIMEOUT_MS)),
    ]);
    m.finishReason = result.finishReason;
  } catch (err) {
    m.error = err instanceof Error ? err.message : String(err);
    m.finishReason = 'error';

    if (m.error.includes('run timeout')) {
      const HARD_CAP_MS = TIMEOUT_MS * 2;
      const settled = await Promise.race([
        runPromise.then(() => true).catch(() => true),
        new Promise<false>((res) => setTimeout(() => res(false), HARD_CAP_MS)),
      ]);
      if (!settled) {
        console.warn(
          `[bench] WARNING: ${arm}/${task.key}#${iteration} still running after the ` +
          `${HARD_CAP_MS}ms secondary cap — abandoning it for good; it may keep making ` +
          `live model/MCP calls in the background.`,
        );
      }
    }
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
  // Delete ONLY the dives this run actually created (tracked by id from
  // save_dive responses). We never delete-by-keyword — a 'bench-p3' title
  // match could belong to a different run or a human, so the keyword sweep
  // below is report-only.
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
  // Report-only sweep for stragglers matching our title prefix. These are NOT
  // deleted here — a keyword match isn't proof this run created them (another
  // run or a human could own a same-titled dive), so anything found that
  // isn't in createdDiveIds is logged for manual review, never removed.
  let straggler = 'sweep skipped';
  try {
    const r = await rawCall(client, 'list_dives', { keywords: TITLE_PREFIX, limit: 100 });
    const j = JSON.parse(r.text);
    const dives: Array<{ id?: string; title?: string }> = j?.dives ?? j?.results ?? [];
    const remaining = dives.filter((d) => (d.title ?? '').toLowerCase().includes(TITLE_PREFIX));
    const untracked = remaining.filter((d) => !d.id || !createdDiveIds.has(d.id));
    if (remaining.length === 0) {
      straggler = `list_dives(keywords:'${TITLE_PREFIX}') → 0 remaining`;
    } else if (untracked.length === 0) {
      straggler = `list_dives(keywords:'${TITLE_PREFIX}') → ${remaining.length} remaining, all already deleted above (stale index?)`;
    } else {
      straggler =
        `list_dives(keywords:'${TITLE_PREFIX}') → ${untracked.length} leftover(s) NOT created by this run ` +
        `(needs manual review, NOT auto-deleted): ` +
        untracked.map((d) => `${d.id ?? '(no id)'}:${d.title ?? ''}`).join(', ');
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
  loadEnvKeys(ENV_PATH, [
    'MOTHERDUCK_TOKEN', 'MOTHERDUCK_API_URL',
    'MODAL_INFERENCE_BASE_URL',
    'MODAL_INFERENCE_KEY',
  ]);
  if (!process.env.MOTHERDUCK_TOKEN) throw new Error('MOTHERDUCK_TOKEN missing from .env');
  // One scheme only. This used to also accept a MODAL_KEY + MODAL_SECRET pair,
  // which buildAuthHeaders (llm-client.ts) no longer reads — so that branch
  // passed validation here and then sent an empty bearer. The proxy pair still
  // works, but dot-joined into MODAL_INFERENCE_KEY: `wk-....ws-...`.
  if (!process.env.MODAL_INFERENCE_KEY) {
    throw new Error('MODAL_INFERENCE_KEY missing from .env — the dot-joined proxy pair, wk-<id>.ws-<secret>');
  }
  if (!process.env.MODAL_INFERENCE_BASE_URL) {
    throw new Error('MODAL_INFERENCE_BASE_URL missing from .env — required, the endpoint is per-workspace');
  }

  const model = (process.env.BENCH_MODEL || MODEL_ID).trim();
  const baseUrl = (process.env.MODAL_INFERENCE_BASE_URL || '').trim();
  const thinkingLevel = ((process.env.BENCH_THINKING || 'low').trim() as ThinkingLevel);
  const N = Number(process.env.BENCH_N || '3');
  const armIds = ((process.env.BENCH_ARMS || 'A,B,C').split(',').map((s) => s.trim()) as ArmId[])
    .filter((id) => id in ARMS);

  console.log(`[bench] model=${model} thinking=${thinkingLevel} N=${N} arms=${armIds.join(',')}`);
  console.log(`[bench] endpoint=${baseUrl || '(unset — the loop will throw)'}`);
  // The id does not route; the endpoint does. Overriding one without the other
  // benchmarks whatever that endpoint serves under a name it isn't.
  if (model !== MODEL_ID) {
    console.warn(
      `[bench] WARNING: BENCH_MODEL='${model}' but the model id only labels the request — ` +
      `it is the endpoint above that picks the model. Confirm that endpoint serves '${model}'. ` +
      `The 'reported cost (USD)' column is Kimi K3 rates regardless (computeCostUSD has no ` +
      `model argument), so treat it as token counts, not dollars.`,
    );
  }

  const profile: ModelProfile = {
    id: model,
    maxTokens: 16384,
    // K3's window. Only right while the endpoint is the K3 one; the bench uses
    // it for the same cosmetic percentage the bot does, so it is not load-bearing.
    contextWindow: CONTEXT_WINDOW,
    supportsReasoning: true,
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
      `- Model: \`${model}\``,
      `- Thinking level: \`${thinkingLevel}\`  ·  sampling params: locked by the model (none sent)`,
      `- Runs per prompt: ${N}  ·  arms: ${armIds.join(', ')}`,
      `- Inference endpoint: \`${baseUrl || '(unset)'}\`  ·  the endpoint, not the id above, selects the model`,
      `- Cost column: Kimi K3 rates (\`computeCostUSD\` is unconditional)${model === MODEL_ID ? '' : ' — WRONG for this model'}`,
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
