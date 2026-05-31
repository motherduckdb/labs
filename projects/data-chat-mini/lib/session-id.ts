import { uuid7 } from './uuid7';

/**
 * Stable per-browser-session id, used as the MotherDuck read-scaling session
 * hint so concurrent users fan out across read replicas. Persisted in
 * localStorage so a reload keeps the same replica affinity; regenerated only
 * when storage is cleared. Client-only.
 */
const KEY = 'data-chat-mini:session-id';

export function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = uuid7();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    // Private mode / storage disabled — fall back to a per-load id.
    return uuid7();
  }
}
