'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSessionId } from '@/lib/session-id';
import { listFragments, deleteFragment, type Fragment } from '@/lib/context-store';
import { parseReference } from '@/lib/references';
import type { SchemaTable, SchemaColumn } from '@/lib/mcp-parsers';

/**
 * Slim schema explorer: a catalog tree (database → tables → columns) the human
 * can browse to understand the data, plus the local context-fragment list (the
 * IndexedDB-backed context layer the model reads/writes via the round-trip).
 *
 * The two halves are linked: each fragment card lists the database objects it
 * references (clickable → expands that table in the tree), and each referenced
 * table shows a badge with how many fragments point at it.
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
  const [openFrags, setOpenFrags] = useState<Record<string, boolean>>({});
  // Lowercased table name the user has selected; filters the context list below.
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  // Context scope. Defaults to the active database (the component is keyed by
  // `database`, so this resets to 'database' on every switch). 'all' shows
  // context referencing any database.
  const [scope, setScope] = useState<'database' | 'all'>('database');

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

  // Map a table name (lowercased) → fragments that reference it in THIS db, so
  // the schema tree can show how many saved insights relate to each object.
  const fragmentsByTable = useMemo(() => {
    const m = new Map<string, Fragment[]>();
    for (const f of fragments) {
      for (const ref of f.references) {
        const p = parseReference(ref);
        if (p.isShare || !p.table) continue;
        if (p.database && p.database.toLowerCase() !== database.toLowerCase()) continue;
        const k = p.table.toLowerCase();
        const arr = m.get(k) ?? [];
        if (!arr.includes(f)) arr.push(f);
        m.set(k, arr);
      }
    }
    return m;
  }, [fragments, database]);

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

  // Clicking a table row selects it (filtering the context list below to the
  // fragments that reference it) and expands its columns. Clicking the selected
  // table again clears the selection and collapses it.
  const onTableClick = (t: SchemaTable) => {
    const key = `${t.schema}.${t.name}`;
    const name = t.name.toLowerCase();
    if (selectedTable === name) {
      setSelectedTable(null);
      if (expanded[key]) toggleTable(t);
    } else {
      setSelectedTable(name);
      if (!expanded[key]) toggleTable(t);
    }
  };

  // Clicking a fragment's reference chip selects + reveals that table in the tree.
  const revealTable = (tableName: string) => {
    const t = tables?.find((x) => x.name.toLowerCase() === tableName.toLowerCase());
    if (!t) return;
    const key = `${t.schema}.${t.name}`;
    setSelectedTable(t.name.toLowerCase());
    if (!expanded[key]) toggleTable(t);
    document.getElementById(`tbl-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // Context list, narrowed by scope (current database vs all) and then by the
  // selected table when one is active.
  const visibleFragments = useMemo(() => {
    let base = fragments;
    if (scope === 'database') {
      base = base.filter((f) => {
        const dbRefs = f.references.map(parseReference).filter((p) => p.database && !p.isShare);
        // Uncategorized fragments (no database-typed reference) stay visible in
        // any database; otherwise show only those referencing this database.
        if (dbRefs.length === 0) return true;
        return dbRefs.some((p) => p.database!.toLowerCase() === database.toLowerCase());
      });
    }
    if (selectedTable) {
      base = base.filter((f) =>
        f.references.some((ref) => {
          const p = parseReference(ref);
          return (
            p.table?.toLowerCase() === selectedTable &&
            (!p.database || p.database.toLowerCase() === database.toLowerCase())
          );
        }),
      );
    }
    return base;
  }, [fragments, scope, selectedTable, database]);

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
              const refFrags = fragmentsByTable.get(t.name.toLowerCase());
              const isSelected = selectedTable === t.name.toLowerCase();
              return (
                <li key={key} id={`tbl-${key}`} className="mb-0.5">
                  <button
                    onClick={() => onTableClick(t)}
                    className={`flex w-full items-center gap-1 rounded px-1 py-1 text-left ${
                      isSelected ? 'bg-[var(--accent)]/15' : 'hover:bg-white/70'
                    }`}
                  >
                    <span className="text-[var(--muted)] w-3 text-xs">{cols ? '▾' : '▸'}</span>
                    <span className="truncate font-medium">{t.name}</span>
                    {t.type !== 'table' && (
                      <span className="ml-1 text-[10px] text-[var(--muted)]">{t.type}</span>
                    )}
                    {refFrags && refFrags.length > 0 && (
                      <span
                        className="ml-auto shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] font-medium text-[var(--accent)]"
                        title={`${refFrags.length} saved context fragment(s):\n` + refFrags.map((f) => `• ${f.title}`).join('\n')}
                      >
                        ⬡ {refFrags.length}
                      </span>
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
              Context ({visibleFragments.length})
            </div>
            <button
              onClick={refreshFragments}
              title="Refresh"
              className="text-xs text-[var(--muted)] hover:text-black"
            >
              ↻
            </button>
          </div>

          {/* Scope: default to the active database, or show all. */}
          <div className="mb-2 inline-flex rounded-md border border-[var(--border)] overflow-hidden text-[10px]">
            <button
              onClick={() => setScope('database')}
              title={`Show context referencing ${database}`}
              className={`max-w-[140px] truncate px-2 py-0.5 ${
                scope === 'database' ? 'bg-[var(--accent)] text-white' : 'bg-white text-[var(--muted)] hover:text-black'
              }`}
            >
              {database}
            </button>
            <button
              onClick={() => setScope('all')}
              title="Show context across all databases"
              className={`px-2 py-0.5 border-l border-[var(--border)] ${
                scope === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-white text-[var(--muted)] hover:text-black'
              }`}
            >
              all
            </button>
          </div>

          {selectedTable && (
            <button
              onClick={() => setSelectedTable(null)}
              className="block mb-2 text-[10px] text-[var(--accent)] hover:underline"
            >
              ✕ clear table filter (<code>{selectedTable}</code>)
            </button>
          )}

          {fragments.length === 0 && (
            <div className="text-xs text-[var(--muted)]">
              No saved context yet. Ask the assistant to “remember” a durable insight.
            </div>
          )}
          {fragments.length > 0 && visibleFragments.length === 0 && (
            <div className="text-xs text-[var(--muted)]">
              {selectedTable ? (
                <>No saved context references <code>{selectedTable}</code>.</>
              ) : (
                <>
                  No context references <code>{database}</code>.{' '}
                  <button onClick={() => setScope('all')} className="text-[var(--accent)] hover:underline">
                    Show all
                  </button>
                </>
              )}
            </div>
          )}
          <ul className="text-sm flex flex-col gap-2">
            {visibleFragments.map((f) => {
              const open = !!openFrags[f.id];
              return (
                <li key={f.id} className="group rounded-md border border-[var(--border)] bg-white p-2">
                  <div className="flex items-start gap-1">
                    <button
                      onClick={() => setOpenFrags((prev) => ({ ...prev, [f.id]: !prev[f.id] }))}
                      className="flex flex-1 items-start gap-1 text-left"
                      title={open ? 'Collapse' : 'Expand'}
                    >
                      <span className="text-[var(--muted)] text-xs mt-0.5 w-3 shrink-0">{open ? '▾' : '▸'}</span>
                      <span className="flex-1 font-medium text-[13px] leading-snug">{f.title}</span>
                    </button>
                    <button
                      title="Delete fragment"
                      className="opacity-0 group-hover:opacity-100 text-xs text-[var(--muted)] hover:text-red-600 shrink-0"
                      onClick={async () => {
                        if (!window.confirm(`Delete saved context "${f.title}"? This can't be undone.`)) return;
                        await deleteFragment(f.id);
                        refreshFragments();
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  {open ? (
                    <div className="prose prose-sm max-w-none mt-1 text-xs leading-relaxed text-[var(--foreground)] prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-1 prose-headings:text-xs prose-pre:my-1 prose-pre:text-[11px] prose-code:text-[11px]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{f.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--muted)] mt-1 line-clamp-2 whitespace-pre-wrap">
                      {f.content}
                    </p>
                  )}

                  {open && f.references.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">References</div>
                      <div className="flex flex-wrap gap-1">
                        {f.references.map((ref, i) => {
                          const p = parseReference(ref);
                          const clickable = !p.isShare && !!p.table;
                          return (
                            <button
                              key={i}
                              disabled={!clickable}
                              onClick={() => clickable && revealTable(p.table!)}
                              title={clickable ? `Show ${p.table} in the schema tree` : ref}
                              className={`rounded px-1.5 py-0.5 text-[10px] border border-[var(--border)] ${
                                clickable
                                  ? 'bg-[var(--panel)] hover:border-[var(--accent)] hover:text-[var(--accent)] cursor-pointer'
                                  : 'bg-[var(--panel)] text-[var(--muted)] cursor-default'
                              }`}
                            >
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
