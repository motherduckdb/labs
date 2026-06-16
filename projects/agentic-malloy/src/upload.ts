/**
 * Upload controllog JSONL → MotherDuck so the divemaxxing dashboard (a MotherDuck
 * Dive reading `<db>.main.events` / `.postings`) can read it.
 *
 * Mirrors devrel-writing-v2/.../sql/load_dabstep_logs.sql: CREATE OR REPLACE the
 * two tables via read_json_auto so `payload_json` / `dims_json` parse into typed
 * STRUCTs (the dive does `payload_json.field` struct access — a plain JSON column
 * would break it). controllog appends every run to one events.jsonl, so a full
 * rebuild each upload is idempotent and keeps all runs for cross-run comparison.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLOG_DIR = path.join(REPO_ROOT, 'results', 'controllog');

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
      `CREATE OR REPLACE TABLE ${db}.main.events AS SELECT * FROM read_json_auto('${eventsPath}', format='newline_delimited')`,
    );
    const events = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${db}.main.events`)).getRowObjects()[0].n);
    let postings = 0;
    if (existsSync(postingsPath)) {
      await conn.run(
        `CREATE OR REPLACE TABLE ${db}.main.postings AS SELECT * FROM read_json_auto('${postingsPath}', format='newline_delimited')`,
      );
      postings = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ${db}.main.postings`)).getRowObjects()[0].n);
    }
    return { events, postings };
  } finally {
    conn.closeSync();
  }
}
