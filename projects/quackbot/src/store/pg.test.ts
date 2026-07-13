import { describe, expect, it } from 'vitest';
import { resolvePoolConfig } from './pg';

describe('resolvePoolConfig — TLS is always verified unless explicitly disabled', () => {
  it('verifies the cert for a plain connection string', () => {
    const cfg = resolvePoolConfig('postgres://u:p@host:5432/db');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('treats sslrootcert=system as the strict default and strips the param', () => {
    const cfg = resolvePoolConfig('postgres://u:p@host/db?sslrootcert=system');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain('sslrootcert');
  });

  it('does not let sslmode=require downgrade to unverified TLS', () => {
    // The whole point of the fix: a require/no-verify param must not disable
    // certificate verification.
    const cfg = resolvePoolConfig('postgres://u:p@host/db?sslmode=require');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain('sslmode');
  });

  it('a custom-CA string with sslmode=no-verify still forces verification (not silent bypass)', () => {
    // Previously this branch returned the raw URL to pg, which would connect
    // WITHOUT verifying. Now it must attempt to read the CA and verify — a
    // bogus path fails loudly rather than connecting unverified.
    expect(() =>
      resolvePoolConfig('postgres://u:p@host/db?sslrootcert=/nonexistent/ca.pem&sslmode=no-verify'),
    ).toThrow();
  });

  it('honors an explicit sslmode=disable (documented plaintext escape hatch)', () => {
    const cfg = resolvePoolConfig('postgres://u:p@host/db?sslmode=disable');
    expect(cfg.ssl).toBe(false);
  });
});
