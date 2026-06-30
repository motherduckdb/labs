/**
 * agentic-malloy CLI: load · malloy-preflight · evaluate · summary.
 *
 * evaluate runs the two-model Malloy agent over a split (or task-ids), executes
 * the scored answer on MotherDuck via MCP, scores via the Python sidecar, and
 * writes per-question JSONL + controllog events/postings.
 */
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocalDuckDB, buildMotherDuckDB, LOCAL_DB_PATH } from './load.js';
import { MalloyRuntime } from './malloy-runtime.js';
import { MalloyStore } from './malloy-store.js';
import { buildSymbolSet, buildKindMap, type FieldKind } from './linter.js';
import { ScoreClient } from './score-client.js';
import { createMCPClient, getExplorationTools, mcpRetryCount } from './mcp-client.js';
import { buildToolSchemas, newRunState, type ToolDeps } from './tools.js';
import { runTask } from './agentic-loop.js';
import { resolveModel } from './llm-client.js';
import { hashLayerOnDisk, PROVENANCE_PATH, META_DIR } from './layer-build.js';
import { loadGlossaryArtifact, renderGlossaryForAnswering } from './glossary.js';
import { loadLayerIndex } from './miss-analysis.js';
import { computeUsageReport, formatUsageReport } from './usage-report.js';
import { buildDabstepLayer } from './dabstep-build.js';
import { improveLayer } from './layer-improve.js';
import { uploadControllog } from './upload.js';
import { runPool, makeSerializedWriter } from './pool.js';
import * as cl from './controllog.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const RESULTS_DIR = path.join(REPO_ROOT, 'results');
const TASKS_PATH = path.join(DATA_DIR, 'dabstep', 'tasks', 'all.jsonl');
const SPLIT_PATH = path.join(DATA_DIR, 'split.json');
const BAD_GOLDS_PATH = path.join(DATA_DIR, 'bad_golds.json');
const SKILL_PATH = path.join(REPO_ROOT, 'src', 'skill.md');

const PROJECT_ID = 'agentic-malloy';
const AGENT_ID = 'agent:asm-malloy';

