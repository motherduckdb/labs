import { describe, expect, it } from 'vitest';
import { redact, redactError } from './redact';

describe('redact', () => {
  it('masks Slack bot/app tokens', () => {
    expect(redact('token xoxb-123-abc456 failed')).toBe('token xoxb-*** failed');
    expect(redact('xapp-1-A0-xyz')).toBe('xapp-***');
  });

  it('masks Authorization bearer tokens', () => {
    expect(redact('Authorization: Bearer sk-or-v1-deadbeef')).toBe('Authorization: Bearer ***');
  });

  it('masks token/password key=value pairs and connection-string creds', () => {
    expect(redact('md:?motherduck_token=eyJhbGciOi.foo.bar')).toBe('md:?motherduck_token=***');
    expect(redact('postgres://user:s3cr3t@host:5432/db')).toBe('postgres://user:***@host:5432/db');
    expect(redact('api_key=abc123&x=1')).toBe('api_key=***&x=1');
  });

  it('leaves ordinary text untouched', () => {
    expect(redact('ECONNREFUSED 10.0.0.5:5432')).toBe('ECONNREFUSED 10.0.0.5:5432');
    expect(redact('password authentication failed for user "quackbot"')).toBe(
      'password authentication failed for user "quackbot"',
    );
  });

  it('redactError scrubs the message of an Error', () => {
    const err = new Error('connect failed for postgres://u:pw@h/db');
    expect(redactError(err)).toContain('postgres://u:***@h/db');
    expect(redactError(err)).not.toContain(':pw@');
  });
});
