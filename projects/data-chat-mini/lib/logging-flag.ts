/**
 * Master kill switch for the controllog data feed.
 *
 * Read by both runtimes:
 *   - Server (lib/controllog.ts): gates `event()` and `flushSession()`.
 *   - Client (app/chat/ChatPanel.tsx): hides the "conversations are logged"
 *     disclosure so we don't promise something we're not doing.
 *
 * Using the `NEXT_PUBLIC_` prefix means the value is baked into the client
 * bundle at build time, so changing it requires a redeploy. That's fine for
 * this flag — the prod env it gates is also redeploy-scoped, and a single
 * variable name keeps the mental model simple (no risk of the server and
 * client disagreeing).
 *
 * No node imports here on purpose — this module is loaded from client
 * components too, and pulling in `fs` / `async_hooks` would break the
 * client build.
 *
 * Reads at every call site (not cached on import) so the value is honest
 * even if process.env mutates within a long-lived process — and so the
 * unit tests can flip it between assertions.
 */
export function isLoggingDisabled(): boolean {
  const v = process.env.NEXT_PUBLIC_DISABLE_LOGGING;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes';
}
