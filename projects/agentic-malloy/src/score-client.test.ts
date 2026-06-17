import { describe, it, expect, afterAll } from 'vitest';
import { ScoreClient, ScoreClientError } from './score-client.js';

// Exercises the real Python scoring sidecar (scoring/score_sidecar.py +
// vendored score.py). Needs python3 on PATH; no network / API keys.
describe('ScoreClient (Python sidecar)', () => {
  const sc = new ScoreClient();
  afterAll(() => sc.close());

  it('scores a numeric answer with rounding', async () => {
    const r = await sc.score({ rows: [[29.933506]], gold: '29.93', guidelines: 'Answer must be just a number rounded to 2 decimals.' });
    expect(r.is_correct).toBe(true);
    expect(r.predicted_answer).toBe('29.93');
  });

  it('scores a single-letter list answer', async () => {
    const r = await sc.score({ rows: [['B']], gold: "['B']", guidelines: 'Answer must be just one letter. Provide the response in a list even if there is only one value.' });
    expect(r.is_correct).toBe(true);
  });

  it('marks a wrong numeric answer incorrect', async () => {
    const r = await sc.score({ rows: [[42.0]], gold: '29.93', guidelines: 'Answer must be just a number rounded to 2 decimals.' });
    expect(r.is_correct).toBe(false);
    expect(r.correctness).toBe('incorrect');
  });

  it('treats an execution error as Not Applicable (matches NA gold)', async () => {
    const r = await sc.score({ rows: null, error: 'boom', gold: 'Not Applicable', guidelines: null });
    expect(r.is_correct).toBe(true);
    expect(r.predicted_answer).toBe('Not Applicable');
  });
});

describe('ScoreClient failure containment', () => {
  it('a sidecar that cannot start rejects score() with a ScoreClientError (not an unhandled crash)', async () => {
    // Bogus interpreter -> spawn emits 'error' -> markDead -> score() rejects.
    const bad = new ScoreClient('definitely-not-a-real-python-binary-xyz');
    await expect(bad.score({ rows: [[1]], gold: '1', guidelines: null })).rejects.toBeInstanceOf(ScoreClientError);
    bad.close();
  });
});
