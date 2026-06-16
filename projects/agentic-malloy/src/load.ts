/**
 * Build the LOCAL DuckDB file (data/dabstep.duckdb) from the DABstep source
 * CSV/JSON, preserving the native DABstep column names (the manual, SQL
 * patterns, and Malloy models all reference `merchant`, `eur_amount`,
 * `has_fraudulent_dispute`, `aci`, etc., so nothing is renamed).
 *
 * This local DB is what Malloy COMPILES against (schema introspection) and what
 * the translation-check runs against. The scored answer + exploration execute on
 * MotherDuck via MCP — see the plan's substrate note. The schema here is
 * byte-identical to the MotherDuck build (same sources, same load SQL), so
 * compiled SQL is portable between them.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXT_DIR = path.join(REPO_ROOT, 'data', 'dabstep', 'context');
export const LOCAL_DB_PATH = path.join(REPO_ROOT, 'data', 'dabstep.duckdb');

/** Per-table CREATE statements. Native column names preserved throughout. */
const TABLE_SQL: Record<string, (ctx: string) => string> = {
  payments: (ctx) =>
    `CREATE OR REPLACE TABLE payments AS SELECT * FROM read_csv_auto('${ctx}/payments.csv', header=true)`,
  fees: (ctx) =>
    `CREATE OR REPLACE TABLE fees AS SELECT * FROM read_json_auto('${ctx}/fees.json')`,
  merchants: (ctx) =>
    `CREATE OR REPLACE TABLE merchants AS SELECT * FROM read_json_auto('${ctx}/merchant_data.json')`,
  acquirer_countries: (ctx) =>
    `CREATE OR REPLACE TABLE acquirer_countries AS SELECT * FROM read_csv_auto('${ctx}/acquirer_countries.csv', header=true)`,
  merchant_category_codes: (ctx) =>
    `CREATE OR REPLACE TABLE merchant_category_codes AS SELECT * FROM read_csv_auto('${ctx}/merchant_category_codes.csv', header=true)`,
};

export async function buildLocalDuckDB(dbPath: string = LOCAL_DB_PATH): Promise<Record<string, number>> {
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const counts: Record<string, number> = {};
  try {
    for (const [table, sqlFor] of Object.entries(TABLE_SQL)) {
      await conn.run(sqlFor(CONTEXT_DIR));
      const reader = await conn.runAndReadAll(`SELECT count(*) AS n FROM ${table}`);
      const rows = reader.getRowObjects() as Array<{ n: bigint | number }>;
      counts[table] = Number(rows[0].n);
    }
  } finally {
    conn.closeSync();
  }
  return counts;
}

// Allow `tsx src/load.ts` to build directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  buildLocalDuckDB()
    .then((counts) => {
      console.log(`Built ${LOCAL_DB_PATH}`);
      for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(26)} ${n.toLocaleString()}`);
    })
    .catch((err) => {
      console.error('load failed:', err);
      process.exit(1);
    });
}
