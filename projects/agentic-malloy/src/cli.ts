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
import { buildSymbolSet } from './linter.js';
import { ScoreClient } from './score-client.js';
import { createMCPClient, getExplorationTools } from './mcp-client.js';
import { buildToolSchemas, newRunState, type ToolDeps } from './tools.js';
import { runTask } from './agentic-loop.js';
import { resolveModel } from './llm-client.js';
import { buildLayer, hashLayerOnDisk, PROVENANCE_PATH } from './layer-build.js';
import { uploadControllog } from './upload.js';
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

interface Question {
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
  const r = await rt.runLocal(q);
  console.log('local run rows =', JSON.stringify(r.rows));
  await rt.close();
  console.log('PREFLIGHT OK');
}

async function cmdEvaluate(flags: Record<string, string | boolean>) {
  const split = (flags.split as string) || 'templates';
  const author = resolveModel((flags.author as string) || 'sonnet');
  const fixer = resolveModel((flags.fixer as string) || 'opus');

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
    if (fixer !== resolveModel('opus')) reasons.push(`fixer must be opus (got ${fixer})`);
    if (reasons.length) {
      throw new Error(`Refusing an OFFICIAL run:\n  - ${reasons.join('\n  - ')}\nUse --run-class smoke for experiments.`);
    }
  }
  const escalateAfter = Number(flags['escalate-after'] ?? 2);
  const maxAuthorTurns = Number(flags['max-author-turns'] ?? 20);
  const maxFixerTurns = Number(flags['max-fixer-turns'] ?? 6);
  const reasoning = (flags.reasoning as string) || 'low';
  const concurrency = Number(flags.concurrency ?? 4);
  // The agentic_malloy MotherDuck DB is built by `load --motherduck`.
  const database = (flags.database as string) || process.env.MD_DATABASE || 'agentic_malloy';
  const limit = flags.limit ? Number(flags.limit) : undefined;

  let questions: Question[];
  if (flags['task-id']) {
    const all = await loadQuestions('all');
    questions = all.filter((q) => String(q.task_id) === String(flags['task-id']));
    if (!questions.length) throw new Error(`task-id ${flags['task-id']} not found`);
  } else {
    questions = await loadQuestions(split);
    if (limit) questions = questions.slice(0, limit);
  }

  const skill = await readFile(SKILL_PATH, 'utf8');
  const primer = await readFile(path.join(REPO_ROOT, 'docs', 'malloy', 'malloy-primer.md'), 'utf8');
  const systemPrompt = `You are an expert data analyst answering factoid questions about a payments dataset by authoring Malloy.\n\nThe MotherDuck database is \`${database}\` (schema main, tables: payments, fees, merchants, acquirer_countries, merchant_category_codes). Exploration tools default to this database.\n\n============ SKILL ============\n${skill}\n\n============ MALLOY PRIMER ============\n${primer}\n===============================`;

  await mkdir(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').slice(0, 15) + 'Z';
  const outPath = path.join(RESULTS_DIR, `${split}_${ts}.jsonl`);

  cl.init({ project: PROJECT_ID, logDir: RESULTS_DIR, agentId: AGENT_ID });
  const session = cl.createSession();
  const runId = cl.newId();

  const store = new MalloyStore();
  await store.load();
  const runtime = new MalloyRuntime();
  const symbols = buildSymbolSet(await runtime.describe());
  const scorer = new ScoreClient();

  console.log(`split=${split} · ${questions.length} q · author=${author} fixer=${fixer} · run_class=${runClass} · provenance=${prov.malloy_provenance} · db=${database} · conc=${concurrency}`);

  let correct = 0;
  let completed = 0;

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
        reasoning,
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
      commitSha: gitOutput('rev-parse HEAD'),
      repo: gitOutput('config --get remote.origin.url'),
      dirty: !!gitOutput('status --porcelain'),
      agentName: AGENT_ID, datasetName: database, datasetVersion: split,
    });

    // Simple concurrency pool.
    let idx = 0;
    const runOne = async (q: Question): Promise<void> => {
      const tid = String(q.task_id);
      cl.stateMove({ taskId: tid, from: 'NEW', to: 'WIP', runId });
      const client = await createMCPClient(`${runId}:${tid}`);
      const t0 = Date.now();
      let result: Awaited<ReturnType<typeof runTask>> | null = null;
      let dispatchErr: string | null = null;
      const state = newRunState();
      try {
        const mcpTools = await getExplorationTools(client);
        const deps: ToolDeps = { client, runtime, store, symbols, database, mcpTools, state };
        result = await runTask({
          question: q.question, guidelines: q.guidelines, systemPrompt,
          toolSchemas: buildToolSchemas(deps), deps,
          authorModel: author, fixerModel: fixer, escalateAfter, maxAuthorTurns, maxFixerTurns,
          reasoningEffort: reasoning, taskId: tid, runId,
        });
      } catch (e) {
        dispatchErr = e instanceof Error ? e.message : String(e);
      } finally {
        await client.close();
      }
      const elapsedMs = Date.now() - t0;

      const scoreResp = await scorer.score({
        rows: state.finalRows ?? null,
        error: state.finalRows ? null : dispatchErr ?? 'no submission',
        gold: q.answer ?? '',
        guidelines: q.guidelines ?? null,
        predicted_sql: state.finalCompiledSql ?? null,
        hit_limit: result?.hitLimit ?? true,
      });

      const reward = scoreResp.is_correct ? 1 : 0;
      cl.stateMove({ taskId: tid, from: 'WIP', to: result ? 'DONE' : 'FAILED', runId });
      cl.utility({ taskId: tid, metric: 'reward', value: reward, runId });
      cl.event({
        kind: 'task_complete', taskId: tid, agentId: AGENT_ID, runId,
        idempotencyKey: `${runId}:task:${tid}`,
        payload: { correctness: scoreResp.correctness, escalated: result?.escalated ?? false, n_tool_calls: result?.toolCallCount ?? 0, duration_ms: elapsedMs },
      });
      cl.event({
        kind: 'evaluation_result', taskId: tid, agentId: AGENT_ID, runId,
        idempotencyKey: `${runId}:eval:${tid}`,
        payload: {
          question_id: tid, question_text: q.question, evidence: q.guidelines, level: q.level,
          config_type: 'malloy', run_class: runClass, database, model: author,
          author_model: author, fixer_model: fixer,
          malloy_provenance: prov.malloy_provenance, malloy_model_hash: prov.malloy_model_hash,
          malloy_source: state.finalMalloy ?? null, malloy_source_chars: state.finalMalloy?.length ?? 0,
          compiled_sql: state.finalCompiledSql ?? null, compiled_sql_chars: state.finalCompiledSql?.length ?? 0,
          translation_match: state.translationMatch ?? null,
          predicted_result: scoreResp.predicted_answer, gold_result: q.answer,
          is_correct: scoreResp.is_correct, correctness_level: scoreResp.correctness, match_source: scoreResp.match_source,
          escalated: result?.escalated ?? false, escalation_reason: result?.escalationReason ?? null,
          fixer_turns: result?.fixerTurns ?? 0, tool_calls: result?.toolCallCount ?? 0,
          files_read: state.filesRead, lint_fixes: state.lintFixesTotal,
          duration_ms: elapsedMs, cost_usd: result?.usage.cost ?? 0,
          input_tokens: result?.usage.promptTokens ?? 0, output_tokens: result?.usage.completionTokens ?? 0,
          error_description: dispatchErr,
        },
      });

      const row = {
        task_id: tid, level: q.level, split, author_model: author, fixer_model: fixer, run_class: runClass,
        question: q.question, guidelines: q.guidelines, gold_answer: q.answer,
        predicted_answer: scoreResp.predicted_answer, is_correct: scoreResp.is_correct, correctness: scoreResp.correctness,
        match_source: scoreResp.match_source, malloy_source: state.finalMalloy ?? null, compiled_sql: state.finalCompiledSql ?? null,
        translation_match: state.translationMatch ?? null,
        escalated: result?.escalated ?? false, fixer_turns: result?.fixerTurns ?? 0, tool_calls: result?.toolCallCount ?? 0,
        files_read: state.filesRead, lint_fixes: state.lintFixesTotal, elapsed_s: +(elapsedMs / 1000).toFixed(2),
        cost_usd: result?.usage.cost ?? 0, prompt_tokens: result?.usage.promptTokens ?? 0, completion_tokens: result?.usage.completionTokens ?? 0,
        error: dispatchErr, ts: new Date().toISOString(),
      };
      await appendFile(outPath, JSON.stringify(row) + '\n');

      completed++;
      if (scoreResp.is_correct) correct++;
      const mark = scoreResp.is_correct ? '✓' : scoreResp.correctness;
      console.log(`  [${completed}/${questions.length}] ${tid} ${mark}: ${String(scoreResp.predicted_answer).slice(0, 40)}${result?.escalated ? '  (escalated)' : ''}`);
    };

    const worker = async () => {
      while (idx < questions.length) {
        const q = questions[idx++];
        await runOne(q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, () => worker()));
  });

  await cl.flushSession(session);
  await runtime.close();
  scorer.close();

  const pct = questions.length ? ((correct / questions.length) * 100).toFixed(1) : '0';
  console.log(`\naccuracy: ${correct}/${questions.length} = ${pct}%`);
  console.log(`results:  ${outPath}`);
  console.log(`controllog: ${path.join(RESULTS_DIR, 'controllog')}`);
}

