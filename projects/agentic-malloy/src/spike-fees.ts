/**
 * Phase-0 gate, hard half: can Malloy express the 9-dimension wildcard fee match
 * (empty-list/NULL = wildcard, ALL matching rules sum)? Target: task 1711 —
 * total fees for Belles_cookbook_store on day 10 of 2023 = 29.93.
 *
 * Strategy for the FEASIBILITY probe: a duckdb.sql() block produces the enriched
 * per-transaction rows (merchant profile + monthly buckets + intracountry) — the
 * part that's plain SQL anyway — and the LIST-WILDCARD MATCH + fee formula live
 * in Malloy (join_many on a boolean condition with list_contains + the SUM
 * aggregate). If this compiles via getSQL and runs to 29.93, the fee-question
 * class is feasible in Malloy. (Elegance / share-of-logic is a Phase-2 concern.)
 */
import { SingleConnectionRuntime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { LOCAL_DB_PATH } from './load.js';

const ENRICH = `
  WITH monthly_stats AS (
    SELECT merchant, year,
      MONTH(MAKE_DATE(year, 1, 1) + INTERVAL (day_of_year - 1) DAY) AS month,
      CASE WHEN SUM(eur_amount) < 100000 THEN '<100k'
           WHEN SUM(eur_amount) < 1000000 THEN '100k-1m'
           WHEN SUM(eur_amount) < 5000000 THEN '1m-5m'
           ELSE '>5m' END AS volume_range,
      CASE WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.2 THEN '<7.2%'
           WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 7.7 THEN '7.2%-7.7%'
           WHEN SUM(CASE WHEN has_fraudulent_dispute THEN eur_amount ELSE 0 END)
                / NULLIF(SUM(eur_amount), 0) * 100 < 8.3 THEN '7.7%-8.3%'
           ELSE '>8.3%' END AS fraud_level_range
    FROM payments GROUP BY merchant, year, month
  ),
  mp AS (
    SELECT m.merchant, m.account_type, m.merchant_category_code,
      CASE WHEN TRY_CAST(m.capture_delay AS INTEGER) < 3 THEN '<3'
           WHEN TRY_CAST(m.capture_delay AS INTEGER) BETWEEN 3 AND 5 THEN '3-5'
           WHEN TRY_CAST(m.capture_delay AS INTEGER) > 5 THEN '>5'
           ELSE m.capture_delay END AS capture_delay_range
    FROM merchants m
  )
  SELECT p.eur_amount, p.card_scheme, p.is_credit, p.aci,
         (p.issuing_country = p.acquirer_country) AS intracountry,
         mp.account_type, mp.merchant_category_code, mp.capture_delay_range,
         ms.volume_range, ms.fraud_level_range
  FROM payments p
  JOIN mp ON mp.merchant = p.merchant
  JOIN monthly_stats ms ON ms.merchant = p.merchant AND ms.year = p.year
    AND ms.month = MONTH(MAKE_DATE(p.year,1,1) + INTERVAL (p.day_of_year-1) DAY)
  WHERE p.merchant = 'Belles_cookbook_store' AND p.year = 2023 AND p.day_of_year = 10
`;

const MODEL = `
source: txn is duckdb.sql("""${ENRICH}""") extend {
  join_many: fees is duckdb.table('fees') on
        (fees.card_scheme is null or fees.card_scheme = card_scheme)
    and (fees.is_credit is null or fees.is_credit = is_credit)
    and (fees.intracountry is null or (fees.intracountry != 0) = intracountry)
    and (len!number(fees.aci) = 0 or list_contains!boolean(fees.aci, aci))
    and (len!number(fees.account_type) = 0
         or list_contains!boolean(fees.account_type, account_type))
    and (len!number(fees.merchant_category_code) = 0
         or list_contains!boolean(fees.merchant_category_code, merchant_category_code))
    and (fees.capture_delay is null or fees.capture_delay = capture_delay_range)
    and (fees.monthly_volume is null or fees.monthly_volume = volume_range)
    and (fees.monthly_fraud_level is null or fees.monthly_fraud_level = fraud_level_range)
} extend {
  measure: total_fees is fees.sum(fees.fixed_amount + fees.rate / 10000.0 * eur_amount)
}
`;

async function main() {
  const connection = new DuckDBConnection('duckdb', LOCAL_DB_PATH);
  const runtime = new SingleConnectionRuntime({ connection });
  const query = `run: txn -> { aggregate: total_fees }`;

  console.log('--- compiling (getSQL) ---');
  const sql = await runtime.loadModel(MODEL).loadQuery(query).getSQL();
  console.log(sql);

  console.log('\n--- running ---');
  const result = await runtime.loadModel(MODEL).loadQuery(query).run();
  const rows = result.data.toObject() as Array<Record<string, unknown>>;
  console.log(JSON.stringify(rows, null, 2));
  const got = Number(rows[0]?.total_fees);
  console.log(`\nexpected 29.93, got ${got.toFixed(2)} → ${got.toFixed(2) === '29.93' ? 'MATCH ✓' : 'MISMATCH ✗'}`);

  await connection.close();
}

main().catch((err) => {
  console.error('FEE SPIKE FAILED:', err);
  process.exit(1);
});
