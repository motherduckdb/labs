/**
 * Upload controllog JSONL → MotherDuck so the divemaxxing dashboard (a MotherDuck
 * Dive reading `<db>.main.events` / `.postings`) can read it.
 *
 * Mirrors devrel-writing-v2/.../sql/load_dabstep_logs.sql: CREATE OR REPLACE the
 * two tables via read_json_auto so `payload_json` / `dims_json` parse into typed
 * STRUCTs (the dive does `payload_json.field` struct access — a plain JSON column
 * would break it). controllog appends every run to one events.jsonl, so a full
 * rebuild each upload is idempotent and keeps all runs for cross-run comparison.
 *
 * `map_inference_threshold=-1` is REQUIRED: payload_json holds many distinct keys
 * across event kinds (model/tool/eval/run_metadata/improvement_recommendation/…),
 * and past DuckDB's default MAP-inference threshold read_json_auto flips the column
 * STRUCT→MAP(VARCHAR, JSON). Under a MAP every value is JSON, so the dive's numeric
 * aggregations (`avg(payload_json.duration_ms)`, cost_usd, tokens, …) fail with
 * "avg(JSON)". Disabling MAP inference keeps it a STRUCT with typed fields.
 *
 * `sample_size=-1` is REQUIRED for the same STRUCT: the schema is inferred from a
 * sample, but controllog APPENDS each run, so a newly-added payload key (e.g. a new
 * resolvedConfig field like `allow_sql_fallback`) lands only in the LAST rows —
 * outside a default head-sample — and the reader then throws "unknown key …" on
 * those rows. Scanning all rows infers the full union of keys (new ones nullable
 * for older rows) so schema evolution never breaks the upload.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLOG_DIR = path.join(REPO_ROOT, 'results', 'controllog');

/**
 * Per-run validation-usage rollup (long format: one row per run × validation type)
 * for the Dive's multi-series line chart. Answer-time checks are derived uniformly
 * from the logged events so BOTH historical and future runs are covered:
 *   - lint / answer_shape / raw_sql_ban : scraped from tool_result outputs
 *   - escalation                        : the evaluation_result.escalated flag
 * (The new `quality_finding` events give a finer per-code breakdown for deeper
 * analysis; this rollup stays on the uniform scrape so every past run is comparable.)
 */
function validationUsageSql(db: string): string {
  const E = `${db}.main.events`;
  return `CREATE OR REPLACE TABLE ${db}.main.validation_usage AS
WITH ev AS (
  SELECT run_id, actor_task_id AS task, payload_json.author_model AS model,
         (payload_json.escalated)::BOOLEAN AS escalated
  FROM ${E} WHERE kind='evaluation_result'
),
tr AS (
  SELECT run_id, actor_task_id AS task,
    max(CASE WHEN payload_json.output ILIKE '%[lint applied%' THEN 1 ELSE 0 END) AS lint,
    max(CASE WHEN payload_json.output ILIKE '%NOT YET RECORDED%' OR payload_json.output ILIKE '%answer-shape%' THEN 1 ELSE 0 END) AS answer_shape,
    max(CASE WHEN payload_json.output ILIKE '%raw SQL%' AND payload_json.output ILIKE '%NOT recorded%' THEN 1 ELSE 0 END) AS raw_sql_ban
  FROM ${E} WHERE kind='tool_result'
  GROUP BY 1,2
),
runstart AS (SELECT run_id, min(event_time) AS run_started FROM ${E} GROUP BY 1),
per_task AS (
  SELECT ev.run_id, ev.task, any_value(ev.model) AS model,
    max(CASE WHEN ev.escalated THEN 1 ELSE 0 END) AS escalation,
    COALESCE(max(tr.lint),0) AS lint,
    COALESCE(max(tr.answer_shape),0) AS answer_shape,
    COALESCE(max(tr.raw_sql_ban),0) AS raw_sql_ban
  FROM ev LEFT JOIN tr ON tr.run_id=ev.run_id AND tr.task=ev.task
  GROUP BY ev.run_id, ev.task
),
agg AS (
  SELECT run_id, any_value(model) AS model, count(*) AS n_tasks,
    sum(lint) AS lint, sum(answer_shape) AS answer_shape,
    sum(raw_sql_ban) AS raw_sql_ban, sum(escalation) AS escalation
  FROM per_task GROUP BY run_id
),
long AS (
  SELECT run_id, model, n_tasks, validation_type, n_used
  FROM agg UNPIVOT (n_used FOR validation_type IN (lint, answer_shape, raw_sql_ban, escalation))
)
SELECT l.run_id, r.run_started, l.model, l.n_tasks, l.validation_type, l.n_used,
       round(100.0*l.n_used/l.n_tasks, 2) AS pct
FROM long l JOIN runstart r USING (run_id)
ORDER BY r.run_started, l.validation_type`;
}

export async function uploadControllog(opts: {
  database: string;
  logDir?: string;
  token?: string;
}): Promise<{ events: number; postings: number }> {
  const token = opts.token ?? process.env.MOTHERDUCK_TOKEN;
  if (!token) throw new Error('MOTHERDUCK_TOKEN is required to upload controllog.');
  const dir = opts.logDir ?? CONTROLLOG_DIR;
  const eventsPath = path.join(dir, 'events.jsonl');
  const postingsPath = path.join(dir, 'postings.jsonl');
  if (!existsSync(eventsPath)) throw new Error(`No events.jsonl under ${dir} — run \`evaluate\` first.`);

  process.env.motherduck_token = token;
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const db = opts.database;
  try {
    await conn.run("ATTACH 'md:'");
    await conn.run(`CREATE DATABASE IF NOT EXISTS ${db}`);
    await conn.run(
      `CREATE OR REPLACE TABLE ${db}.main.events AS SELECT * FROM read_json_auto('${eventsPath}', format='newline_delimited', map_inference_threshold=-1, sample_size=-1)`,
    );
    const events = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${db}.main.events`)).getRowObjects()[0].n);
    let postings = 0;
    if (existsSync(postingsPath)) {
      await conn.run(
        `CREATE OR REPLACE TABLE ${db}.main.postings AS SELECT * FROM read_json_auto('${postingsPath}', format='newline_delimited', map_inference_threshold=-1, sample_size=-1)`,
      );
      postings = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${db}.main.postings`)).getRowObjects()[0].n);
    }
    // Derived telemetry: per-run % of questions that triggered each answer-time
    // validation (the Dive's validation-usage line chart reads this). Rebuilt from
    // `events` each upload so it back-populates all history and stays current.
    // A materialized TABLE (not a VIEW) so the next upload's CREATE OR REPLACE TABLE
    // events has no dependent view to fail on.
    await conn.run(validationUsageSql(db));
    return { events, postings };
  } finally {
    conn.closeSync();
  }
}
