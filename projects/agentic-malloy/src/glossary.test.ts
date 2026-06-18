/**
 * glossary core — the closed-book extract→ground honesty pipeline. We can't unit
 * the model extraction (network), but the pieces that keep it HONEST are pure:
 * parsing/sanitizing the model output, the grounding gate (an entry must bind to
 * a real column/table or it's a hallucination → dropped), and rendering. Plus a
 * fixture-DB test of groundGlossary end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { parseGlossary, groundingResolves, renderGlossary, groundGlossary, loadGlossaryArtifact, renderGlossaryForAnswering, GLOSSARY_FILE, contentTokens, buildLayerVocabulary, questionVocabularyGap, type GlossaryEntry, type KnownSchema } from './glossary.js';

const known: KnownSchema = {
  columns: new Set(['fees.aci', 'aci', 'fees.merchant_category_code', 'merchant_category_code', 'payments.amount', 'amount']),
  tables: new Set(['fees', 'payments']),
};

const entry = (over: Partial<GlossaryEntry>): GlossaryEntry => ({ term: 't', kind: 'entity', definition: 'd', grounding: {}, ...over });

describe('parseGlossary', () => {
  it('parses a well-formed glossary and sanitizes fields', () => {
    const txt = `Here you go: [
      {"term":"ACI","aliases":["auth char indicator"],"kind":"dimension","definition":"...","grounding":{"tables":["fees"],"columns":["fees.aci"],"derivation":"unnest"},"modeling_pattern":"wildcard strata","user_granularity":["per-ACI"]},
      {"term":"","kind":"entity","grounding":{}}
    ]`;
    const g = parseGlossary(txt);
    expect(g).toHaveLength(1); // the empty-term entry is dropped
    expect(g[0]).toMatchObject({ term: 'ACI', kind: 'dimension', modeling_pattern: 'wildcard strata' });
    expect(g[0].grounding.columns).toEqual(['fees.aci']);
  });
  it('returns [] on non-JSON / non-array', () => {
    expect(parseGlossary('no json here')).toEqual([]);
    expect(parseGlossary('{"term":"x"}')).toEqual([]); // object, not array
  });
  it('coerces an unknown kind to a safe default', () => {
    expect(parseGlossary('[{"term":"x","kind":"frobnicate","grounding":{}}]')[0].kind).toBe('entity');
  });
});

describe('groundingResolves (honesty gate)', () => {
  it('resolves a qualified column, a bare column, and a table', () => {
    expect(groundingResolves(entry({ grounding: { columns: ['fees.aci'] } }), known)).toBe(true);
    expect(groundingResolves(entry({ grounding: { columns: ['amount'] } }), known)).toBe(true);
    expect(groundingResolves(entry({ grounding: { tables: ['payments'] } }), known)).toBe(true);
  });
  it('is case-insensitive and resolves a qualified ref by its bare column', () => {
    expect(groundingResolves(entry({ grounding: { columns: ['Fees.ACI'] } }), known)).toBe(true);
    expect(groundingResolves(entry({ grounding: { columns: ['orders.amount'] } }), known)).toBe(true); // unknown table, real bare col
  });
  it('REJECTS a hallucinated concept that binds to nothing real', () => {
    expect(groundingResolves(entry({ grounding: { columns: ['fees.loyalty_tier'], tables: ['rewards'] } }), known)).toBe(false);
    expect(groundingResolves(entry({ grounding: {} }), known)).toBe(false);
  });
});

describe('renderGlossary', () => {
  it('renders term, aliases, kind, and the modeling pattern', () => {
    const txt = renderGlossary([entry({ term: 'steer to X', aliases: ['route to'], kind: 'scenario', definition: 'counterfactual re-pricing', modeling_pattern: 'counterfactual override join' })]);
    expect(txt).toContain('"steer to X"');
    expect(txt).toContain('aka route to');
    expect(txt).toContain('PATTERN: counterfactual override join');
  });
  it('handles an empty glossary', () => {
    expect(renderGlossary([])).toBe('(no glossary)');
  });
});

describe('artifact round-trip + answering surface', () => {
  it('loadGlossaryArtifact reads what buildLayer writes (JSON-in-.yaml under glossary:)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asm-gart-'));
    try {
      const entries = [entry({ term: 'steer to X', aliases: ['route to'], kind: 'scenario', modeling_pattern: 'counterfactual override' })];
      writeFileSync(path.join(dir, GLOSSARY_FILE), JSON.stringify({ glossary: entries }, null, 2));
      const loaded = await loadGlossaryArtifact(dir); // await BEFORE the finally cleans up
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ term: 'steer to X', kind: 'scenario' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('loadGlossaryArtifact returns [] when no artifact exists', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'asm-gart2-'));
    try {
      expect(await loadGlossaryArtifact(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('renderGlossaryForAnswering maps terms to concepts + patterns (empty when no glossary)', () => {
    expect(renderGlossaryForAnswering([])).toBe('');
    const txt = renderGlossaryForAnswering([entry({ term: 'steer to X', kind: 'scenario', definition: 'counterfactual', modeling_pattern: 'override join' })]);
    expect(txt).toContain('"steer to X"');
    expect(txt).toContain('override join');
  });
});

describe('vocabulary gap (closed-book)', () => {
  it('contentTokens keeps domain words/codes, drops stopwords and short tokens', () => {
    const t = contentTokens('What is the most expensive ACI to steer fraudulent traffic to?');
    expect(t).toContain('aci');
    expect(t).toContain('steer');
    expect(t).toContain('fraudulent');
    expect(t).not.toContain('the');
    expect(t).not.toContain('most'); // aggregation stopword
    expect(t).not.toContain('is');
  });

  it('buildLayerVocabulary unions glossary terms/aliases + surface names', () => {
    const v = buildLayerVocabulary(
      [entry({ term: 'steer to X', aliases: ['route to'] })],
      ['fee_match', 'by_aci_avg_fee'],
    );
    expect(v.has('steer')).toBe(true);
    expect(v.has('route')).toBe(true);
    expect(v.has('aci')).toBe(true); // from by_aci_avg_fee
    expect(v.has('match')).toBe(true); // from fee_match
  });

  it('questionVocabularyGap flags words the layer does not speak', () => {
    const vocab = buildLayerVocabulary([entry({ term: 'fee' })], ['fee_match', 'by_card_scheme']);
    const g = questionVocabularyGap('What is the total fee if a merchant steers traffic to NexPay?', vocab);
    expect(g.uncovered).toContain('steers'); // not in vocab → gap
    expect(g.uncovered).toContain('merchant');
    expect(g.uncovered).not.toContain('fee'); // covered
    expect(g.coverage).toBeLessThan(1);
  });

  it('full coverage when every content word is known', () => {
    const vocab = buildLayerVocabulary([entry({ term: 'fee' }), entry({ term: 'scheme' })], []);
    const g = questionVocabularyGap('average fee by scheme', vocab); // average/by are stopwords
    expect(g.uncovered).toEqual([]);
    expect(g.coverage).toBe(1);
  });
});

describe('groundGlossary (fixture DB)', () => {
  let dir: string;
  let dbPath: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'asm-gloss-'));
    dbPath = path.join(dir, 'g.duckdb');
    const conn = await (await DuckDBInstance.create(dbPath)).connect();
    await conn.run(`CREATE TABLE fees (id BIGINT, aci VARCHAR[], rate DOUBLE)`);
    conn.closeSync();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps grounded entries and drops hallucinated ones', async () => {
    const { grounded, dropped } = await groundGlossary(
      [
        entry({ term: 'fee rate', grounding: { columns: ['fees.rate'] } }),
        entry({ term: 'phantom', grounding: { columns: ['fees.nonexistent'], tables: ['ghost'] } }),
      ],
      ['fees'],
      dbPath,
    );
    expect(grounded.map((e) => e.term)).toEqual(['fee rate']);
    expect(dropped.map((e) => e.term)).toEqual(['phantom']);
  });
});
