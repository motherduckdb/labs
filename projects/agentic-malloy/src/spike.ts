/**
 * Phase-0 gate spike: prove @malloydata/malloy + @malloydata/db-duckdb can
 * compile a query to SQL (getSQL) and run it against the local DuckDB.
 * If this works, the whole "Malloy runtime is an in-process library" premise holds.
 */
import { SingleConnectionRuntime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { LOCAL_DB_PATH } from './load.js';

const MODEL = `
source: payments is duckdb.table('payments') extend {
  measure:
    transaction_count is count()
    total_eur is eur_amount.sum()
}
`;

async function main() {
  const connection = new DuckDBConnection('duckdb', LOCAL_DB_PATH);
  const runtime = new SingleConnectionRuntime({ connection });

  const query = `run: payments -> { aggregate: transaction_count, total_eur }`;

  console.log('--- compiling (getSQL) ---');
  const runnable = runtime.loadModel(MODEL).loadQuery(query);
  const sql = await runnable.getSQL();
  console.log(sql);

  console.log('\n--- running ---');
  const result = await runtime.loadModel(MODEL).loadQuery(query).run();
  console.log(JSON.stringify(result.data.toObject(), null, 2));

  await connection.close();
  console.log('\nSPIKE OK');
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err);
  process.exit(1);
});
