import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mintCapability, verifyCapability } from './dive-query-capability';

beforeEach(() => {
  process.env.DIVE_QUERY_SECRET = 'test-secret-value-for-unit-tests';
});

describe('dive-query capability', () => {
  it('round-trips access token + dive id', () => {
    const cap = mintCapability('access-abc', 'dive-123');
    const out = verifyCapability(cap);
    expect(out).toEqual({ accessToken: 'access-abc', diveId: 'dive-123' });
  });

  it('returns null for a tampered token', () => {
    const cap = mintCapability('access-abc', 'dive-123');
    // Flip a character in the middle of the ciphertext region.
    const i = cap.length - 5;
    const tampered = cap.slice(0, i) + (cap[i] === 'A' ? 'B' : 'A') + cap.slice(i + 1);
    expect(verifyCapability(tampered)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(verifyCapability('not-a-token')).toBeNull();
    expect(verifyCapability('')).toBeNull();
  });

  it('returns null once expired', () => {
    const realNow = Date.now;
    const t0 = 1_000_000_000_000;
    Date.now = () => t0;
    const cap = mintCapability('access-abc', 'dive-123');
    Date.now = () => t0 + 31 * 60 * 1000; // > 30 min TTL
    try {
      expect(verifyCapability(cap)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("can't be verified under a different secret", () => {
    const cap = mintCapability('access-abc', 'dive-123');
    process.env.DIVE_QUERY_SECRET = 'a-totally-different-secret';
    expect(verifyCapability(cap)).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
