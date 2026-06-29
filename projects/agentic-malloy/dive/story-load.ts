/**
 * story-load.ts — curate the `agentic_malloy_story` MotherDuck database that backs
 * the "Malloy vs. Context" story Dive. Runs as a LOCAL DuckDB process attached to
 * `md:` (mirrors src/load.ts): reads the Malloy arm from the controllog share
 * `agentic_malloy_logs`, the baseline arm + all documents from LOCAL files, and
 * writes curated, dive-friendly tables into MotherDuck.
 *
 * v2 adds (per the Codex review): per-run answer-mix (% SQL vs Malloy), train +
 * rebuilt-layer runs (overfit + rebuild stories), the baseline SKILL.md + context
 * items (the tuning-asymmetry fairness panel), and a computed view_utilization table
 * (the "layer is bypassed" proof, no longer hardcoded).
 *
 * The canonical ≥99% baseline lives in ../agentic-sql-claude-edition/results/ (the
 * shared MD `agentic_sql_results` table only has older 424-task runs); we load it
 * from disk so both arms sit on the same 419-task set + DABstep scorer.
 *
 * Run:  MOTHERDUCK_TOKEN=… npx tsx dive/story-load.ts
 */
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MALLOY_ROOT = path.resolve(HERE, '..');
const PROJECTS = path.resolve(HERE, '..', '..');
const ASC = path.join(PROJECTS, 'agentic-sql-claude-edition');
const BASELINE_FILE = path.join(ASC, 'results', 'test_20260624T203750Z.jsonl');
const BASELINE_SKILL = path.join(ASC, 'skill', 'SKILL.md');
const BASELINE_CTX_GLOB = path.join(ASC, 'context', 'items', '*.md');
const LAYER_GLOB = path.join(MALLOY_ROOT, 'malloy', 'models', '*.malloy');
const SKILL_FILE = path.join(MALLOY_ROOT, 'src', 'skill.md');
const DOCS_GLOB = path.join(MALLOY_ROOT, 'docs', '*.md');
const PROVENANCE = path.join(MALLOY_ROOT, 'malloy', '.provenance.json');

const STORY_DB = 'agentic_malloy_story';
const LOGS = 'agentic_malloy_logs.main.events';
const COMMITTED = 'd7a2545e3a8300b0';   // the model-authored layer all held-out runs used
const REBUILT = 'a2a8a381704acf52';     // the parked rebuild (fixed the AVG defect, net -2 train)

/** The 27 always-fail held-out task_ids (root-cause-always-fail.md §1). 1445 excluded (missed 3/4). */
const ALWAYS_FAIL = [
  '1443','1444','1446','1447','1448','1449','1450','1452','1453','1454','1455',
  '1456','1457','1458','1459','1460','1461','1462', '2571','2712','2727',
  '49','66','67','70','71','72',
];
const sqlList = (xs: string[]) => xs.map((x) => `'${x}'`).join(',');

/** Per-run aggregate over evaluation_result, reused for both held-out and train runs. */
const EV_AGG = `
  SELECT run_id,
    any_value(payload_json.author_model)      AS author_model,
    any_value(payload_json.fixer_model)       AS fixer_model,
    any_value(payload_json.run_class)         AS run_class,
    any_value(payload_json.malloy_model_hash) AS layer_hash,
    min(event_time)                           AS started,
    count(*)                                  AS n,
    sum(payload_json.is_correct::int)         AS correct,
    sum((payload_json.level='hard')::int)                              AS n_hard,
    sum((payload_json.level='hard' AND payload_json.is_correct)::int)  AS correct_hard,
    sum((payload_json.level='easy')::int)                              AS n_easy,
    sum((payload_json.level='easy' AND payload_json.is_correct)::int)  AS correct_easy,
    median(payload_json.input_tokens)         AS median_prompt_tokens,
    sum(payload_json.input_tokens+payload_json.output_tokens) AS total_tokens,
    sum(payload_json.cost_usd)                AS cost_usd,
    sum(payload_json.escalated::int)          AS escalations,
    sum(payload_json.hit_limit::int)          AS hit_limit,
    sum((coalesce(payload_json.answer_kind,'')='sql')::int) AS n_sql,
    sum((payload_json.malloy_source IS NOT NULL AND len(payload_json.malloy_source)>0)::int) AS n_malloy
  FROM ${LOGS} WHERE kind='evaluation_result' GROUP BY run_id`;

