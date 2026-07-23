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

  it('honors sslmode=disable for a loopback host (localhost)', () => {
    const cfg = resolvePoolConfig('postgres://u:p@localhost/db?sslmode=disable');
    expect(cfg.ssl).toBe(false);
  });

  it('honors sslmode=disable for a loopback host (127.0.0.1)', () => {
    const cfg = resolvePoolConfig('postgres://u:p@127.0.0.1:5432/db?sslmode=disable');
    expect(cfg.ssl).toBe(false);
  });

  it('honors sslmode=disable for a loopback host (::1)', () => {
    const cfg = resolvePoolConfig('postgres://u:p@[::1]:5432/db?sslmode=disable');
    expect(cfg.ssl).toBe(false);
  });

  it('throws when sslmode=disable targets a non-loopback host', () => {
    // A misconfigured production URL must never silently fall back to a
    // plaintext connection — fail fast at startup instead.
    expect(() => resolvePoolConfig('postgres://u:p@prod-db.example.com/db?sslmode=disable')).toThrow(
      /sslmode=disable is only permitted for localhost/,
    );
  });

  it('throws when sslmode=disable appears in a non-URL-shaped (libpq key=value) string', () => {
    // The host can't be determined for this shape, so it can't be verified
    // as loopback-only — refuse to guess and fail fast instead.
    expect(() => resolvePoolConfig('host=prod-db.example.com user=u password=p sslmode=disable')).toThrow(
      /sslmode=disable is only permitted for localhost/,
    );
  });

  it('still applies strict TLS for a non-URL-shaped string without sslmode=disable', () => {
    const cfg = resolvePoolConfig('host=prod-db.example.com user=u password=p');
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
    expect(cfg.connectionString).toBe('host=prod-db.example.com user=u password=p');
  });

  it('sets a client-side query_timeout but NOT server-side statement_timeout', () => {
    // statement_timeout is a Postgres startup parameter that PlanetScale's
    // pooler rejects; query_timeout is a client-side JS timer and is safe.
    for (const url of [
      'postgres://u:p@host/db',
      'postgres://u:p@host/db?sslrootcert=system',
      'postgres://u:p@localhost/db?sslmode=disable',
    ]) {
      const cfg = resolvePoolConfig(url) as Record<string, unknown>;
      expect(cfg.query_timeout).toBe(30_000);
      expect(cfg.connectionTimeoutMillis).toBe(10_000);
      expect('statement_timeout' in cfg).toBe(false);
    }
  });
});
