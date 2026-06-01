'use client';

import { useEffect, useState } from 'react';
import { getSessionId } from '@/lib/session-id';
import { CANONICAL_DEMO_DATABASE } from '@/lib/demo-mode';

/**
 * Onboarding picker — the user chooses a primary database before chat starts.
 * Lists databases via /api/databases (which calls the MCP list_databases tool).
 */
export function DatabasePicker({
  onPick,
  onStartDemo,
}: {
  onPick: (database: string) => void;
  onStartDemo: (replay: boolean) => void;
}) {
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/databases', {
          headers: { 'x-session-id': getSessionId() },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        // Dedupe — the catalog can list the same database name more than once
        // (e.g. a database plus a same-named share), which would collide on the
        // React key and render duplicate buttons.
        setDatabases(Array.from(new Set<string>(data.databases || [])));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load databases');
      }
    })();
  }, []);

  return (
    <div className="picker-screen">
      <div className="picker-card">
        <div className="brand-lockup picker-brand">
          <span className="brand-mark">md</span>
          <div>
            <h1>data-chat-mini</h1>
            <span>MotherDuck Labs</span>
          </div>
        </div>
        <p className="picker-lede">
          Pick a MotherDuck database or launch the presenter-ready NBA workshop path.
        </p>

        <div className="demo-start-panel">
          <div>
            <div className="eyebrow">Workshop mode</div>
            <h2>{CANONICAL_DEMO_DATABASE}</h2>
            <p>Guided prompts, replayable transcript, traceable SQL, context, and mviz artifacts.</p>
          </div>
          <div className="demo-start-actions">
            <button onClick={() => onStartDemo(true)}>Replay demo</button>
            <button onClick={() => onStartDemo(false)}>Live demo</button>
          </div>
        </div>

        {error && (
          <div className="error-card">
            {error === 'auth_expired'
              ? 'MotherDuck connection failed — check MOTHERDUCK_TOKEN in .env.local.'
              : error}
          </div>
        )}

        {databases === null && !error && (
          <div className="loading-row">Loading databases…</div>
        )}

        {databases && databases.length === 0 && (
          <div className="loading-row">No databases found for this token.</div>
        )}

        <div className="database-list">
          {databases?.map((db) => (
            <button
              key={db}
              onClick={() => onPick(db)}
            >
              <span>{db}</span>
              <small>Read-only chat workspace</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
