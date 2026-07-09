/**
 * semantic-verify tests — the generic, domain-agnostic build-time semantic
 * self-verification (fan-out grain-invariance + additivity).
 *
 * PURE parsing tests need no DB. The RUNTIME tests build a tiny two-table
 * fan-out layer (orders 1→N items) in a temp DuckDB and prove:
 *   - the fan-out check FIRES on a base-grain column summed at the join locality
 *     (`items.sum(order_value)` = 390 vs base 170), and
 *   - it stays SILENT on a genuine join-grain sum (`items.sum(items.line_value)`)
 *     and on the SAME bad shape when the measure NAME carries a grain token
 *     (`matched_*`) — the two conservative escape hatches that prevent a false
 *     positive from blocking a correct build.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { MalloyRuntime } from './malloy-runtime.js';
import {
  parseSources,
  declaresFanOut,
  primaryKeyOf,
  resolveBaseKey,
  fanoutSumCandidates,
  parseFilterParams,
  declaredMeasureNames,
  joinAnchoredAggMeasures,
  combiningMeasures,
  semanticSelfVerify,
  semanticFindingSummary,
  type ParsedSource,
} from './semantic-verify.js';

// --- pure parsing ------------------------------------------------------------

describe('parseSources / structure detection (pure)', () => {
  const model = `##! experimental.parameters
source: orders_base is duckdb.table('orders') extend {
  primary_key: id
  measure: total is order_value.sum()
}
source: enriched is orders_base extend {
  join_one: c is customers_base with cust_id
} -> {
  select: *, cust_tier is c.tier
} extend {
  primary_key: id
  measure: n is count()
}
source: order_lines(scope::string is null) is enriched extend {
  join_many: items is items_base on items.order_id = id
  measure: bad is items.sum(order_value)
}`;

  it('captures the base source across a param signature AND a projection-then-extend', () => {
    const srcs = parseSources(model);
    const by = new Map(srcs.map((s) => [s.name, s]));
    expect(by.get('enriched')!.base).toBe('orders_base'); // projection form
    expect(by.get('order_lines')!.base).toBe('enriched'); // param signature skipped
    expect(by.get('order_lines')!.parameterized).toBe(true);
  });

  it('detects fan-out only where a row-multiplying join is declared', () => {
    const by = new Map(parseSources(model).map((s) => [s.name, s]));
    expect(declaresFanOut(by.get('order_lines')!.body)).toBe(true); // join_many
    expect(declaresFanOut(by.get('enriched')!.body)).toBe(false); // join_one is not fan-out
    expect(declaresFanOut(by.get('orders_base')!.body)).toBe(false);
  });

  it('finds the primary_key in a SECOND extend (after a projection)', () => {
    const by = new Map(parseSources(model).map((s) => [s.name, s]));
    expect(primaryKeyOf(by.get('enriched')!.body)).toBe('id');
  });

  it('resolves the base key by walking the is-<base> chain across sources', () => {
    const by = new Map(parseSources(model).map((s) => [s.name, s]));
    // order_lines has no own primary_key → walks to enriched (id).
    expect(resolveBaseKey('order_lines', by)).toBe('id');
  });
});

describe('fanoutSumCandidates (pure, conservative exclusions)', () => {
  const body = (m: string) => `extend {
    join_many: items is items_base on items.order_id = id
    ${m}
  }`;

  it('detects a base-column bare sum at the join locality', () => {
    const c = fanoutSumCandidates(body('measure: total_value is items.sum(order_value)'));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: 'total_value', inner: 'order_value', joinPath: 'items' });
  });

  it('EXCLUDES a sum whose inner references the join path (genuine join grain)', () => {
    expect(fanoutSumCandidates(body('measure: line_value is items.sum(items.amount)'))).toEqual([]);
  });

  it('EXCLUDES a compound inner expression (cannot cleanly compare localities)', () => {
    expect(fanoutSumCandidates(body('measure: v is items.sum(order_value * 2)'))).toEqual([]);
  });

  it('EXCLUDES a filtered measure ({ where: } makes the base-locality compare invalid)', () => {
    expect(fanoutSumCandidates(body('measure: v is items.sum(order_value) { where: order_value > 0 }'))).toEqual([]);
  });

  it('EXCLUDES a match/pair/non-additive NAMED measure (generic grain vocabulary)', () => {
    expect(fanoutSumCandidates(body('measure: matched_value is items.sum(order_value)'))).toEqual([]);
    expect(fanoutSumCandidates(body('measure: per_pair_value is items.sum(order_value)'))).toEqual([]);
    expect(fanoutSumCandidates(body('measure: avg_value is items.sum(order_value)'))).toEqual([]);
  });
});

describe('parseFilterParams / declaredMeasureNames (pure)', () => {
  it('detects a filter param via `col = p` and strips the compared column to its final segment', () => {
    const body = `(scheme_p::string is null) is base extend { dimension: d is scheme_p is null or fees.scheme = scheme_p }`;
    expect(parseFilterParams(body)).toEqual([{ name: 'scheme_p', compareColumn: 'scheme' }]);
  });
  it('detects a filter param via list_contains(col, p) (incl. the raw-escape form)', () => {
    const body = `(sch::string is null) is base extend { dimension: d is list_contains!boolean(schemes, sch) }`;
    expect(parseFilterParams(body)).toEqual([{ name: 'sch', compareColumn: 'schemes' }]);
  });
  it('EXCLUDES an arithmetic-only param (a scaler, not a scoping filter)', () => {
    const body = `(notional::number is 0, scheme_p::string is null) is base extend { measure: m is (amount * notional).sum() { where: scheme = scheme_p } }`;
    expect(parseFilterParams(body)).toEqual([{ name: 'scheme_p', compareColumn: 'scheme' }]);
  });
  it('returns [] when there is no signature (a `()` inside the body is not a signature)', () => {
    expect(parseFilterParams(`is base extend { measure: m is count() }`)).toEqual([]);
  });
  it('lists own measure names', () => {
    expect(declaredMeasureNames(`extend { measure: a is x.sum() measure: b is count() }`)).toEqual(['a', 'b']);
  });
});

describe('joinAnchoredAggMeasures / combiningMeasures (pure)', () => {
  const body = `extend {
    join_many: rules is fees_base on 1=1
    join_many: cf_rules is fees_base on 1=1
    measure: baseline_total is rules.sum(rules.fee)
    measure: scenario_total is cf_rules.sum(cf_rules.fee)
    measure: fee_delta is scenario_total - baseline_total
    measure: transaction_count is count(psp_reference)
  }`;
  it('maps join-anchored aggregate measures to their join path (and skips non-anchored)', () => {
    const m = joinAnchoredAggMeasures(body);
    expect(m.get('baseline_total')).toBe('rules');
    expect(m.get('scenario_total')).toBe('cf_rules');
    expect(m.has('fee_delta')).toBe(false); // references measures, not a join aggregate
    expect(m.has('transaction_count')).toBe(false); // count(psp_reference) is not <path>.count()
  });
  it('finds a combining measure referencing anchored measures on DIFFERENT join paths', () => {
    const anchored = new Set(joinAnchoredAggMeasures(body).keys());
    const combos = combiningMeasures(body, anchored);
    const fd = combos.find((c) => c.name === 'fee_delta');
    expect(fd).toBeTruthy();
    expect(fd!.refs.sort()).toEqual(['baseline_total', 'scenario_total']);
  });
});

describe('semanticFindingSummary (pure)', () => {
  it('renders findings for a build nudge', () => {
    const txt = semanticFindingSummary([
      { code: 'fanout_grain_noninvariance', source: 's', measure: 'm', message: 'measure `m` double-counts' },
    ]);
    expect(txt).toMatch(/Semantic self-verification/);
    expect(txt).toMatch(/double-counts/);
  });
  it('is empty for no findings', () => {
    expect(semanticFindingSummary([])).toBe('');
  });
});

// --- runtime probes against a tiny fan-out layer -----------------------------

describe('semanticSelfVerify (runtime, tiny fan-out layer)', () => {
  let dir: string;
  let dbPath: string;
  let modelsDir: string;
  let rt: MalloyRuntime;
  let allSources: ParsedSource[];

  // orders (1→N items). order_value is a BASE column; line_value lives on items.
  // order 1: value 100, 3 items; order 2: value 50, 1 item; order 3: value 20, 2 items
  //   base Σ order_value = 170; items-fanned Σ order_value = 100*3+50+20*2 = 390.
  const model = `
source: items_base is duckdb.table('items') extend { measure: lv is line_value.sum() }
source: orders_base is duckdb.table('orders') extend {
  primary_key: id
  dimension: region_dim is region
  measure: base_total is order_value.sum()
}
source: order_lines is orders_base extend {
  join_many: items is items_base on items.order_id = id
  measure: bad_total_value  is items.sum(order_value)        // BASE col at join locality → inflates
  measure: good_line_value  is items.sum(items.line_value)   // items col → correct join grain
  measure: matched_order_value is items.sum(order_value)     // same bad shape, grain-token name → skip
  view: totals is { aggregate: bad_total_value, good_line_value }
}`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'asm-semverify-'));
    dbPath = path.join(dir, 'sv.duckdb');
    modelsDir = path.join(dir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const inst = await DuckDBInstance.create(dbPath);
    const conn = await inst.connect();
    await conn.run(`CREATE TABLE orders (id BIGINT, order_value DOUBLE, region VARCHAR)`);
    await conn.run(`CREATE TABLE items (order_id BIGINT, line_value DOUBLE)`);
    await conn.run(`INSERT INTO orders VALUES (1,100,'W'),(2,50,'E'),(3,20,'W')`);
    await conn.run(`INSERT INTO items VALUES (1,10),(1,20),(1,5),(2,7),(3,3),(3,4)`);
    conn.closeSync();
    writeFileSync(path.join(modelsDir, 'm.malloy'), model);
    rt = new MalloyRuntime({ databasePath: dbPath, modelsDir });
    allSources = parseSources(model);
  }, 60_000);

  afterAll(async () => {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIRES on the base-grain column summed at the join locality (double-count)', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model, allSources });
    const bad = findings.find((f) => f.measure === 'bad_total_value');
    expect(bad).toBeTruthy();
    expect(bad!.code).toBe('fanout_grain_noninvariance');
    expect(bad!.message).toMatch(/390/); // the inflated join-locality total
    expect(bad!.message).toMatch(/170/); // the correct base-grain total
    expect(bad!.message).toMatch(/base grain|collapses|one row per/i);
  });

  it('stays SILENT on a genuine join-grain sum and on a grain-token-named measure', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model, allSources });
    expect(findings.some((f) => f.measure === 'good_line_value')).toBe(false);
    expect(findings.some((f) => f.measure === 'matched_order_value')).toBe(false);
    // exactly the one true defect fired — no false positives.
    expect(findings).toHaveLength(1);
  });

  it('does NOT fire on a NON-fanned base source (no join → nothing to inflate)', async () => {
    // Point the verifier at only the base source text — no join_many, no findings.
    const baseOnly = `source: orders_base is duckdb.table('orders') extend { primary_key: id measure: base_total is order_value.sum() }`;
    const findings = await semanticSelfVerify({ rt, fileText: baseOnly, allSources });
    expect(findings).toEqual([]);
  });
});

// --- Check #3: parameter fidelity + identity counterfactual ------------------

describe('semanticSelfVerify (runtime, parameter fidelity)', () => {
  let dir: string;
  let dbPath: string;
  let modelsDir: string;
  let rt: MalloyRuntime;

  // txns: scheme A has amounts [100,100] (avg 100), scheme B has [10] (avg 10);
  // global avg = 70. A filter param `scheme_p` compared `scheme = scheme_p`:
  //   - `global_avg` ignores it (avg over the whole source) → INERT, must FIRE.
  //   - `scoped_avg` applies it in a { where: } filter → correctly wired, must be SILENT.
  const model = `##! experimental.parameters
source: txns_base is duckdb.table('txns') extend { measure: base_avg is amount.avg() }
source: scoped(scheme_p::string is null) is txns_base extend {
  dimension: in_scope is scheme_p is null or scheme = scheme_p
  measure: global_avg is amount.avg()
  measure: scoped_avg is amount.avg() { where: scheme_p is null or scheme = scheme_p }
}`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'asm-paramfid-'));
    dbPath = path.join(dir, 'pf.duckdb');
    modelsDir = path.join(dir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const inst = await DuckDBInstance.create(dbPath);
    const conn = await inst.connect();
    await conn.run(`CREATE TABLE txns (id BIGINT, scheme VARCHAR, amount DOUBLE)`);
    await conn.run(`INSERT INTO txns VALUES (1,'A',100),(2,'A',100),(3,'B',10)`);
    conn.closeSync();
    writeFileSync(path.join(modelsDir, 'm.malloy'), model);
    rt = new MalloyRuntime({ databasePath: dbPath, modelsDir });
  }, 60_000);

  afterAll(async () => {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIRES parameter_inert on a filter param the measure ignores, SILENT on the wired one', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model });
    const inert = findings.filter((f) => f.code === 'parameter_inert');
    expect(inert.map((f) => f.measure)).toContain('global_avg'); // ignores scheme_p → global avg for both bindings
    expect(inert.map((f) => f.measure)).not.toContain('scoped_avg'); // { where: scheme_p } → moves → silent
    expect(inert[0].message).toMatch(/scheme_p/);
    expect(inert[0].message).toMatch(/not wired|UNFILTERED/i);
  });

  it('does NOT fire parameter_inert on an OVERRIDE-prefixed param (baseline/neutral measures are meant to be invariant)', async () => {
    // `scenario_scheme` is a counterfactual override, not a scoping filter — even though
    // it appears in an equality (`scheme = scenario_scheme`), the baseline measures below
    // are SUPPOSED to ignore it. #3 must skip it (the identity check #3b owns overrides).
    const overrideModel = `##! experimental.parameters
source: txns_base is duckdb.table('txns') extend { measure: base_avg is amount.avg() }
source: cfr(scenario_scheme::string is null) is txns_base extend {
  dimension: eff_scheme is scenario_scheme is null or scheme = scenario_scheme
  measure: baseline_avg is amount.avg()
  measure: transaction_count is count()
}`;
    const findings = await semanticSelfVerify({ rt, fileText: overrideModel });
    expect(findings.some((f) => f.code === 'parameter_inert')).toBe(false);
  });
});

describe('semanticSelfVerify (runtime, identity counterfactual)', () => {
  let dir: string;
  let dbPath: string;
  let modelsDir: string;
  let rt: MalloyRuntime;

  // A scenario source with an `override_amount` param + a `cost_delta` measure.
  //   - repriced_bad: scenario applies an unconditional 1.1× — even a NO-OP override
  //     (set to a fact's own value) leaves a non-zero delta → must FIRE.
  //   - repriced_ok: scenario uses `pick override_amount when … else amount` — a no-op
  //     override collapses to baseline → zero delta → must be SILENT.
  const model = `##! experimental.parameters
source: txns2_base is duckdb.table('txns2') extend { measure: n is count() }
source: repriced_bad(override_amount::number is null) is txns2_base extend {
  measure: baseline_cost is amount.sum()
  measure: scenario_cost is sum(amount * 1.1)
  measure: cost_delta is scenario_cost - baseline_cost
}
source: repriced_ok(override_amount::number is null) is txns2_base extend {
  dimension: eff_amount is pick override_amount when override_amount is not null else amount
  measure: baseline_cost is amount.sum()
  measure: scenario_cost is eff_amount.sum()
  measure: cost_delta is scenario_cost - baseline_cost
}`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'asm-identity-'));
    dbPath = path.join(dir, 'id.duckdb');
    modelsDir = path.join(dir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const inst = await DuckDBInstance.create(dbPath);
    const conn = await inst.connect();
    await conn.run(`CREATE TABLE txns2 (id BIGINT, amount DOUBLE)`);
    await conn.run(`INSERT INTO txns2 VALUES (1,100),(2,100),(3,50)`);
    conn.closeSync();
    writeFileSync(path.join(modelsDir, 'm.malloy'), model);
    rt = new MalloyRuntime({ databasePath: dbPath, modelsDir });
  }, 60_000);

  afterAll(async () => {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FIRES identity_delta_nonzero when a no-op override still moves the delta', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model });
    const bad = findings.filter((f) => f.code === 'identity_delta_nonzero' && f.source === 'repriced_bad');
    expect(bad.length).toBe(1);
    expect(bad[0].measure).toBe('cost_delta');
    expect(bad[0].message).toMatch(/NO-OP|identity/i);
  });

  it('stays SILENT on a scenario that collapses to baseline at identity', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model });
    expect(findings.some((f) => f.code === 'identity_delta_nonzero' && f.source === 'repriced_ok')).toBe(false);
  });
});

// Check #4 firing requires the specific Malloy symmetric-aggregate breakdown seen on
// the real fee layer (co-aggregating two large join_many over complex predicates),
// which a tiny fixture does not reproduce — that path is validated end-to-end by the
// build itself. Here we guard the FALSE-POSITIVE direction: a clean two-join_many
// combining measure that DOES compose correctly must stay silent.
describe('semanticSelfVerify (runtime, cross-join co-aggregation — no false positive)', () => {
  let dir: string;
  let dbPath: string;
  let modelsDir: string;
  let rt: MalloyRuntime;

  const model = `
source: things_base is duckdb.table('things') extend { primary_key: tid }
source: two_join is duckdb.table('orders') extend {
  primary_key: id
  join_many: ja is things_base on ja.k = k and ja.grp = 'a'
  join_many: jb is things_base on jb.k = k and jb.grp = 'b'
  measure: a_total is ja.sum(ja.rate * amt)
  measure: b_total is jb.sum(jb.rate * amt)
  measure: ab_gap is a_total - b_total
}`;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'asm-coagg-'));
    dbPath = path.join(dir, 'ca.duckdb');
    modelsDir = path.join(dir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const inst = await DuckDBInstance.create(dbPath);
    const conn = await inst.connect();
    await conn.run(`CREATE TABLE orders (id BIGINT, k BIGINT, amt DOUBLE)`);
    await conn.run(`CREATE TABLE things (k BIGINT, tid BIGINT, rate DOUBLE, grp VARCHAR)`);
    await conn.run(`INSERT INTO orders VALUES (1,100,1000),(2,200,500)`);
    await conn.run(`INSERT INTO things VALUES (100,1,0.1,'a'),(100,2,0.2,'a'),(100,3,0.01,'b'),(100,4,0.02,'b'),(100,5,0.03,'b'),(200,6,0.5,'a'),(200,7,0.7,'b')`);
    conn.closeSync();
    writeFileSync(path.join(modelsDir, 'm.malloy'), model);
    rt = new MalloyRuntime({ databasePath: dbPath, modelsDir });
  }, 60_000);

  afterAll(async () => {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT flag a combining measure whose components compose correctly', async () => {
    const findings = await semanticSelfVerify({ rt, fileText: model });
    expect(findings.some((f) => f.code === 'crossjoin_coaggregation')).toBe(false);
  });
});
