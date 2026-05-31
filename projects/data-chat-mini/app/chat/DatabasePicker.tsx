'use client';

import { useEffect, useState } from 'react';
import { getSessionId } from '@/lib/session-id';

/**
 * Onboarding picker — the user chooses a primary database before chat starts.
 * Lists databases via /api/databases (which calls the MCP list_databases tool).
 */
export function DatabasePicker({ onPick }: { onPick: (database: string) => void }) {
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
        setDatabases(data.databases || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load databases');
      }
    })();
  }, []);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-bold mb-1">data-chat-mini</h1>
        <p className="text-sm text-[var(--muted)] mb-6">
          Pick a MotherDuck database to chat with.
        </p>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-4">
            {error === 'auth_expired'
              ? 'MotherDuck connection failed — check MOTHERDUCK_TOKEN in .env.local.'
              : error}
          </div>
        )}

        {databases === null && !error && (
          <div className="text-sm text-[var(--muted)]">Loading databases…</div>
        )}

        {databases && databases.length === 0 && (
          <div className="text-sm text-[var(--muted)]">No databases found for this token.</div>
        )}

        <div className="flex flex-col gap-2">
          {databases?.map((db) => (
            <button
              key={db}
              onClick={() => onPick(db)}
              className="text-left rounded-md border border-[var(--border)] bg-white px-4 py-3 text-sm font-medium hover:border-[var(--accent)] hover:bg-[var(--panel)] transition-colors"
            >
              {db}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
