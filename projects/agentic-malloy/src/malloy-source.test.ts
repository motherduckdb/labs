/**
 * malloy-source unit tests — the PURE source-text analysis shared by layer-build
 * (the 2A.3 build gates) and malloy-store (the list_views aggregation tag). Snippets
 * mirror the real c3 defects; the gate CODE carries no dataset facts.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregationModesOf,
  viewRankingAggregation,
  extremumViewNames,
  auditAggregationSetCompleteness,
  auditHardcodedDerivableDomain,
  auditNameVsAggregation,
  layerSourceGate,
} from './malloy-source.js';

describe('aggregationModesOf', () => {
  it('detects path-form and function-form aggregations', () => {
    expect([...aggregationModesOf('fee_eur_on_100.avg()')]).toEqual(['avg']);
    expect([...aggregationModesOf('x.sum()')]).toEqual(['sum']);
    expect([...aggregationModesOf('avg(fee)')]).toEqual(['avg']);
    expect(aggregationModesOf('fixed_amount + rate').size).toBe(0);
  });
});

describe('extremumViewNames / viewRankingAggregation', () => {
  const body = `source: s is fees_base extend {
    dimension: fee_eur_on_100 is fixed_amount + rate * 100 / 10000.0
    measure: avg_fee_on_100 is fee_eur_on_100.avg()
    measure: total_fee_on_100 is fee_eur_on_100.sum()
    measure: rule_count is count()
    view: avg_by_aci is { group_by: aci aggregate: avg_fee_on_100 order_by: aci }
    view: most_expensive_aci_on_100 is { group_by: aci aggregate: avg_fee_on_100, rule_count order_by: avg_fee_on_100 desc, aci asc limit: 1 }
    view: top_aci_by_total is { group_by: aci aggregate: total_fee_on_100 order_by: total_fee_on_100 desc limit: 1 }
  }`;
  it('lists only extremum-named views', () => {
    expect(extremumViewNames(body).sort()).toEqual(['most_expensive_aci_on_100', 'top_aci_by_total']);
  });
  it('resolves the ranking measure aggregation (avg vs sum) via order_by', () => {
    expect(viewRankingAggregation(body, 'most_expensive_aci_on_100')).toBe('avg');
    expect(viewRankingAggregation(body, 'top_aci_by_total')).toBe('sum');
  });
  it('returns null for an unknown view or unresolvable measure', () => {
    expect(viewRankingAggregation(body, 'no_such_view')).toBeNull();
    expect(viewRankingAggregation('view: v is { group_by: x order_by: x }', 'v')).toBeNull();
  });
});

describe('GATE 1 — aggregation-set completeness', () => {
  it('flags a base measured with avg/min/max but no sum', () => {
    const body = `source: s is fees_base extend {
      dimension: fee_eur_on_100 is fixed_amount
      measure: avg_fee is fee_eur_on_100.avg()
      measure: min_fee is fee_eur_on_100.min()
      measure: max_fee is fee_eur_on_100.max()
      measure: rule_count is count()
    }`;
    const f = auditAggregationSetCompleteness(body);
    expect(f.length).toBe(1);
    expect(f[0].code).toBe('aggregation_set_incomplete');
    expect(f[0].message).toContain('fee_eur_on_100');
  });
  it('passes when the full set (incl. sum) is present', () => {
    const body = `source: s is x extend {
      measure: avg_fee is q.avg()
      measure: sum_fee is q.sum()
      measure: min_fee is q.min()
      measure: max_fee is q.max()
      measure: n is count()
    }`;
    expect(auditAggregationSetCompleteness(body)).toEqual([]);
  });
  it('flags a missing count() when extrema modes exist', () => {
    const body = `source: s is x extend { measure: a is q.avg()  measure: b is q.sum() }`;
    const f = auditAggregationSetCompleteness(body);
    expect(f.some((x) => /count/i.test(x.message))).toBe(true);
  });
  it('does NOT flag NON-ADDITIVE quantities (ratio / count) — summing them is meaningless', () => {
    const body = `source: s is x extend {
      measure: monthly_fraud_ratio_avg is monthly_fraud_ratio.avg()
      measure: monthly_fraud_ratio_min is monthly_fraud_ratio.min()
      measure: acquirer_count_avg is acquirer_count.avg()
      measure: n is count()
    }`;
    expect(auditAggregationSetCompleteness(body)).toEqual([]);
  });
});

describe('GATE 2 — no hardcoded derivable domain', () => {
  it('flags a (VALUES ...) CROSS JOIN universe matched with list_contains', () => {
    const body = `source: s is duckdb.sql("""
      WITH universe AS (SELECT aci FROM (VALUES ('A'),('B'),('C')) AS t(aci))
      SELECT f.*, u.aci AS aci FROM fees f CROSS JOIN universe u
      WHERE len(f.aci) = 0 OR list_contains(f.aci, u.aci)
    """) extend { }`;
    const f = auditHardcodedDerivableDomain(body);
    expect(f.length).toBe(1);
    expect(f[0].code).toBe('hardcoded_derivable_domain');
    expect(f[0].message).toContain('aci');
    expect(f[0].message).toMatch(/DISTINCT UNNEST/);
  });
  it('passes a data-derived (DISTINCT UNNEST) universe', () => {
    const body = `source: s is duckdb.sql("""
      WITH universe AS (SELECT DISTINCT UNNEST(merchant_category_code) AS mcc FROM fees WHERE len(merchant_category_code) > 0)
      SELECT f.*, u.mcc AS mcc FROM fees f CROSS JOIN universe u
      WHERE len(f.merchant_category_code) = 0 OR list_contains(f.merchant_category_code, u.mcc)
    """) extend { }`;
    expect(auditHardcodedDerivableDomain(body)).toEqual([]);
  });
  it('flags an ISOLATED VALUES universe source matched via list_contains elsewhere (no co-located CROSS JOIN)', () => {
    // the cleaner regen-layer shape: a tiny universe source + Malloy-join matching.
    const body = `source: aci_universe is duckdb.sql("SELECT * FROM (VALUES ('A'),('B'),('C'),('D'),('E'),('F'),('G')) AS t(candidate_aci)")
source: priced is payments_enriched extend {
  measure: total is fee.sum()
  view: by_aci is { group_by: candidate_aci aggregate: total where: len!number(fees.aci) = 0 or list_contains!boolean(fees.aci, candidate_aci) }
}`;
    const f = auditHardcodedDerivableDomain(body);
    expect(f.length).toBe(1);
    expect(f[0].code).toBe('hardcoded_derivable_domain');
    expect(f[0].message).toContain('candidate_aci');
  });
  it('does NOT flag a static VALUES lookup whose column is never list-matched', () => {
    const body = `source: bucket_lut is duckdb.sql("SELECT * FROM (VALUES ('low'),('high')) AS t(bucket)")`;
    expect(auditHardcodedDerivableDomain(body)).toEqual([]);
  });
});

describe('GATE 3 — name-vs-aggregation mismatch', () => {
  const mk = (measure: string) => `source: s is x extend {
    dimension: f is fixed_amount
    measure: m is f.${measure}()
    view: most_expensive_x is { group_by: x aggregate: m order_by: m desc limit: 1 }
    view: avg_by_x is { group_by: x aggregate: m order_by: x }
  }`;
  it('flags an extremum-named view that ranks by an average', () => {
    const f = auditNameVsAggregation(mk('avg'));
    expect(f.length).toBe(1);
    expect(f[0].code).toBe('name_vs_aggregation');
    expect(f[0].message).toContain('most_expensive_x');
  });
  it('passes an extremum-named view that ranks by a sum (and ignores non-extremum views)', () => {
    expect(auditNameVsAggregation(mk('sum'))).toEqual([]);
  });
});

describe('layerSourceGate — all three over a c3-like defective source', () => {
  const defective = `source: c3_avg_fee_by_aci is duckdb.sql("""
    WITH universe AS (SELECT aci FROM (VALUES ('A'),('B'),('C'),('D'),('E'),('F'),('G')) AS t(aci))
    SELECT f.*, u.aci AS aci FROM fees f CROSS JOIN universe u
    WHERE len(f.aci) = 0 OR list_contains(f.aci, u.aci)
  """) extend {
    dimension: fee_eur_on_100 is fixed_amount + rate * 100 / 10000.0
    measure: avg_fee_on_100 is fee_eur_on_100.avg()
    measure: min_fee_on_100 is fee_eur_on_100.min()
    measure: max_fee_on_100 is fee_eur_on_100.max()
    measure: rule_count is count()
    view: most_expensive_aci_on_100 is { group_by: aci aggregate: avg_fee_on_100, rule_count order_by: avg_fee_on_100 desc, aci asc limit: 1 }
  }`;
  it('flags the incomplete set, the hardcoded universe, and the avg-ranked extremum view', () => {
    const codes = layerSourceGate(defective).map((f) => f.code);
    expect(codes).toContain('aggregation_set_incomplete');
    expect(codes).toContain('hardcoded_derivable_domain');
    expect(codes).toContain('name_vs_aggregation');
  });
  it('a clean source (sum surface, derived universe, sum-ranked view) trips no gate', () => {
    const clean = `source: c3_total_fee_by_aci is duckdb.sql("""
      WITH universe AS (SELECT DISTINCT UNNEST(aci) AS aci FROM fees WHERE len(aci) > 0)
      SELECT f.*, u.aci AS aci FROM fees f CROSS JOIN universe u
      WHERE len(f.aci) = 0 OR list_contains(f.aci, u.aci)
    """) extend {
      dimension: fee_eur_on_100 is fixed_amount + rate * 100 / 10000.0
      measure: total_fee_on_100 is fee_eur_on_100.sum()
      measure: avg_fee_on_100 is fee_eur_on_100.avg()
      measure: min_fee_on_100 is fee_eur_on_100.min()
      measure: max_fee_on_100 is fee_eur_on_100.max()
      measure: rule_count is count()
      view: most_expensive_aci_on_100 is { group_by: aci aggregate: total_fee_on_100 order_by: total_fee_on_100 desc limit: 1 }
    }`;
    expect(layerSourceGate(clean)).toEqual([]);
  });
});
