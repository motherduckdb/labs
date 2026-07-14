/**
 * Best-effort secret redaction for anything that lands in logs (which Fly now
 * captures) or is forwarded to the model/thread. No secret is known to reach
 * these paths today — this is defense against a future dependency starting to
 * embed a token, connection string, or Authorization header in an error body.
 *
 * Targeted patterns only (no blanket high-entropy masking) to avoid mangling
 * normal log text.
 */
export function redact(input: string): string {
  if (!input) return input;
  return (
    input
      // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, and app-level xapp- (keep the
      // prefix, mask everything after the first dash)
      .replace(/\b(?:xox[abpr]|xapp)-[A-Za-z0-9-]+/gi, (m) => `${m.slice(0, m.indexOf('-') + 1)}***`)
      // Authorization: Bearer <token>
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      // key=value secrets in connection strings / URLs / query params
      .replace(
        /\b(motherduck_token|access_token|refresh_token|api[_-]?key|token|password|pwd|secret)=([^&\s"']+)/gi,
        '$1=***',
      )
      // Credentials embedded in a URL authority: scheme://user:pass@host
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s/]+@/gi, '$1***@')
  );
}

/** Redact a thrown value's message + stack for safe logging. */
export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(err.stack ?? err.message);
  return redact(String(err));
}
