'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSessionId } from '@/lib/session-id';
import { listFragments, deleteFragment, type Fragment } from '@/lib/context-store';
import type { SchemaTable, SchemaColumn } from '@/lib/mcp-parsers';

/**
 * Slim schema explorer: a catalog tree (database → tables → columns) the human
 * can browse to understand the data, plus the local context-fragment list (the
 * IndexedDB-backed context layer the model reads/writes via the round-trip).
 */
export function SchemaExplorerSidebar({
  database,
  contextReloadKey,
}: {
  database: string;
  contextReloadKey: number;
}) {
  const [tables, setTables] = useState<SchemaTable[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, SchemaColumn[] | 'loading'>>({});
  const [fragments, setFragments] = useState<Fragment[]>([]);

  // The component is keyed by `database` in ChatShell, so it remounts (and
  // state resets to the initial null/{}) when the database changes — no
  // synchronous setState-in-effect resets needed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/schema?database=${encodeURIComponent(database)}`, {
          headers: { 'x-session-id': getSessionId() },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setTables(data.tables || []);
      } catch (err) {
        if (!cancelled) setTablesError(err instanceof Error ? err.message : 'Failed to load tables');
      }
    })();
    return () => { cancelled = true; };
  }, [database]);

  const refreshFragments = useCallback(() => {
    listFragments().then(setFragments).catch(() => setFragments([]));
  }, []);

  useEffect(() => {
    refreshFragments();
  }, [refreshFragments, contextReloadKey]);

  const toggleTable = async (t: SchemaTable) => {
    const key = `${t.schema}.${t.name}`;
    if (expanded[key]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      const url = `/api/schema?database=${encodeURIComponent(database)}&schema=${encodeURIComponent(
        t.schema,
      )}&table=${encodeURIComponent(t.name)}`;
      const res = await fetch(url, { headers: { 'x-session-id': getSessionId() } });
      const data = await res.json();
      setExpanded((prev) => ({ ...prev, [key]: data.columns || [] }));
    } catch {
      setExpanded((prev) => ({ ...prev, [key]: [] }));
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-[var(--border)] bg-[var(--panel)] w-72 shrink-0">
      <div className="flex-1 overflow-y-auto">
        {/* Schema tree */}
        <div className="p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)] mb-2">
            Schema · {database}
          </div>
          {tablesError && <div className="text-xs text-red-600">{tablesError}</div>}
          {tables === null && !tablesError && (
            <div className="text-xs text-[var(--muted)]">Loading…</div>
          )}
          {tables?.length === 0 && <div className="text-xs text-[var(--muted)]">No tables.</div>}
          <ul className="text-sm">
            {tables?.map((t) => {
              const key = `${t.schema}.${t.name}`;
              const cols = expanded[key];
              return (
                <li key={key} className="mb-0.5">
                  <button
                    onClick={() => toggleTable(t)}
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left hover:bg-white/70"
                  >
                    <span className="text-[var(--muted)] w-3 text-xs">{cols ? '▾' : '▸'}</span>
                    <span className="truncate font-medium">{t.name}</span>
                    {t.type !== 'table' && (
                      <span className="ml-1 text-[10px] text-[var(--muted)]">{t.type}</span>
                    )}
                  </button>
                  {cols === 'loading' && (
                    <div className="pl-6 py-0.5 text-xs text-[var(--muted)]">loading columns…</div>
                  )}
                  {Array.isArray(cols) && (
                    <ul className="pl-6 border-l border-[var(--border)] ml-2">
                      {cols.map((c) => (
                        <li key={c.name} className="flex items-baseline gap-2 py-0.5">
                          <span className="truncate">{c.name}</span>
                          <span className="text-[10px] text-[var(--muted)] shrink-0">{c.type}</span>
                        </li>
                      ))}
                      {cols.length === 0 && (
                        <li className="py-0.5 text-xs text-[var(--muted)]">no columns</li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Local context fragments */}
        <div className="p-3 border-t border-[var(--border)]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Context ({fragments.length})
            </div>
            <button
              onClick={refreshFragments}
              title="Refresh"
              className="text-xs text-[var(--muted)] hover:text-black"
            >
              ↻
            </button>
          </div>
          {fragments.length === 0 && (
            <div className="text-xs text-[var(--muted)]">
              No saved context yet. Ask the assistant to “remember” a durable insight.
            </div>
          )}
          <ul className="text-sm flex flex-col gap-2">
            {fragments.map((f) => (
              <li key={f.id} className="group rounded-md border border-[var(--border)] bg-white p-2">
                <div className="flex items-start gap-1">
                  <span className="flex-1 font-medium text-[13px] leading-snug">{f.title}</span>
                  <button
                    title="Delete fragment"
                    className="opacity-0 group-hover:opacity-100 text-xs text-[var(--muted)] hover:text-red-600"
                    onClick={async () => {
                      await deleteFragment(f.id);
                      refreshFragments();
                    }}
                  >
                    ✕
                  </button>
                </div>
                <p className="text-xs text-[var(--muted)] mt-1 line-clamp-3 whitespace-pre-wrap">
                  {f.content}
                </p>
                {f.references.length > 0 && (
                  <div className="mt-1 text-[10px] text-[var(--muted)] truncate">
                    {f.references.join(', ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
