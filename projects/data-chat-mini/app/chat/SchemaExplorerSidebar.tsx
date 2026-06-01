'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSessionId } from '@/lib/session-id';
import { listFragments, deleteFragment, type Fragment } from '@/lib/context-store';
import { parseReference, type ParsedRef } from '@/lib/references';
import { DEMO_SCHEMA_COLUMNS, DEMO_SCHEMA_TABLES } from '@/lib/demo-mode';
import type { SchemaTable, SchemaColumn } from '@/lib/mcp-parsers';

/** A schema-qualified table selection — disambiguates same-named tables. */
interface SelectedTable { schema: string; name: string }

const tkey = (schema: string, name: string) => `${schema}.${name}`.toLowerCase();

/**
 * Does a parsed reference point at this specific table? Matches on table name
 * AND, when the reference names them, database + schema — so `db.main.orders`
 * links only to `main.orders`, not `archive.orders`. A reference that omits the
 * schema falls back to a name match (best effort).
 */
function refMatchesTable(p: ParsedRef, table: { schema: string; name: string }, database: string): boolean {
  if (p.isShare || !p.table) return false;
  if (p.database && p.database.toLowerCase() !== database.toLowerCase()) return false;
  if (p.table.toLowerCase() !== table.name.toLowerCase()) return false;
  if (p.schema && p.schema.toLowerCase() !== table.schema.toLowerCase()) return false;
  return true;
}

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
  demoReplay = false,
}: {
  database: string;
  contextReloadKey: number;
  demoReplay?: boolean;
}) {
  const [tables, setTables] = useState<SchemaTable[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, SchemaColumn[] | 'loading'>>({});
  const [openColumns, setOpenColumns] = useState<Record<string, boolean>>({});
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [openFrags, setOpenFrags] = useState<Record<string, boolean>>({});
  // Schema-qualified table the user has selected; filters the context list below.
  const [selectedTable, setSelectedTable] = useState<SelectedTable | null>(null);
  // Context scope. Defaults to the active database (the component is keyed by
  // `database`, so this resets to 'database' on every switch). 'all' shows
  // context referencing any database.
  const [scope, setScope] = useState<'database' | 'all'>('database');

  // The component is keyed by `database` in ChatShell, so it remounts (and
  // state resets to the initial null/{}) when the database changes — no
  // synchronous setState-in-effect resets needed.
  useEffect(() => {
    if (demoReplay) return;
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
  }, [database, demoReplay]);

  const refreshFragments = useCallback(() => {
    listFragments().then(setFragments).catch(() => setFragments([]));
  }, []);

  useEffect(() => {
    refreshFragments();
  }, [refreshFragments, contextReloadKey]);

  const activeTables = demoReplay ? DEMO_SCHEMA_TABLES : tables;

  // Map a schema-qualified table key (schema.name) → fragments that reference
  // exactly that table in THIS db. Schema-qualified so same-named tables in
  // different schemas don't share badges/filters.
  const fragmentsByTableKey = useMemo(() => {
    const m = new Map<string, Fragment[]>();
    if (!activeTables) return m;
    for (const t of activeTables) {
      const matched = fragments.filter((f) =>
        f.references.some((ref) => refMatchesTable(parseReference(ref), t, database)),
      );
      if (matched.length) m.set(tkey(t.schema, t.name), matched);
    }
    return m;
  }, [activeTables, fragments, database]);

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
    if (demoReplay) {
      setExpanded((prev) => ({ ...prev, [key]: DEMO_SCHEMA_COLUMNS[key] ?? [] }));
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
  const isTableSelected = (t: { schema: string; name: string }) =>
    !!selectedTable &&
    selectedTable.schema.toLowerCase() === t.schema.toLowerCase() &&
    selectedTable.name.toLowerCase() === t.name.toLowerCase();

  const onTableClick = (t: SchemaTable) => {
    const key = `${t.schema}.${t.name}`;
    if (isTableSelected(t)) {
      setSelectedTable(null);
      if (expanded[key]) toggleTable(t);
    } else {
      setSelectedTable({ schema: t.schema, name: t.name });
      if (!expanded[key]) toggleTable(t);
    }
  };

  // Clicking a fragment's reference chip selects + reveals that exact table.
  const revealTable = (p: ParsedRef) => {
    const t = activeTables?.find((x) => refMatchesTable(p, x, database));
    if (!t) return;
    const key = `${t.schema}.${t.name}`;
    setSelectedTable({ schema: t.schema, name: t.name });
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
        f.references.some((ref) => refMatchesTable(parseReference(ref), selectedTable, database)),
      );
    }
    return base;
  }, [fragments, scope, selectedTable, database]);

  return (
    <div className="schema-sidebar">
      <div className="flex-1 overflow-y-auto">
        {/* Schema tree */}
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span>Schema</span>
            <code>{database}</code>
          </div>
          {demoReplay && <div className="schema-note">Replay schema is loaded from the validation transcript.</div>}
          {!demoReplay && tablesError && <div className="text-xs text-red-600">{tablesError}</div>}
          {activeTables === null && !tablesError && (
            <div className="text-xs text-[var(--muted)]">Loading…</div>
          )}
          {activeTables?.length === 0 && <div className="text-xs text-[var(--muted)]">No tables.</div>}
          <ul className="text-sm">
            {activeTables?.map((t) => {
              const key = `${t.schema}.${t.name}`;
              const cols = expanded[key];
              const refFrags = fragmentsByTableKey.get(tkey(t.schema, t.name));
              const isSelected = isTableSelected(t);
              return (
                <li key={key} id={`tbl-${key}`} className="mb-0.5">
                  <button
                    onClick={() => onTableClick(t)}
                    className={`schema-table-button ${isSelected ? 'selected' : ''}`}
                  >
                    <span className="schema-caret">{cols ? '▾' : '▸'}</span>
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
                    <ul className="schema-column-list">
                      {cols.map((c) => {
                        const columnKey = `${key}.${c.name}`;
                        const columnOpen = !!openColumns[columnKey];
                        const comment = c.comment?.trim();
                        return (
                          <li key={c.name} className="schema-column-item">
                            <button
                              type="button"
                              className={`schema-column-button ${columnOpen ? 'selected' : ''}`}
                              aria-expanded={columnOpen}
                              title={comment ? `Show comment: ${comment}` : 'No column comment'}
                              onClick={() => setOpenColumns((prev) => ({ ...prev, [columnKey]: !prev[columnKey] }))}
                            >
                              <span className="schema-column-name">{c.name}</span>
                              <span className="schema-column-type">{c.type}</span>
                            </button>
                            {columnOpen && (
                              <div className="schema-column-comment">
                                {comment || 'No column comment.'}
                              </div>
                            )}
                          </li>
                        );
                      })}
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
        <div className="sidebar-section context-section">
          <div className="flex items-center justify-between mb-2">
            <div className="sidebar-heading compact">
              <span>Context</span>
              <code>{visibleFragments.length}</code>
            </div>
            <button
              onClick={refreshFragments}
              title="Refresh"
              className="icon-button"
            >
              ↻
            </button>
          </div>

          {/* Scope: default to the active database, or show all. */}
          <div className="segmented-control">
            <button
              onClick={() => setScope('database')}
              title={`Show context referencing ${database}`}
              className={scope === 'database' ? 'active' : ''}
            >
              {database}
            </button>
            <button
              onClick={() => setScope('all')}
              title="Show context across all databases"
              className={scope === 'all' ? 'active' : ''}
            >
              all
            </button>
          </div>

          {selectedTable && (
            <button
              onClick={() => setSelectedTable(null)}
              className="inline-link"
            >
              ✕ clear table filter (<code>{selectedTable.schema}.{selectedTable.name}</code>)
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
                <>No saved context references <code>{selectedTable.schema}.{selectedTable.name}</code>.</>
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
              const toggleFragment = () => setOpenFrags((prev) => ({ ...prev, [f.id]: !prev[f.id] }));
              return (
                <li
                  key={f.id}
                  className={`context-fragment-card group ${open ? 'open' : ''}`}
                  role={open ? undefined : 'button'}
                  tabIndex={open ? undefined : 0}
                  aria-expanded={open ? undefined : false}
                  onClick={(event) => {
                    if (open) return;
                    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, summary')) {
                      return;
                    }
                    toggleFragment();
                  }}
                  onKeyDown={(event) => {
                    if (open || event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleFragment();
                  }}
                >
                  <div className="flex items-start gap-1">
                    <button
                      onClick={toggleFragment}
                      className="flex flex-1 items-start gap-1 text-left"
                      title={open ? 'Collapse' : 'Expand'}
                    >
                      <span className="text-[var(--muted)] text-xs mt-0.5 w-3 shrink-0">{open ? '▾' : '▸'}</span>
                      <span className="flex-1 font-medium text-[13px] leading-snug">{f.title}</span>
                    </button>
                    <button
                      title="Delete fragment"
                      className="opacity-0 group-hover:opacity-100 text-xs text-[var(--muted)] hover:text-red-600 shrink-0"
                      onClick={async (event) => {
                        event.stopPropagation();
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
                              onClick={(event) => {
                                event.stopPropagation();
                                if (clickable) revealTable(p);
                              }}
                              title={clickable ? `Show ${p.label} in the schema tree` : ref}
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