async function cmdLayerBuild(flags: Record<string, string | boolean>) {
  const model = resolveModel((flags.model as string) || 'opus');
  const includeManual = flags['no-manual'] ? false : true;
  const reasoning = (flags.reasoning as string) || 'medium';

  // Wrap in a controllog session so the build is observable (model exchanges +
  // compile checks) in the dive's "Build" tab. Flushed to results/controllog/.
  cl.init({ project: PROJECT_ID, logDir: RESULTS_DIR, agentId: 'agent:asm-malloy-builder' });
  const session = cl.createSession();
  const runId = cl.newId();
  let res!: Awaited<ReturnType<typeof buildLayer>>;
  await cl.runInSession(session, async () => {
    res = await buildLayer({ model, includeManual, reasoningEffort: reasoning, maxRounds: Number(flags['max-rounds'] ?? 3), centralOnly: !!flags['central-only'], runId });
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
    case 'evaluate':
      return cmdEvaluate(flags);
    case 'upload':
      return cmdUpload(flags);
    case 'summary':
      return cmdSummary(rest[0]);
    default:
      console.log('usage: asm-malloy <load|malloy-preflight|layer-build|evaluate|upload|summary> [flags]');
      console.log('  load [--motherduck --database agentic_malloy]');
      console.log('  layer-build --model opus --reasoning medium [--no-manual] [--max-rounds 3]');
      console.log('  evaluate --split templates|test|all --task-id ID --author sonnet --fixer opus \\');
      console.log('           --run-class smoke|official --escalate-after 2 --concurrency 4 --limit N');
      console.log('  upload [--database agentic_malloy_logs]   # controllog JSONL -> MotherDuck for the dive');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