/** Derive a model-tier label from author/fixer (so train vs held-out compares like-for-like). */
const TIER = `CASE
  WHEN author_model ILIKE '%gemini%' THEN 'gemini'
  WHEN fixer_model ILIKE '%opus-4.8%' THEN 'sonnet+opus4.8'
  WHEN fixer_model ILIKE '%opus%' THEN 'sonnet+opus'
  WHEN author_model ILIKE '%sonnet%' THEN 'sonnet only'
  ELSE 'other' END`;

const LAYER_LABEL = `CASE layer_hash WHEN '${COMMITTED}' THEN 'committed' WHEN '${REBUILT}' THEN 'rebuilt' ELSE layer_hash END`;

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN ?? '';
  if (!token) throw new Error('MOTHERDUCK_TOKEN is required (see .env).');
  process.env.motherduck_token = token;
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const run = (sql: string) => conn.run(sql);
  const rows = async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjects();

  try {
    await run("ATTACH 'md:'");
    await run(`CREATE DATABASE IF NOT EXISTS ${STORY_DB}`);
    const S = `${STORY_DB}.main`;

    // ── runs ──────────────────────────────────────────────────────────────────
    await run(`CREATE OR REPLACE TABLE ${S}.runs AS
      WITH ev AS (${EV_AGG}),
      base_cols AS (
        SELECT *, ${TIER} AS tier, ${LAYER_LABEL} AS layer_label,
          round(100.0*correct/n,1) AS acc_pct,
          round(100.0*correct_hard/nullif(n_hard,0),1) AS hard_acc,
          round(100.0*correct_easy/nullif(n_easy,0),1) AS easy_acc,
          round(100.0*n_sql/n,1)    AS pct_sql,
          round(100.0*n_malloy/n,1) AS pct_malloy
        FROM ev
      ),
      malloy_holdout AS (
        SELECT run_id::VARCHAR AS run_id, 'malloy' AS arm, 'test' AS split,
          CASE correct
            WHEN 382 THEN 'Malloy · sonnet+opus · official'
            WHEN 370 THEN 'Malloy · sonnet+opus · official (pre-fix)'
            WHEN 354 THEN 'Malloy · sonnet+opus4.8 · new-harness'
            WHEN 295 THEN 'Malloy · gemini · controlled (low)'
            ELSE 'Malloy · gemini · new-harness ' || strftime(started,'%m-%d') END AS run_label,
          tier, layer_hash, layer_label, run_class, author_model, fixer_model,
          started, n, correct, acc_pct, n_hard, correct_hard, hard_acc,
          n_easy, correct_easy, easy_acc, median_prompt_tokens, total_tokens, cost_usd,
          escalations, hit_limit, n_sql, n_malloy, pct_sql, pct_malloy,
          (correct = 295) AS controlled_pair
        FROM base_cols WHERE n >= 100 AND layer_hash = '${COMMITTED}'
      ),
      malloy_train AS (
        SELECT run_id::VARCHAR AS run_id, 'malloy' AS arm, 'train' AS split,
          'train · ' || tier || ' · ' || layer_label AS run_label,
          tier, layer_hash, layer_label, run_class, author_model, fixer_model,
          started, n, correct, acc_pct, n_hard, correct_hard, hard_acc,
          n_easy, correct_easy, easy_acc, median_prompt_tokens, total_tokens, cost_usd,
          escalations, hit_limit, n_sql, n_malloy, pct_sql, pct_malloy,
          false AS controlled_pair
        FROM base_cols WHERE n BETWEEN 20 AND 40 AND layer_hash IN ('${COMMITTED}','${REBUILT}')
      ),
      baseline AS (
        SELECT 'baseline-canonical' AS run_id, 'baseline' AS arm, 'test' AS split,
          'Baseline · markdown+SQL (gemini)' AS run_label,
          'gemini (markdown+SQL)' AS tier, NULL AS layer_hash, 'n/a (markdown+SQL)' AS layer_label,
          'official' AS run_class, any_value(model) AS author_model, NULL AS fixer_model,
          NULL::TIMESTAMP AS started,
          count(*) AS n, sum(is_correct::int) AS correct, round(100.0*sum(is_correct::int)/count(*),1) AS acc_pct,
          sum((level='hard')::int) AS n_hard, sum((level='hard' AND is_correct)::int) AS correct_hard,
          round(100.0*sum((level='hard' AND is_correct)::int)/sum((level='hard')::int),1) AS hard_acc,
          sum((level='easy')::int) AS n_easy, sum((level='easy' AND is_correct)::int) AS correct_easy,
          round(100.0*sum((level='easy' AND is_correct)::int)/sum((level='easy')::int),1) AS easy_acc,
          median(prompt_tokens) AS median_prompt_tokens,
          sum(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) AS total_tokens,
          sum(cost_usd) AS cost_usd, 0 AS escalations, sum(hit_limit::int) AS hit_limit,
          0 AS n_sql, 0 AS n_malloy, 0.0 AS pct_sql, 0.0 AS pct_malloy, true AS controlled_pair
        FROM read_json_auto('${BASELINE_FILE}')
      )
      SELECT * FROM malloy_holdout
      UNION ALL BY NAME SELECT * FROM malloy_train
      UNION ALL BY NAME SELECT * FROM baseline`);

    // ── results ───────────────────────────────────────────────────────────────
    await run(`CREATE OR REPLACE TABLE ${S}.results AS
      WITH malloy AS (
        SELECT e.run_id::VARCHAR AS run_id, r.run_label, r.split, r.tier, r.layer_label, 'malloy' AS arm,
          e.payload_json.question_id::VARCHAR AS task_id, e.payload_json.level AS level,
          e.payload_json.is_correct AS is_correct, e.payload_json.predicted_result AS predicted,
          e.payload_json.gold_result AS gold, e.payload_json.compiled_sql AS compiled_sql,
          e.payload_json.malloy_source AS malloy_source,
          (e.payload_json.malloy_source IS NOT NULL AND len(e.payload_json.malloy_source)>0) AS has_malloy,
          e.payload_json.answer_kind AS answer_kind,
          CASE WHEN e.payload_json.answer_kind='sql' THEN 'sql'
               WHEN e.payload_json.malloy_source IS NOT NULL AND len(e.payload_json.malloy_source)>0 THEN 'authored'
               ELSE 'other' END AS answer_path,
          e.payload_json.cost_usd AS cost_usd, e.payload_json.input_tokens AS prompt_tokens,
          e.payload_json.tool_calls AS tool_calls, e.payload_json.escalated AS escalated,
          e.payload_json.fixer_turns AS fixer_turns, e.payload_json.failure_kind AS failure_kind,
          e.payload_json.hit_limit AS hit_limit
        FROM ${LOGS} e JOIN ${S}.runs r ON r.run_id = e.run_id::VARCHAR
        WHERE e.kind='evaluation_result' AND r.arm='malloy'
      ),
      baseline AS (
        SELECT 'baseline-canonical' AS run_id, 'Baseline · markdown+SQL (gemini)' AS run_label,
          'test' AS split, 'gemini (markdown+SQL)' AS tier, 'n/a (markdown+SQL)' AS layer_label, 'baseline' AS arm,
          task_id::VARCHAR AS task_id, level, is_correct, predicted_answer AS predicted, gold_answer AS gold,
          predicted_sql AS compiled_sql, NULL AS malloy_source, false AS has_malloy, 'sql' AS answer_kind,
          'sql' AS answer_path, cost_usd, prompt_tokens, n_tool_calls AS tool_calls,
          false AS escalated, 0 AS fixer_turns, NULL AS failure_kind, hit_limit
        FROM read_json_auto('${BASELINE_FILE}')
      )
      SELECT * FROM malloy UNION ALL BY NAME SELECT * FROM baseline`);

    // ── tasks ───────────────────────────────────────────────────────────────
    await run(`CREATE OR REPLACE TABLE ${S}.tasks AS
      SELECT task_id::VARCHAR AS task_id, level, split, question AS question_text, gold_answer AS gold_result,
        (task_id::VARCHAR IN (${sqlList(ALWAYS_FAIL)})) AS always_fail,
        CASE WHEN TRY_CAST(task_id AS INTEGER) BETWEEN 1443 AND 1462 THEN 'aci_most_expensive_template' END AS family
      FROM read_json_auto('${BASELINE_FILE}')`);

    // ── documents (Malloy skill + layer + docs, AND the baseline skill + context) ──
    await run(`CREATE OR REPLACE TABLE ${S}.documents AS
      SELECT 'skill' AS kind, 'skill.md' AS title, 'md' AS lang, regexp_replace(filename,'.*/','') AS file, content FROM read_text('${SKILL_FILE}')
      UNION ALL BY NAME
      SELECT 'layer' AS kind, regexp_replace(filename,'.*/','') AS title, 'malloy' AS lang, regexp_replace(filename,'.*/','') AS file, content FROM read_text('${LAYER_GLOB}')
      UNION ALL BY NAME
      SELECT 'doc' AS kind, regexp_replace(filename,'.*/','') AS title, 'md' AS lang, regexp_replace(filename,'.*/','') AS file, content FROM read_text('${DOCS_GLOB}')
      UNION ALL BY NAME
      SELECT 'baseline_skill' AS kind, 'SKILL.md' AS title, 'md' AS lang, 'SKILL.md' AS file, content FROM read_text('${BASELINE_SKILL}')
      UNION ALL BY NAME
      SELECT 'baseline_context' AS kind, regexp_replace(filename,'.*/','') AS title, 'md' AS lang, regexp_replace(filename,'.*/','') AS file, content FROM read_text('${BASELINE_CTX_GLOB}')
      UNION ALL BY NAME
      SELECT 'provenance' AS kind, '.provenance.json' AS title, 'json' AS lang, '.provenance.json' AS file, content FROM read_text('${PROVENANCE}')`);

    // ── layer view inventory + utilization (computed, word-boundary match) ─────
    await run(`CREATE OR REPLACE TABLE ${S}.layer_views AS
      SELECT DISTINCT trim(replace(u.v,'view:','')) AS view_name, d.title AS file
      FROM ${S}.documents d, UNNEST(regexp_extract_all(d.content,'view:\\s*\\w+')) AS u(v)
      WHERE d.kind='layer'`);

    // reclassify Malloy answers that REUSE a named layer view as 'view' (vs 'authored' from scratch).
    // This yields the view-selection / authored-malloy / sql split (the 47 / 134 / 237 evidence).
    await run(`UPDATE ${S}.results SET answer_path='view'
      WHERE arm='malloy' AND answer_path='authored' AND malloy_source IS NOT NULL
        AND EXISTS (SELECT 1 FROM ${S}.layer_views v WHERE regexp_matches(malloy_source, '\\b' || v.view_name || '\\b'))`);

    // per view: how many submitted Malloy answers reference it (across all malloy runs)
    await run(`CREATE OR REPLACE TABLE ${S}.view_utilization AS
      SELECT v.view_name, v.file,
        (SELECT count(*) FROM ${S}.results r
           WHERE r.arm='malloy' AND r.has_malloy
             AND regexp_matches(r.malloy_source, '\\b' || v.view_name || '\\b')) AS referenced,
        ((SELECT count(*) FROM ${S}.results r
           WHERE r.arm='malloy' AND r.has_malloy
             AND regexp_matches(r.malloy_source, '\\b' || v.view_name || '\\b')) > 0) AS used
      FROM ${S}.layer_views v ORDER BY referenced DESC`);

    // per held-out run: how many DISTINCT layer views it actually used (the "12-17" figure)
    await run(`CREATE OR REPLACE TABLE ${S}.run_view_usage AS
      SELECT r.run_label, count(DISTINCT v.view_name) AS views_used
      FROM ${S}.results r JOIN ${S}.layer_views v
        ON r.has_malloy AND regexp_matches(r.malloy_source, '\\b' || v.view_name || '\\b')
      WHERE r.arm='malloy' AND r.split='test'
      GROUP BY r.run_label`);

    // ── trace_events: fold the held-out runs' traces into the OWNED story DB ──
    // so the dive depends only on agentic_malloy_story (shareable via share_dive_data),
    // not on the attached agentic_malloy_logs share.
    await run(`CREATE OR REPLACE TABLE ${S}.trace_events AS
      SELECT
        e.run_id::VARCHAR AS run_id,
        r.run_label,
        e.actor_task_id AS task_id,
        e.kind,
        e.payload_json.name      AS tool,
        e.payload_json.status    AS status,
        e.payload_json.duration_ms AS ms,
        coalesce(e.payload_json.arguments.sql, e.payload_json.arguments.source, e.payload_json.arguments.query) AS arg,
        list_aggregate(e.payload_json.arguments.files, 'string_agg', ', ') AS files,
        left(e.payload_json.output, 1500) AS output,
        strftime(e.event_time, '%H:%M:%S') AS t,
        row_number() OVER (PARTITION BY e.run_id, e.actor_task_id ORDER BY e.event_time, e.event_id) AS ord
      FROM ${LOGS} e
      JOIN ${S}.runs r ON r.run_id = e.run_id::VARCHAR AND r.arm='malloy' AND r.split='test'
      WHERE e.kind IN ('tool_call','tool_result','model_completion')`);

    // ── verification ──────────────────────────────────────────────────────────
    console.log(`\nBuilt md:${STORY_DB}\n`);
    console.log('held-out matrix (with answer-mix):');
    for (const r of await rows(
      `SELECT run_label, n, correct, acc_pct, hard_acc, easy_acc, pct_sql, pct_malloy,
              round(median_prompt_tokens) AS tok, round(cost_usd,2) AS cost
       FROM ${S}.runs WHERE split='test' ORDER BY arm, correct DESC`)) {
      console.log(`  ${String(r.run_label).padEnd(42)} ${r.correct}/${r.n}=${r.acc_pct}%  H${r.hard_acc} E${r.easy_acc}  sql%${r.pct_sql} mal%${r.pct_malloy}  ${r.tok}tok $${r.cost}`);
    }
    console.log('\ntrain runs (overfit + rebuild):');
    for (const r of await rows(
      `SELECT layer_label, tier, count(*) runs, round(avg(acc_pct),1) avg_acc, min(correct) mn, max(correct) mx, round(avg(n)) AS n
       FROM ${S}.runs WHERE split='train' GROUP BY layer_label, tier ORDER BY layer_label, tier`)) {
      console.log(`  ${String(r.layer_label).padEnd(10)} ${String(r.tier).padEnd(16)} ${r.runs} runs · avg ${r.avg_acc}% · range ${r.mn}-${r.mx}/${r.n}`);
    }
    const vu = await rows(`SELECT count(*) AS defined, sum(used::int) AS used FROM ${S}.view_utilization`);
    console.log(`\nview_utilization: ${vu[0].used} of ${vu[0].defined} views ever referenced (across all malloy runs)`);
    for (const r of await rows(`SELECT run_label, views_used FROM ${S}.run_view_usage ORDER BY views_used DESC`)) {
      console.log(`  per-run distinct views used: ${String(r.run_label).padEnd(42)} ${r.views_used}`);
    }
    console.log('answer-path split (official run — the 47/134/237 proxy evidence):');
    for (const r of await rows(`SELECT answer_path, count(*) AS n FROM ${S}.results WHERE run_label='Malloy · sonnet+opus · official' GROUP BY answer_path ORDER BY n DESC`)) {
      console.log(`  ${String(r.answer_path).padEnd(10)} ${r.n}`);
    }
    const docs = await rows(`SELECT kind, count(*) AS n FROM ${S}.documents GROUP BY kind ORDER BY kind`);
    console.log('documents:', docs.map((d) => `${d.kind}=${d.n}`).join(' · '));
    const counts = await rows(`SELECT
      (SELECT count(*) FROM ${S}.runs) AS runs, (SELECT count(*) FROM ${S}.results) AS results,
      (SELECT count(*) FROM ${S}.tasks) AS tasks, (SELECT count(*) FROM ${S}.layer_views) AS n_views,
      (SELECT count(*) FROM ${S}.trace_events) AS trace_events`);
    console.log('counts:', counts[0]);
  } finally {
    conn.closeSync();
  }
}

main().catch((err) => { console.error('story-load failed:', err); process.exit(1); });
