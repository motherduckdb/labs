/**
 * Check if an error is likely an authentication/authorization error.
 */
export function isAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /401|403|unauthorized|forbidden|expired|invalid.?token/i.test(msg);
}

/**
 * Return a 401 JSON response for expired auth.
 */
export function authExpiredResponse() {
  return Response.json(
    { error: 'auth_expired', message: 'Your MotherDuck session has expired. Please reconnect.' },
    { status: 401 }
  );
}