export interface Question {
  task_id: string | number;
  question: string;
  guidelines?: string;
  answer?: string;
  level?: string;
  answer_source?: string;
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

function gitOutput(args: string): string | undefined {
  try {
    return execSync(`git ${args}`, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

/**
 * Uncommitted TRACKED changes within this project (staged + unstaged), scoped to
 * REPO_ROOT and excluding untracked files — so transient `results/` logs, scratch
 * scripts, and unrelated sibling projects do NOT count. This is the signal that
 * actually answers "is this run reproducible from the recorded commit_sha".
 */
function gitDirtyTrackedFiles(): string[] {
  const out = gitOutput('status --porcelain --untracked-files=no -- .');
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

interface Provenance {
  malloy_provenance: 'model_authored' | 'human_edited';
  malloy_model_hash: string;
  manual_included: boolean | null;
  authoring_model: string | null;
  reason: string;
}

/**
 * Resolve the layer's provenance from the marker written by layer-build, and
 * verify the on-disk layer hash still matches it. A missing marker or a hash
 * mismatch (a hand-edit since the build) downgrades to human_edited.
 */
async function resolveProvenance(): Promise<Provenance> {
  const diskHash = await hashLayerOnDisk();
  const base = { malloy_model_hash: diskHash, manual_included: null, authoring_model: null };
  try {
    const m = JSON.parse(await readFile(PROVENANCE_PATH, 'utf8')) as {
      malloy_provenance?: string; malloy_model_hash?: string; manual_included?: boolean; authoring_model?: string;
    };
    const meta = { manual_included: m.manual_included ?? null, authoring_model: m.authoring_model ?? null };
    if (m.malloy_provenance !== 'model_authored')
      return { ...base, ...meta, malloy_provenance: 'human_edited', reason: 'marker not model_authored' };
    if (m.malloy_model_hash !== diskHash)
      return { ...base, ...meta, malloy_provenance: 'human_edited', reason: 'layer edited since build (hash mismatch)' };
    return { ...base, ...meta, malloy_provenance: 'model_authored', reason: 'marker matches on-disk layer' };
  } catch {
    return { ...base, malloy_provenance: 'human_edited', reason: 'no provenance marker' };
  }
}

async function loadQuestions(split: string): Promise<Question[]> {
  const all = (await readFile(TASKS_PATH, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Question);
  const bad = new Set<string>((JSON.parse(await readFile(BAD_GOLDS_PATH, 'utf8')).task_ids ?? []).map(String));
  if (split === 'all') return all.filter((q) => !bad.has(String(q.task_id)));
  const trainIds: string[] = JSON.parse(await readFile(SPLIT_PATH, 'utf8')).train_ids;
  const trainSet = new Set(trainIds.map(String));
  if (split === 'test') return all.filter((q) => !trainSet.has(String(q.task_id)) && !bad.has(String(q.task_id)));
  // templates: in train_ids order
  const byId = new Map(all.map((q) => [String(q.task_id), q]));
  return trainIds.map((id) => byId.get(String(id))).filter((q): q is Question => !!q);
}

async function cmdLoad(flags: Record<string, string | boolean>) {
  if (flags.motherduck) {
    const database = (flags.database as string) || process.env.MD_DATABASE || 'agentic_malloy';
    console.log(`Building MotherDuck database ${database} …`);
    const counts = await buildMotherDuckDB(database);
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n.toLocaleString()}`);
    return;
  }
  console.log(`Building ${LOCAL_DB_PATH} …`);
  const counts = await buildLocalDuckDB();
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n.toLocaleString()}`);
}

async function cmdPreflight() {
  const rt = new MalloyRuntime();
  const q = 'run: payments_base -> { aggregate: transaction_count }';
  const c = await rt.compile(q);
  console.log('compile.ok =', c.ok);
  if (!c.ok) {
    console.error(c.diagnostics);
    process.exit(1);
  }
  const r = await rt.run(q);
  console.log('local run rows =', JSON.stringify(r.rows));
  await rt.close();
  console.log('PREFLIGHT OK');
}

/**
 * The single per-question outcome. runEvalTask ALWAYS produces one of these and
 * never throws out of the worker, so a failure in MCP setup, the agent loop, or
 * scoring fails THAT question only — siblings keep running and every requested
 * task id still yields exactly one JSONL row + one terminal controllog state.
 */
export interface EvalTaskOutcome {
  taskId: string;
  isCorrect: boolean;
  correctness: string;
  predictedAnswer: string | null;
  row: Record<string, unknown>; // the JSONL row (written by the caller, serialized)
  terminalState: 'DONE' | 'FAILED';
  // failure metadata (mirrored into the JSONL row + controllog payloads)
  failureStage: 'mcp_setup' | 'agent_loop' | 'scoring' | null;
  failureKind: string | null;
  escalated: boolean;
}

// Minimal scorer surface the task runner needs — lets tests inject a fake.
type Scorer = Pick<ScoreClient, 'score'>;

export interface EvalTaskCtx {
  systemPrompt: string;
  runtime: MalloyRuntime;
  localRuntime?: MalloyRuntime;
  store: MalloyStore;
  symbols: Set<string>;
  kinds: Map<string, FieldKind>;
  viewNames: Set<string>;
  allowSqlFallback: boolean;
  scorer: Scorer;
  database: string;
  author: string;
  fixer: string;
  escalateAfter: number;
  maxAuthorTurns: number;
  maxFixerTurns: number;
  steerInsteadOfEscalate: boolean;
  reasoning: string;
  provider?: string; // pinned OpenRouter upstream provider (or undefined)
  runClass: string;
  prov: Provenance;
  runId: string;
  split: string;
  // Injectable seams (default to the real implementations) so the per-task
  // containment path can be unit-tested without a live MCP/LLM.
  createClient?: typeof createMCPClient;
  discoverTools?: typeof getExplorationTools;
  runTaskFn?: typeof runTask;
}

/**
 * Run one question end-to-end (MCP client → tool discovery → agent loop →
 * scoring → JSONL row + controllog terminal state) behind a SINGLE try/catch so
 * any throw becomes an EvalTaskOutcome rather than a pool rejection. The MCP
 * client is per-task (isolation) and always closed in a finally.
 */
export async function runEvalTask(q: Question, ctx: EvalTaskCtx): Promise<EvalTaskOutcome> {
  const createClient = ctx.createClient ?? createMCPClient;
  const discoverTools = ctx.discoverTools ?? getExplorationTools;
  const runTaskFn = ctx.runTaskFn ?? runTask;
  const tid = String(q.task_id);
  const t0 = Date.now();
  cl.stateMove({ taskId: tid, from: 'NEW', to: 'WIP', runId: ctx.runId });

  const state = newRunState();
  let result: Awaited<ReturnType<typeof runTask>> | null = null;
  let failureStage: EvalTaskOutcome['failureStage'] = null;
  let failureKind: string | null = null;
  let dispatchErr: string | null = null;
  let scoreError: string | null = null;
  let mcpRetries = 0;

  // --- MCP setup + agent loop --------------------------------------------------
  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
  try {
    client = await createClient(`${ctx.runId}:${tid}`);
  } catch (e) {
    failureStage = 'mcp_setup';
    failureKind = 'mcp_connect_failed';
    dispatchErr = e instanceof Error ? e.message : String(e);
  }
  if (client) {
    try {
      const mcpTools = await discoverTools(client);
      const deps: ToolDeps = {
        client,
        runtime: ctx.runtime,
        localRuntime: ctx.localRuntime,
        store: ctx.store,
        symbols: ctx.symbols,
        kinds: ctx.kinds,
        viewNames: ctx.viewNames,
        allowSqlFallback: ctx.allowSqlFallback,
        database: ctx.database,
        question: q.question,
        guidelines: q.guidelines,
        mcpTools,
        state,
      };
      result = await runTaskFn({
        question: q.question, guidelines: q.guidelines, systemPrompt: ctx.systemPrompt,
        toolSchemas: buildToolSchemas(deps), deps,
        authorModel: ctx.author, fixerModel: ctx.fixer,
        escalateAfter: ctx.escalateAfter, maxAuthorTurns: ctx.maxAuthorTurns, maxFixerTurns: ctx.maxFixerTurns,
        steerInsteadOfEscalate: ctx.steerInsteadOfEscalate,
        reasoningEffort: ctx.reasoning, provider: ctx.provider, taskId: tid, runId: ctx.runId,
      });
    } catch (e) {
      failureStage = 'agent_loop';
      failureKind = 'agent_loop_threw';
      dispatchErr = e instanceof Error ? e.message : String(e);
    } finally {
      mcpRetries = mcpRetryCount(client);
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  // A stream failure that ended the loop is a distinct, reportable failure.
  if (result?.streamFailureReason) {
    failureStage = failureStage ?? 'agent_loop';
    failureKind = failureKind ?? 'stream_failure';
    dispatchErr = dispatchErr ?? result.streamFailureReason;
  }

  const elapsedMs = Date.now() - t0;
  const submitted = state.submitted;
  const hitLimit = result?.hitLimit ?? true;

  // --- scoring -----------------------------------------------------------------
  // A scorer failure must NOT abort the pool: catch it, mark the question a
  // scoring failure, and synthesize an error outcome so this row is still
  // written and the task reaches a terminal controllog state.
  let scoreResp: Awaited<ReturnType<ScoreClient['score']>>;
  try {
    scoreResp = await ctx.scorer.score({
      rows: state.finalRows ?? null,
      error: state.finalRows ? null : dispatchErr ?? 'no submission',
      gold: q.answer ?? '',
      guidelines: q.guidelines ?? null,
      predicted_sql: state.finalCompiledSql ?? null,
      hit_limit: hitLimit,
    });
  } catch (e) {
    scoreError = e instanceof Error ? e.message : String(e);
    failureStage = 'scoring';
    failureKind = 'score_error';
    scoreResp = {
      is_correct: false, correctness: 'error', score: 0, match_source: 'score_error',
      reason: scoreError, predicted_answer: null, gold_answer: q.answer ?? '',
    };
  }

  const reward = scoreResp.is_correct ? 1 : 0;
  // A task is DONE if it completed the loop AND scoring; otherwise FAILED.
  const terminalState: 'DONE' | 'FAILED' = result && failureStage === null ? 'DONE' : 'FAILED';
  const escalationReason = result?.escalationReason ?? null;

  // Common failure fields, mirrored into both the controllog payload and the row.
  const failureFields = {
    failure_stage: failureStage,
    failure_kind: failureKind,
    submitted,
    hit_limit: hitLimit,
    retry_count: result?.retryCount ?? 0,
    mcp_retry_count: mcpRetries,
    score_error: scoreError,
    escalation_reason: escalationReason,
    author_recovery_used: result?.authorRecoveryUsed ?? false,
  };

  cl.stateMove({ taskId: tid, from: 'WIP', to: terminalState, runId: ctx.runId });
  cl.utility({ taskId: tid, metric: 'reward', value: reward, runId: ctx.runId });
  cl.event({
    kind: 'task_complete', taskId: tid, agentId: AGENT_ID, runId: ctx.runId,
    idempotencyKey: `${ctx.runId}:task:${tid}`,
    payload: {
      correctness: scoreResp.correctness, escalated: result?.escalated ?? false,
      n_tool_calls: result?.toolCallCount ?? 0, duration_ms: elapsedMs, ...failureFields,
    },
  });
  cl.event({
    kind: 'evaluation_result', taskId: tid, agentId: AGENT_ID, runId: ctx.runId,
    idempotencyKey: `${ctx.runId}:eval:${tid}`,
    payload: {
      question_id: tid, question_text: q.question, evidence: q.guidelines, level: q.level,
      config_type: 'malloy', run_class: ctx.runClass, database: ctx.database, model: ctx.author,
      author_model: ctx.author, fixer_model: ctx.fixer,
      malloy_provenance: ctx.prov.malloy_provenance, malloy_model_hash: ctx.prov.malloy_model_hash,
      malloy_source: state.finalMalloy ?? null, malloy_source_chars: state.finalMalloy?.length ?? 0,
      compiled_sql: state.finalCompiledSql ?? null, compiled_sql_chars: state.finalCompiledSql?.length ?? 0,
      translation_match: state.translationMatch ?? null, answer_kind: state.answerKind ?? null,
      predicted_result: scoreResp.predicted_answer, gold_result: q.answer,
      is_correct: scoreResp.is_correct, correctness_level: scoreResp.correctness, match_source: scoreResp.match_source,
      escalated: result?.escalated ?? false,
      fixer_turns: result?.fixerTurns ?? 0, tool_calls: result?.toolCallCount ?? 0,
      files_read: state.filesRead, lint_fixes: state.lintFixesTotal,
      duration_ms: elapsedMs, cost_usd: result?.usage.cost ?? 0,
      input_tokens: result?.usage.promptTokens ?? 0, output_tokens: result?.usage.completionTokens ?? 0,
      cached_tokens: result?.usage.cachedTokens ?? 0, cache_write_tokens: result?.usage.cacheWriteTokens ?? 0,
      provider: ctx.provider ?? null,
      // Full bundled conversation so the dive renders the COMPLETE trace (model
      // text + reasoning + every call/result), matching the Eval Explorer design.
      raw_response: { messages: result?.trace ?? [] },
      error_description: dispatchErr, ...failureFields,
    },
  });

  const row: Record<string, unknown> = {
    task_id: tid, level: q.level, split: ctx.split, author_model: ctx.author, fixer_model: ctx.fixer, run_class: ctx.runClass,
    steer_instead_of_escalate: ctx.steerInsteadOfEscalate,
    question: q.question, guidelines: q.guidelines, gold_answer: q.answer,
    predicted_answer: scoreResp.predicted_answer, is_correct: scoreResp.is_correct, correctness: scoreResp.correctness,
    match_source: scoreResp.match_source, malloy_source: state.finalMalloy ?? null, compiled_sql: state.finalCompiledSql ?? null,
    translation_match: state.translationMatch ?? null, answer_kind: state.answerKind ?? null,
    escalated: result?.escalated ?? false, fixer_turns: result?.fixerTurns ?? 0, steers_used: result?.steersUsed ?? 0, tool_calls: result?.toolCallCount ?? 0,
    files_read: state.filesRead, lint_fixes: state.lintFixesTotal, elapsed_s: +(elapsedMs / 1000).toFixed(2),
    cost_usd: result?.usage.cost ?? 0, prompt_tokens: result?.usage.promptTokens ?? 0, completion_tokens: result?.usage.completionTokens ?? 0,
    cached_tokens: result?.usage.cachedTokens ?? 0, cache_write_tokens: result?.usage.cacheWriteTokens ?? 0, provider: ctx.provider ?? null,
    error: dispatchErr, ...failureFields, ts: new Date().toISOString(),
  };

  return {
    taskId: tid,
    isCorrect: scoreResp.is_correct,
    correctness: scoreResp.correctness,
    predictedAnswer: scoreResp.predicted_answer,
    row,
    terminalState,
    failureStage,
    failureKind,
    escalated: result?.escalated ?? false,
  };
}

async function cmdEvaluate(flags: Record<string, string | boolean>) {
  const split = (flags.split as string) || 'templates';
  const author = resolveModel((flags.author as string) || 'sonnet');
  // Steer-instead-of-escalate is the DEFAULT (opus-free): on repeated compile errors
  // the AUTHOR is steered in place (see agentic-loop.ts) rather than failing over to a
  // fixer model. The 27-task × 3-pass A/B showed it non-inferior to the opus failover
  // (79/81 vs 77/81, within per-pass noise) at ~15% lower cost on that escalation-prone
  // subset. Opt back into the opus failover with --no-steer (required for an official run).
  const steerInsteadOfEscalate = !flags['no-steer'];
  let fixer = resolveModel((flags.fixer as string) || (steerInsteadOfEscalate ? 'sonnet' : 'opus'));
  if (steerInsteadOfEscalate) {
    if (flags.fixer) console.warn(`⚠️  --fixer ${String(flags.fixer)} ignored: the in-place steer (default) is opus-free; pass --no-steer to use a fixer failover.`);
    fixer = author; // no failover model in steer mode; any residual escalate() stays on the author
  }

  // run_class is EXPLICIT (default smoke). It is NOT inferred from model flags —
  // that would mislabel runs (e.g. cheap gemini/gemini as "official"). Only an
  // explicit --run-class official, on a model-authored layer, backs the claim.
  const runClass = (flags['run-class'] as string) || 'smoke';
  if (runClass !== 'smoke' && runClass !== 'official') {
    throw new Error(`--run-class must be 'smoke' or 'official' (got '${runClass}')`);
  }
  const prov = await resolveProvenance();
  if (runClass === 'official') {
    // The official 26/26 must be: a model-authored layer (built WITH the manual)
    // answered by the canonical sonnet-author / opus-fixer tiering. Anything else
    // is a smoke/experiment run and cannot back the claim.
    const reasons: string[] = [];
    if (prov.malloy_provenance !== 'model_authored') reasons.push(`layer is ${prov.malloy_provenance} (${prov.reason}) — run a full \`layer-build\``);
    if (prov.manual_included !== true) reasons.push(`layer built without the manual (manual_included=${prov.manual_included})`);
    if (author !== resolveModel('sonnet')) reasons.push(`author must be sonnet (got ${author})`);
    // The official baseline is the canonical sonnet-author / opus-FAILOVER tiering.
    // The in-place steer is the everyday default, so an official run must opt out of it.
    if (steerInsteadOfEscalate) reasons.push('the opus failover is required for an official run — pass --no-steer (the in-place steer is the default for smoke/experiment runs)');
    else if (fixer !== resolveModel('opus')) reasons.push(`fixer must be opus (got ${fixer})`);
    // An official number must be REPRODUCIBLE from the recorded commit_sha. A dirty
    // tracked tree (e.g. layer-improve having modified src/skill.md, or any layer
    // edit) means the scored prompt/layer state isn't committed — refuse, don't
    // just warn. This closes "--re-eval --run-class official scores on a dirty
    // prompt state". (Smoke runs still only warn — see below.)
    const dirty = gitDirtyTrackedFiles();
    if (dirty.length) reasons.push(`uncommitted tracked changes (${dirty.length}) — an official run must be reproducible; commit first (layer-improve may have edited src/skill.md):\n      ${dirty.slice(0, 8).join('\n      ')}${dirty.length > 8 ? `\n      … and ${dirty.length - 8} more` : ''}`);
    if (reasons.length) {
      throw new Error(`Refusing an OFFICIAL run:\n  - ${reasons.join('\n  - ')}\nUse --run-class smoke for experiments.`);
    }
  }
  const escalateAfter = Number(flags['escalate-after'] ?? 2);
  const maxAuthorTurns = Number(flags['max-author-turns'] ?? 20);
  const maxFixerTurns = Number(flags['max-fixer-turns'] ?? 6);
  // SQL fallback (submit_sql) is OFF by default — this experiment PROHIBITS SQL as
  // an answer substrate; every answer must be Malloy (submit_answer). Opt back into
  // the SQL arm with --sql-fallback (--no-sql-fallback also forces it off, and wins
  // if both are passed). Recorded in run_metadata so arms are distinguishable.
  const allowSqlFallback = !!flags['sql-fallback'] && !flags['no-sql-fallback'];
  const reasoning = (flags.reasoning as string) || 'low';
  // Pin OpenRouter to one upstream provider (e.g. "anthropic") — flag wins, else
  // the OPENROUTER_PROVIDER env, else unset (OpenRouter's default routing).
  const provider = (flags.provider as string) || process.env.OPENROUTER_PROVIDER || undefined;
  const concurrency = Number(flags.concurrency ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be an integer >= 1 (got '${flags.concurrency}')`);
  }
  // The agentic_malloy MotherDuck DB is built by `load --motherduck`.
  const database = (flags.database as string) || process.env.MD_DATABASE || 'agentic_malloy';
  const limit = flags.limit ? Number(flags.limit) : undefined;

  let questions: Question[];
  if (flags['task-id']) {
    const all = await loadQuestions('all');
    const want = new Set(String(flags['task-id']).split(',').map((s) => s.trim()).filter(Boolean));
    questions = all.filter((q) => want.has(String(q.task_id)));
    if (!questions.length) throw new Error(`task-id ${flags['task-id']} not found`);
  } else {
    questions = await loadQuestions(split);
    if (limit) questions = questions.slice(0, limit);
  }

  const skill = await readFile(SKILL_PATH, 'utf8');
  const primer = await readFile(path.join(REPO_ROOT, 'docs', 'malloy', 'malloy-primer.md'), 'utf8');
  // The ubiquitous-language glossary (if the layer shipped one) maps the question's
  // vocabulary to layer concepts/surfaces — the question→layer bridge at answer time.
  const glossaryBlock = renderGlossaryForAnswering(await loadGlossaryArtifact(META_DIR));
  let systemPrompt = `You are an expert data analyst answering factoid questions about a payments dataset by authoring Malloy.\n\nThe MotherDuck database is \`${database}\` (schema main, tables: payments, fees, merchants, acquirer_countries, merchant_category_codes). Exploration tools default to this database.\n\n============ SKILL ============\n${skill}\n\n============ MALLOY PRIMER ============\n${primer}${glossaryBlock ? `\n\n============ DOMAIN GLOSSARY (question terms → layer concepts) ============\n${glossaryBlock}` : ''}\n===============================`;

  // The skill now describes the DEFAULT Malloy-only contract (no SQL answer path).
  // When the SQL fallback is explicitly opted into (--sql-fallback), append a note
  // that RE-ENABLES the submit_sql arm so the otherwise-Malloy-only skill doesn't
  // contradict the now-present tool. (duckdb.sql(...) stays prohibited either way.)
  if (allowSqlFallback) {
    systemPrompt += '\n\n[SQL FALLBACK ENABLED for this run: the `submit_sql` tool is available. If no layer view fits and authoring Malloy is fighting you, you MAY compute the answer with the `query` tool and submit it via `submit_sql` (it runs on MotherDuck and is scored identically). Embedding raw SQL inside Malloy via `duckdb.sql(...)` remains prohibited.]';
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
  const outPath = path.join(RESULTS_DIR, `${split}_${ts}.jsonl`);

  cl.init({ project: PROJECT_ID, logDir: RESULTS_DIR, agentId: AGENT_ID });
  const session = cl.createSession();
  const runId = cl.newId();

  const store = new MalloyStore();
  await store.load();
  // The eval's scored Malloy runtime connects to MotherDuck. A second local
  // runtime is kept only for the warning-only translation_match diagnostic.
  const runtime = new MalloyRuntime({ databasePath: `md:${database}` });
  // Warning-only translation diagnostic: run the same Malloy against the local
  // DuckDB snapshot and compare the result shape to the scored MotherDuck rows.
  const localRuntime = new MalloyRuntime();
  const inv = await runtime.describe();
  const symbols = buildSymbolSet(inv);
  const kinds = buildKindMap(inv); // field-kind for the linter's select: split
  const viewNames = new Set(Object.values(inv.viewsBySource).flat()); // tag view-selection answers
  const scorer = new ScoreClient();

  // Reproducibility: the recorded commit_sha only describes this run if the
  // tracked code is committed. Official runs REFUSE a dirty tree (above); smoke
  // runs warn loudly but proceed.
  const commitSha = gitOutput('rev-parse HEAD');
  const dirtyFiles = gitDirtyTrackedFiles();
  if (dirtyFiles.length) {
    console.warn(`\n⚠️  ${dirtyFiles.length} uncommitted tracked change(s) — this run is NOT reproducible from commit ${commitSha?.slice(0, 8) ?? '(unknown)'}:`);
    for (const f of dirtyFiles.slice(0, 20)) console.warn(`     ${f}`);
    if (dirtyFiles.length > 20) console.warn(`     … and ${dirtyFiles.length - 20} more`);
    console.warn('');
  }

  console.log(`split=${split} · ${questions.length} q · author=${author} fixer=${fixer} · run_class=${runClass} · provenance=${prov.malloy_provenance} · db=${database} · conc=${concurrency} · sql_fallback=${allowSqlFallback ? 'on' : 'off'}${steerInsteadOfEscalate ? ' · steer-instead-of-escalate (opus-free)' : ''}${provider ? ` · provider=${provider}` : ''}`);

  let correct = 0;
  let completed = 0;

  // Serialize JSONL appends + per-task controllog flushes through one writer so
  // concurrent tasks never interleave a half-written row or flush. Each task
  // still writes exactly once; ordering across tasks is best-effort.
  const writeRow = makeSerializedWriter(async (line: string) => {
    await appendFile(outPath, line + '\n');
    // Per-task flush keeps telemetry crash-durable (a mid-run crash preserves
    // everything completed so far; the run-level finally is the backstop).
    await cl.flushSession(session);
  });

  const ctx: EvalTaskCtx = {
    systemPrompt, runtime, localRuntime, store, symbols, kinds, viewNames, allowSqlFallback, scorer, database,
    author, fixer, escalateAfter, maxAuthorTurns, maxFixerTurns, steerInsteadOfEscalate, reasoning, provider,
    runClass, prov, runId, split,
  };

  // Whole-run cleanup: ALWAYS flush controllog and close the runtime + scorer,
  // even if the pool rejects (a runner bug) mid-run. Per-task MCP clients are
  // closed inside runEvalTask, so nothing leaks if a worker is abandoned.
  try {
    await cl.runInSession(session, async () => {
      cl.runMetadata({
        runId,
        resolvedConfig: {
          run_class: runClass,
          author_model: author,
          fixer_model: fixer,
          escalate_after: escalateAfter,
          max_author_turns: maxAuthorTurns,
          max_fixer_turns: maxFixerTurns,
          allow_sql_fallback: allowSqlFallback,
          steer_instead_of_escalate: steerInsteadOfEscalate,
          reasoning,
          provider: provider ?? null,
          substrate: 'motherduck',
          malloy_runtime: 'node-inprocess',
          malloy_model_hash: prov.malloy_model_hash,
          malloy_provenance: prov.malloy_provenance,
          manual_included: prov.manual_included,
          // (config_hash is derived from this object by runMetadata())
          split,
          database,
          central_layer_chars: store.centralLayerChars(),
          authoring_model: prov.authoring_model,
        },
        commitSha,
        repo: gitOutput('config --get remote.origin.url'),
        dirty: dirtyFiles.length > 0, // uncommitted TRACKED code (not untracked logs/other projects)
        dirtyFiles,
        agentName: AGENT_ID, datasetName: database, datasetVersion: split,
      });

      // Bounded pool: each item runs the per-question runner (which NEVER throws
      // out — it returns an EvalTaskOutcome), so one question's failure can't
      // abort its siblings.
      await runPool(questions, concurrency, async (q) => {
        const outcome = await runEvalTask(q, ctx);
        await writeRow(JSON.stringify(outcome.row));
        completed++;
        if (outcome.isCorrect) correct++;
        const mark = outcome.isCorrect ? '✓' : outcome.correctness;
        const fail = outcome.failureStage ? `  (${outcome.failureStage}:${outcome.failureKind})` : '';
        console.log(`  [${completed}/${questions.length}] ${outcome.taskId} ${mark}: ${String(outcome.predictedAnswer).slice(0, 40)}${outcome.escalated ? '  (escalated)' : ''}${fail}`);
        return outcome;
      });
    });
  } finally {
    await cl.flushSession(session); // always flush, even if the run threw mid-way
    try { await runtime.close(); } catch { /* ignore */ }
    try { await localRuntime.close(); } catch { /* ignore */ }
    try { scorer.close(); } catch { /* ignore */ }
  }

  const pct = questions.length ? ((correct / questions.length) * 100).toFixed(1) : '0';
  console.log(`\naccuracy: ${correct}/${questions.length} = ${pct}%`);
  console.log(`results:  ${outPath}`);
  console.log(`controllog: ${path.join(RESULTS_DIR, 'controllog')}`);
}

async function cmdLayerBuild(flags: Record<string, string | boolean>) {
  const model = resolveModel((flags.model as string) || 'opus');
  const includeManual = flags['no-manual'] ? false : true;
  const reasoning = (flags.reasoning as string) || 'medium';
  const provider = (flags.provider as string) || process.env.OPENROUTER_PROVIDER || undefined;

  // Wrap in a controllog session so the build is observable (model exchanges +
  // compile checks) in the dive's "Build" tab. Flushed to results/controllog/.
  cl.init({ project: PROJECT_ID, logDir: RESULTS_DIR, agentId: 'agent:asm-malloy-builder' });
  const session = cl.createSession();
  const runId = cl.newId();
  let res!: Awaited<ReturnType<typeof buildDabstepLayer>>;
  await cl.runInSession(session, async () => {
    res = await buildDabstepLayer({ model, includeManual, reasoningEffort: reasoning, maxRounds: Number(flags['max-rounds'] ?? 5), centralOnly: !!flags['central-only'], provider, runId });
  });
  await cl.flushSession(session);
  console.log(`  build run_id ${runId} logged to results/controllog (upload to view in the dive's Build tab)`);
  if (res.ok) {
    console.log(`\n✓ layer built · hash ${res.malloyModelHash} · $${res.cost.toFixed(4)}`);
    console.log(`  files: ${res.files.join(', ')}`);
    console.log(`  (model_authored; manual_included=${includeManual})`);
  } else {
    console.error(`\n✗ layer-build failed ($${res.cost.toFixed(4)}). Last diagnostics:\n${res.diagnostics}`);
    process.exit(1);
  }
}

async function cmdLayerImprove(flags: Record<string, string | boolean>) {
  const fromFlag = flags.from as string | undefined;
  if (!fromFlag) throw new Error('layer-improve needs --from <results.jsonl> (an eval run to triage).');
  const fromPath = path.isAbsolute(fromFlag) ? fromFlag : path.join(REPO_ROOT, fromFlag);
  const model = resolveModel((flags.model as string) || 'opus');
  const reasoning = (flags.reasoning as string) || 'medium';
  const provider = (flags.provider as string) || process.env.OPENROUTER_PROVIDER || undefined;
  const maxRounds = Number(flags['max-rounds'] ?? 4);
  // Default: triage + validate against the LOCAL compile DB (credential-free,
  // same data, matches the build gate). --md re-executes against MotherDuck.
  const motherduckDb = flags.md ? ((flags.database as string) || process.env.MD_DATABASE || 'agentic_malloy') : undefined;
  // --no-manner skips the per-miss failure-MANNER model call (cheaper; model
  // call then fires only for layer-suspected misses). --apply-skill-fixes is
  // OPT-IN: by default a diagnosed tool-error rule is only RECOMMENDED, not
  // written to src/skill.md — a default run never mutates a tracked file, and an
  // official re-eval can't silently score on an uncommitted prompt change.
  const manner = !flags['no-manner'];
  const applySkillFixes = !!flags['apply-skill-fixes'];
  const toolErrorThreshold = flags['tool-error-threshold'] ? Number(flags['tool-error-threshold']) : undefined;

  // Wrap in a controllog session so the improve pass shows in the dive's Build tab.
  cl.init({ project: PROJECT_ID, logDir: RESULTS_DIR, agentId: 'agent:asm-malloy-builder' });
  const session = cl.createSession();
  const runId = cl.newId();
  let res!: Awaited<ReturnType<typeof improveLayer>>;
  await cl.runInSession(session, async () => {
    res = await improveLayer({ fromPath, model, reasoningEffort: reasoning, provider, maxRounds, motherduckDb, manner, applySkillFixes, toolErrorThreshold, controllogDir: path.join(RESULTS_DIR, 'controllog'), runId });
  });
  await cl.flushSession(session);

  console.log(`\n${res.summary}`);
  console.log(`\n  cost $${res.cost.toFixed(4)} · improve run_id ${runId} logged to results/controllog`);
  if (!res.ok) {
    console.error(`\n✗ layer-improve did not complete cleanly: ${res.diagnostics}`);
    process.exit(1);
  }

  // --re-eval: only meaningful when edits were applied. Re-run the SAME task-ids
  // the --from run covered (passers + fixed) so both the fix AND no-regression
  // are measured. A no-op edit set means nothing changed — skip.
  if (flags['re-eval']) {
    if (!res.editsApplied) {
      console.log(`\n--re-eval skipped: no layer edits were applied (nothing changed to measure).`);
      return;
    }
    const ids = (await readFile(fromPath, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => String((JSON.parse(l) as { task_id: unknown }).task_id));
    // A successful repair leaves the edited layer/skill UNCOMMITTED, and an
    // official run refuses a dirty tree. So an in-process official re-eval is
    // self-contradictory — measure now as SMOKE, and point the user at the
    // commit-then-official flow for a recordable number.
    const reEvalRunClass = (flags['run-class'] === 'official') ? 'smoke' : ((flags['run-class'] as string) || 'smoke');
    if (flags['run-class'] === 'official') {
      console.log(`\nℹ️  re-eval runs as SMOKE: the just-edited layer/provenance${res.skillFixesApplied.length ? '/skill' : ''} is uncommitted, and an official run requires a clean tree. To record an official number: commit the edits, then run \`asm-malloy evaluate --split ${(flags.split as string) || 'templates'} --run-class official --no-steer\`.`);
    }
    console.log(`\n▶ re-evaluating ${ids.length} task-id(s) from ${path.basename(fromPath)} to measure the improvement (run_class=${reEvalRunClass}) …`);
    await cmdEvaluate({ ...flags, 'run-class': reEvalRunClass, 'task-id': ids.join(','), from: undefined as unknown as string });
  }
}

async function cmdUpload(flags: Record<string, string | boolean>) {
  const database = (flags.database as string) || process.env.CONTROLLOG_DB || 'agentic_malloy_logs';
  console.log(`Uploading controllog → MotherDuck ${database}.main.{events,postings} …`);
  const { events, postings } = await uploadControllog({ database });
  console.log(`  events:   ${events.toLocaleString()}`);
  console.log(`  postings: ${postings.toLocaleString()}`);
  console.log(`✓ uploaded to ${database} (dive reads ${database}.main.events / .postings)`);
}

async function cmdSummary(file: string) {
  const rows = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const correct = rows.filter((r) => r.is_correct).length;
  console.log(`${file}`);
  console.log(`accuracy: ${correct}/${rows.length} = ${((correct / rows.length) * 100).toFixed(1)}%`);
  const byCat: Record<string, number> = {};
  for (const r of rows) byCat[r.correctness] = (byCat[r.correctness] ?? 0) + 1;
  console.log('breakdown:', JSON.stringify(byCat));
  // Answer-kind split + accuracy within each kind (how much Malloy vs SQL carried,
  // and how reliable each was). Rows from older runs without answer_kind → 'unknown'.
  const byKind: Record<string, { n: number; correct: number }> = {};
  for (const r of rows) {
    const k = (r.answer_kind as string) ?? (r.submitted === false ? 'no-submission' : 'unknown');
    (byKind[k] ??= { n: 0, correct: 0 }).n++;
    if (r.is_correct) byKind[k].correct++;
  }
  const kindStr = Object.entries(byKind)
    .map(([k, v]) => `${k}: ${v.n} (${v.correct}/${v.n} correct)`)
    .join(' · ');
  console.log('answer_kind:', kindStr);
}

/**
 * usage-report: substrate-value metrics over a completed run's results JSONL —
 * answer-path economics, share-of-logic, central-vs-per-query, view utilization, and
 * the answer-time context-token breakdown. Read-only + local (loads the on-disk layer
 * + skill/primer/glossary; no MCP/network). `--json <path>` writes the report object.
 */
async function cmdUsageReport(flags: Record<string, string | boolean>, file: string) {
  if (!file) throw new Error('usage: asm-malloy usage-report <results.jsonl> [--json out.json]');
  const rows = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const store = new MalloyStore();
  await store.load();
  const layerIndex = await loadLayerIndex();
  const skill = await readFile(SKILL_PATH, 'utf8');
  const primer = await readFile(path.join(REPO_ROOT, 'docs', 'malloy', 'malloy-primer.md'), 'utf8');
  const glossaryBlock = renderGlossaryForAnswering(await loadGlossaryArtifact(META_DIR));
  const report = computeUsageReport(rows, {
    centralLayerChars: store.centralLayerChars(),
    layerIndex,
    contextChars: { skill: skill.length, primer: primer.length, glossary: glossaryBlock.length },
  });
  console.log(formatUsageReport(report, file));
  if (typeof flags.json === 'string') {
    await writeFile(flags.json, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${flags.json}`);
  }
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.join(REPO_ROOT, '.env'));
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

async function main() {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'load':
      return cmdLoad(flags);
    case 'malloy-preflight':
      return cmdPreflight();
    case 'layer-build':
      return cmdLayerBuild(flags);
    case 'layer-improve':
      return cmdLayerImprove(flags);
    case 'evaluate':
      return cmdEvaluate(flags);
    case 'upload':
      return cmdUpload(flags);
    case 'summary':
      return cmdSummary(rest[0]);
    case 'usage-report':
      return cmdUsageReport(flags, rest[0]);
    default:
      console.log('usage: asm-malloy <load|malloy-preflight|layer-build|layer-improve|evaluate|upload|summary|usage-report> [flags]');
      console.log('  load [--motherduck --database agentic_malloy]');
      console.log('  layer-build --model opus --reasoning medium [--no-manual] [--max-rounds 3] [--provider anthropic]');
      console.log('  layer-improve --from results/RUN.jsonl [--model opus --reasoning medium --max-rounds 4] \\');
      console.log('           [--provider anthropic] [--md [--database agentic_malloy]] [--no-manner] [--apply-skill-fixes] \\');
      console.log('           [--tool-error-threshold 0.15] [--re-eval --author sonnet --fixer opus]');
      console.log('           (triages a run\'s misses by MANNER of failure + runs a tool-error meta-analysis;');
      console.log('            edits the layer ONLY for structural defects from TRAIN-only runs, never tunes to a gold answer;');
      console.log('            tool-error rules are recommend-only unless --apply-skill-fixes;');
      console.log('            --re-eval measures edits as SMOKE — commit, then `evaluate --run-class official --no-steer` to record a number)');
      console.log('  evaluate --split templates|test|all --task-id ID --author sonnet --fixer opus \\');
      console.log('           --run-class smoke|official --escalate-after 2 --concurrency 4 --limit N [--provider anthropic] [--sql-fallback] [--no-steer]');
      console.log('           (--provider pins the OpenRouter upstream; defaults to $OPENROUTER_PROVIDER)');
      console.log('           (SQL is prohibited as an answer substrate — answers must be Malloy; duckdb.sql(...) is rejected. --sql-fallback re-enables the submit_sql arm; OFF by default)');
      console.log('           (in-place steer is the default/opus-free; --no-steer restores the opus failover and is REQUIRED for --run-class official)');
      console.log('  upload [--database agentic_malloy_logs]   # controllog JSONL -> MotherDuck for the dive');
      console.log('  usage-report <results.jsonl> [--json out.json]   # substrate-value metrics for a run (read-only, local)');
  }
}

// Auto-run as the CLI entrypoint (bin/asm-malloy.ts imports this for its side
// effect). Skip under vitest, which imports this module to unit-test the
// exported per-task runner without invoking the CLI.
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
