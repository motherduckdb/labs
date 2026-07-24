'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSessionId } from '@/lib/session-id';
import { DEMO_SCHEMA_COLUMNS, DEMO_SCHEMA_TABLES } from '@/lib/demo-mode';
import type { SchemaTable, SchemaColumn } from '@/lib/mcp-parsers';
import { mergeRelatedGuides, countSidebarGuides, type GuideSummary, type TopicSummary } from '@/lib/guide-view';

/** A schema-qualified table selection — disambiguates same-named tables. */
interface SelectedTable { schema: string; name: string }

/** A catalog reference row in the (advanced) references editor. */
interface RefRow { database: string; schema: string; table: string; description: string }

const PROSE =
  'prose prose-sm max-w-none text-sm leading-relaxed text-[var(--foreground)] prose-headings:font-semibold prose-h1:text-lg prose-h1:mt-0 prose-h2:text-base prose-h3:text-sm prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-table:text-xs prose-th:text-left prose-code:text-[12px] prose-pre:text-[12px]';

/** Normalize a name for loose db-matching (nba_box_scores_v2 ≈ nba-box-scores-v2). */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * get_guide returns a *rendered* text: "<title>\n<uuid: … · vN · access>\n\n
 * <description>\n\n<stored markdown>". Recover the stored markdown body by
 * stripping only the lines that match the known title/meta/description, so
 * an edit round-trip doesn't fold the preamble back into the body.
 */
function extractStoredBody(rendered: string, summary: { title?: string; description?: string }): string {
  const lines = rendered.split('\n');
  let i = 0;
  if (summary.title && lines[i]?.trim() === summary.title.trim()) i++;
  if (/·\s*v\d+\s*·/.test(lines[i] ?? '')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (summary.description && lines[i]?.trim() === summary.description.trim()) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
  }
  return lines.slice(i).join('\n');
}

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
  // Guides the server attests are about this database via structured catalog
  // references (reference-driven, includes private guides) — authoritative,
  // unioned into the database-scope list ahead of the text match.
  const [relatedGuides, setRelatedGuides] = useState<GuideSummary[]>([]);
  const [expanded, setExpanded] = useState<Record<string, SchemaColumn[] | 'loading'>>({});
  const [openColumns, setOpenColumns] = useState<Record<string, boolean>>({});
  const [guides, setGuides] = useState<GuideSummary[]>([]);
  const [topics, setTopics] = useState<TopicSummary[]>([]);
  // Guides fetched lazily per opened topic ('loading' while in flight).
  const [openTopics, setOpenTopics] = useState<Record<string, GuideSummary[] | 'loading'>>({});
  const [guidesError, setGuidesError] = useState<string | null>(null);
  const [guidesLoading, setGuidesLoading] = useState(false);
  // Popover target: an existing guide (view/edit) or a blank create form.
  const [popover, setPopover] = useState<{ kind: 'guide'; guide: GuideSummary } | { kind: 'create' } | null>(null);
  const [selectedTable, setSelectedTable] = useState<SelectedTable | null>(null);
  const [scope, setScope] = useState<'database' | 'all'>('database');
  // Bumped by refreshGuides so sidebar-driven guide mutations (create/edit/
  // delete in the popover) also re-pull relatedGuides — otherwise a deleted
  // guide's related card would linger until a database switch. This is the
  // schema effect's ONLY refresh token besides the database itself: mount and
  // contextReloadKey changes both funnel through refreshGuides, so each cause
  // produces exactly one schema fetch (no double-fetch).
  const [schemaReloadKey, setSchemaReloadKey] = useState(0);
  // Skip the bump on refreshGuides' initial mount call — the schema effect's
  // own first run already fetches.
  const firstGuidesRefresh = useRef(true);
  // Generation guard: refreshGuides responses arriving out of order must not
  // let a stale response overwrite newer state (e.g. resurrect a just-deleted
  // guide). Only the latest generation applies.
  const guidesFetchGen = useRef(0);

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
        if (!cancelled) {
          setTables(data.tables || []);
          setRelatedGuides(Array.isArray(data.relatedGuides) ? data.relatedGuides : []);
        }
      } catch (err) {
        // Deliberate last-good behavior: tables/relatedGuides keep their prior
        // values on a failed re-fetch (consistent with the tables list).
        if (!cancelled) setTablesError(err instanceof Error ? err.message : 'Failed to load tables');
      }
    })();
    return () => { cancelled = true; };
  }, [database, demoReplay, schemaReloadKey]);

  const refreshGuides = useCallback(() => {
    if (demoReplay) return;
    setGuidesLoading(true);
    setGuidesError(null);
    // The root listing returns root-level guides plus every topic (flattened,
    // with counts); per-topic guides load lazily on expansion. A refresh
    // collapses open topics so nothing shows stale content.
    setOpenTopics({});
    if (firstGuidesRefresh.current) {
      firstGuidesRefresh.current = false;
    } else {
      setSchemaReloadKey((k) => k + 1);
    }
    const gen = ++guidesFetchGen.current;
    fetch('/api/guides', { headers: { 'x-session-id': getSessionId() } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (gen !== guidesFetchGen.current) return;
        setGuides(Array.isArray(data.guides) ? data.guides : []);
        setTopics(Array.isArray(data.topics) ? data.topics : []);
      })
      .catch((err) => {
        if (gen !== guidesFetchGen.current) return;
        setGuidesError(err instanceof Error ? err.message : 'Failed to load guides');
      })
      .finally(() => {
        if (gen === guidesFetchGen.current) setGuidesLoading(false);
      });
  }, [demoReplay]);

  const toggleTopic = useCallback((topic: string) => {
    setOpenTopics((prev) => {
      if (prev[topic]) {
        const next = { ...prev };
        delete next[topic];
        return next;
      }
      return { ...prev, [topic]: 'loading' };
    });
  }, []);

  // Fetch guides for topics newly marked 'loading'.
  useEffect(() => {
    const pending = Object.entries(openTopics).filter(([, v]) => v === 'loading').map(([t]) => t);
    if (pending.length === 0) return;
    let cancelled = false;
    for (const topic of pending) {
      fetch(`/api/guides?topic=${encodeURIComponent(topic)}`, { headers: { 'x-session-id': getSessionId() } })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (cancelled) return;
          setOpenTopics((prev) =>
            prev[topic] === 'loading' ? { ...prev, [topic]: Array.isArray(data.guides) ? data.guides : [] } : prev,
          );
        })
        .catch(() => {
          if (cancelled) return;
          setOpenTopics((prev) => (prev[topic] === 'loading' ? { ...prev, [topic]: [] } : prev));
        });
    }
    return () => { cancelled = true; };
  }, [openTopics]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshGuides();
    });
    return () => { cancelled = true; };
  }, [refreshGuides, contextReloadKey]);

  const activeTables = demoReplay ? DEMO_SCHEMA_TABLES : tables;

  const visibleGuides = useMemo(() => {
    if (scope === 'all') return guides;
    const dbNorm = norm(database);
    return guides.filter((g) => norm(`${g.topic} ${g.title} ${g.description}`).includes(dbNorm));
  }, [guides, scope, database]);

  const visibleTopics = useMemo(() => {
    if (scope === 'all') return topics;
    const dbNorm = norm(database);
    return topics.filter((t) => norm(t.topic).includes(dbNorm));
  }, [topics, scope, database]);

  // Guide cards to render in the root list. In 'all' scope this is just the
  // text-matched (full) list. In 'database' scope it's the union of the
  // server-attested relatedGuides (first) and the text match, deduped by uuid
  // with relatedGuides winning. Union + count logic lives in lib/guide-view.
  const displayGuides = useMemo(
    () => (scope === 'all' ? visibleGuides : mergeRelatedGuides(relatedGuides, visibleGuides)),
    [scope, relatedGuides, visibleGuides],
  );

  const guideCount = useMemo(
    () => countSidebarGuides(displayGuides, visibleTopics),
    [displayGuides, visibleTopics],
  );

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

        {/* Guides — the context layer */}
        <div className="sidebar-section context-section">
          <div className="flex items-center justify-between mb-2">
            <div className="sidebar-heading compact">
              <span>Guides</span>
              <code>{guideCount}</code>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPopover({ kind: 'create' })}
                title="Create a new personal guide"
                className="icon-button"
                disabled={demoReplay}
              >
                ＋
              </button>
              <button
                onClick={refreshGuides}
                title="Refresh guides"
                className="icon-button"
                disabled={demoReplay || guidesLoading}
              >
                ↻
              </button>
            </div>
          </div>

          <div className="segmented-control">
            <button
              onClick={() => setScope('database')}
              title={`Show guides about ${database}`}
              className={scope === 'database' ? 'active' : ''}
            >
              {database}
            </button>
            <button
              onClick={() => setScope('all')}
              title="Show every guide in the org"
              className={scope === 'all' ? 'active' : ''}
            >
              all
            </button>
          </div>

          {demoReplay && (
            <div className="text-xs text-[var(--muted)]">
              Guides load from MotherDuck and aren’t available in replay mode.
            </div>
          )}
          {!demoReplay && guidesError && <div className="text-xs text-red-600">{guidesError}</div>}
          {!demoReplay && !guidesError && guidesLoading && guides.length === 0 && (
            <div className="text-xs text-[var(--muted)]">Loading guides…</div>
          )}
          {!demoReplay && !guidesError && !guidesLoading && guides.length === 0 && topics.length === 0
            && displayGuides.length === 0 && (
            <div className="text-xs text-[var(--muted)]">
              No guides yet. Create one, or the assistant saves durable rules it learns as private guides.
            </div>
          )}
          {!demoReplay && !guidesError && (guides.length > 0 || topics.length > 0)
            && displayGuides.length === 0 && visibleTopics.length === 0 && (
            <div className="text-xs text-[var(--muted)]">
              No guides reference <code>{database}</code> yet. Guides appear here when they attach a
              catalog reference to this database or mention it in their topic, title, or description.{' '}
              <button onClick={() => setScope('all')} className="text-[var(--accent)] hover:underline">
                Show all
              </button>
            </div>
          )}

          <ul className="text-sm flex flex-col gap-2">
            {displayGuides.map((g) => (
              <li key={g.uuid}>
                <GuideCard guide={g} onOpen={() => setPopover({ kind: 'guide', guide: g })} />
              </li>
            ))}
          </ul>

          {/* Topics (folders) — guides load lazily on expansion. */}
          <ul className="text-sm mt-2">
            {visibleTopics.map((t) => {
              const loaded = openTopics[t.topic];
              return (
                <li key={t.topic} className="mb-0.5">
                  <button
                    onClick={() => toggleTopic(t.topic)}
                    className="schema-table-button"
                    title={`${t.guide_count} guide${t.guide_count === 1 ? '' : 's'} in ${t.topic}`}
                  >
                    <span className="schema-caret">{loaded ? '▾' : '▸'}</span>
                    <span className="truncate font-medium">{t.topic}</span>
                    <span className="ml-1 text-[10px] text-[var(--muted)]">{t.guide_count}</span>
                  </button>
                  {loaded === 'loading' && (
                    <div className="pl-6 py-0.5 text-xs text-[var(--muted)]">loading guides…</div>
                  )}
                  {Array.isArray(loaded) && (
                    <ul className="flex flex-col gap-2 pl-4 py-1">
                      {loaded.map((g) => (
                        <li key={g.uuid}>
                          <GuideCard guide={g} onOpen={() => setPopover({ kind: 'guide', guide: g })} />
                        </li>
                      ))}
                      {loaded.length === 0 && (
                        <li className="py-0.5 text-xs text-[var(--muted)]">no guides at this level</li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {popover && (
        <GuidePopover
          initialGuide={popover.kind === 'guide' ? popover.guide : null}
          activeDatabase={database}
          onClose={() => setPopover(null)}
          onListChanged={refreshGuides}
          onRenamed={(g) => setPopover({ kind: 'guide', guide: g })}
        />
      )}
    </div>
  );
}

function GuideCard({ guide: g, onOpen }: { guide: GuideSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="context-fragment-card w-full text-left"
      title="Open guide"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 font-medium text-[13px] leading-snug">{g.title || '(untitled)'}</span>
        <span
          className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 text-[10px] font-medium text-[var(--accent)]"
          title={g.access === 'organization' ? 'Org-wide guide' : g.access === 'user' ? 'Private guide' : `Access: ${g.access}`}
        >
          {g.access === 'organization' ? 'org' : g.access === 'user' ? 'private' : g.access}
        </span>
      </div>
      <p className="text-xs text-[var(--muted)] mt-1 line-clamp-2">
        {g.description || g.topic || '—'}
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------

function GuidePopover({
  initialGuide,
  activeDatabase,
  onClose,
  onListChanged,
  onRenamed,
}: {
  initialGuide: GuideSummary | null;
  activeDatabase: string;
  onClose: () => void;
  onListChanged: () => void;
  onRenamed: (g: GuideSummary) => void;
}) {
  const creating = initialGuide === null;
  const [guide, setGuide] = useState<GuideSummary | null>(initialGuide);
  const [mode, setMode] = useState<'view' | 'edit' | 'history'>(creating ? 'edit' : 'view');
  const [content, setContent] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(!creating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // History browsing.
  const [historyVersion, setHistoryVersion] = useState<number | null>(null);
  const [historyContent, setHistoryContent] = useState<string | null>(null);

  // Edit / create form.
  const [fTitle, setFTitle] = useState(initialGuide?.title ?? '');
  const [fDesc, setFDesc] = useState(initialGuide?.description ?? '');
  const [fTopic, setFTopic] = useState(creating ? 'data-chat-mini/' : (initialGuide?.topic ?? ''));
  const [fBody, setFBody] = useState('');
  const [fComment, setFComment] = useState('');
  const [replaceRefs, setReplaceRefs] = useState(false);
  const [refRows, setRefRows] = useState<RefRow[]>([{ database: activeDatabase, schema: '', table: '', description: '' }]);

  const loadContent = useCallback((uuid: string) => {
    setLoading(true);
    fetch(`/api/guides?uuid=${encodeURIComponent(uuid)}`, { headers: { 'x-session-id': getSessionId() } })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        setContent(typeof data.content === 'string' ? data.content : '');
        setVersion(typeof data.version === 'number' ? data.version : null);
      })
      .catch((e) => setContent(`Failed to load this guide: ${e instanceof Error ? e.message : 'unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (creating || !guide) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadContent(guide.uuid);
    });
    return () => { cancelled = true; };
  }, [creating, guide, loadContent]);

  // Escape closes the popover (but not while a text field is focused mid-edit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (mode !== 'view' && (tag === 'TEXTAREA' || tag === 'INPUT')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mode]);

  const storedBody = useMemo(
    () => (content ? extractStoredBody(content, { title: guide?.title, description: guide?.description }) : ''),
    [content, guide],
  );

  const beginEdit = () => {
    setFTitle(guide?.title ?? '');
    setFDesc(guide?.description ?? '');
    setFTopic(guide?.topic ?? '');
    setFBody(storedBody);
    setFComment('');
    setReplaceRefs(false);
    setError(null);
    setMode('edit');
  };

  const buildReferences = () =>
    refRows
      .filter((r) => r.database.trim())
      .map((r) => {
        const ref: Record<string, unknown> = {
          type: 'catalog',
          url: r.database.trim().startsWith('md:') ? r.database.trim() : `md:${r.database.trim()}`,
        };
        if (r.schema.trim()) ref.schema = r.schema.trim();
        if (r.table.trim()) ref.table = r.table.trim();
        if (r.description.trim()) ref.description = r.description.trim();
        return ref;
      });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        if (!fTitle.trim() || !fBody.trim()) {
          setError('Title and content are required.');
          setBusy(false);
          return;
        }
        const body: Record<string, unknown> = {
          title: fTitle.trim(), content: fBody, description: fDesc.trim(),
        };
        const topic = fTopic.trim().replace(/^\/+|\/+$/g, '');
        if (topic) body.topic = topic;
        if (fComment.trim()) body.changeComment = fComment.trim();
        if (replaceRefs) body.references = buildReferences();
        const res = await fetch('/api/guides', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-id': getSessionId() },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || data.error) { setError(data.error || `HTTP ${res.status}`); setBusy(false); return; }
        onListChanged();
        onClose();
        return;
      }

      // Edit existing: send only what changed.
      const body: Record<string, unknown> = { uuid: guide!.uuid };
      const topic = fTopic.trim().replace(/^\/+|\/+$/g, '');
      if (fTitle.trim() !== guide!.title) body.title = fTitle.trim();
      if (fDesc.trim() !== guide!.description) body.description = fDesc.trim();
      if (topic !== guide!.topic) body.topic = topic;
      if (fBody !== storedBody) body.content = fBody;
      if (replaceRefs) body.references = buildReferences();
      if (fComment.trim()) body.changeComment = fComment.trim();
      const res = await fetch('/api/guides', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-session-id': getSessionId() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `HTTP ${res.status}`); setBusy(false); return; }
      const next: GuideSummary = {
        uuid: guide!.uuid,
        topic,
        title: fTitle.trim() || guide!.title,
        description: fDesc.trim(),
        access: guide!.access,
      };
      onListChanged();
      setGuide(next);
      setMode('view');
      void loadContent(next.uuid);
      if (next.topic !== guide!.topic) onRenamed(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!guide) return;
    if (!window.confirm(`Delete guide "${guide.title || guide.uuid}"? It can be recovered from version history by an admin.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guides?uuid=${encodeURIComponent(guide.uuid)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': getSessionId() },
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || `HTTP ${res.status}`); setBusy(false); return; }
      onListChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setBusy(false);
    }
  };

  const openHistory = () => {
    if (!version || version <= 1) return;
    setMode('history');
    loadHistory(version - 1);
  };

  const loadHistory = (v: number) => {
    if (!guide) return;
    setHistoryVersion(v);
    setHistoryContent(null);
    fetch(`/api/guides?uuid=${encodeURIComponent(guide.uuid)}&version=${v}`, { headers: { 'x-session-id': getSessionId() } })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
        return data;
      })
      .then((data) => setHistoryContent(typeof data.content === 'string' ? data.content : ''))
      .catch((e) => setHistoryContent(`Failed to load this version: ${e instanceof Error ? e.message : 'unknown error'}`));
  };

  const title = creating ? 'New guide' : (guide?.title || 'Guide');

  return createPortal(
    <div
      className="guide-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="guide-modal">
        <div className="guide-modal-header">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="guide-modal-title">{title}</span>
              {guide && (
                <span
                  className="shrink-0 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]"
                  title={guide.access === 'organization' ? 'Org-wide guide' : guide.access === 'user' ? 'Private guide' : `Access: ${guide.access}`}
                >
                  {guide.access === 'organization' ? 'org' : guide.access === 'user' ? 'private' : guide.access}
                </span>
              )}
            </div>
            {mode === 'view' && guide?.description && <div className="guide-modal-desc">{guide.description}</div>}
            {guide && <div className="guide-modal-path">{guide.topic || '(no topic)'}</div>}
          </div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close guide" disabled={busy}>✕</button>
        </div>

        <div className="guide-modal-body">
          {error && <div className="guide-inline-error mb-3">{error}</div>}

          {/* VIEW */}
          {mode === 'view' && (
            loading ? (
              <p className="text-xs text-[var(--muted)]">loading guide…</p>
            ) : (
              <>
                {version !== null && (
                  <div className="guide-version-bar">Version {version}{version > 1 ? ' (current)' : ''}</div>
                )}
                <div className={PROSE}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{storedBody || '_(empty guide)_'}</ReactMarkdown>
                </div>
              </>
            )
          )}

          {/* HISTORY */}
          {mode === 'history' && (
            <>
              <div className="guide-version-bar">
                <button className="icon-button" disabled={!historyVersion || historyVersion <= 1} onClick={() => historyVersion && loadHistory(historyVersion - 1)} title="Older version">◀</button>
                <span>Version {historyVersion} of {version}</span>
                <button className="icon-button" disabled={!historyVersion || !version || historyVersion >= version - 1} onClick={() => historyVersion && loadHistory(historyVersion + 1)} title="Newer version">▶</button>
                <span className="spacer flex-1" />
                <button className="ghost-button" onClick={() => setMode('view')}>Back to current</button>
              </div>
              {historyContent === null ? (
                <p className="text-xs text-[var(--muted)]">loading version…</p>
              ) : (
                <div className={PROSE}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {extractStoredBody(historyContent, { title: guide?.title, description: guide?.description })}
                  </ReactMarkdown>
                </div>
              )}
            </>
          )}

          {/* EDIT / CREATE */}
          {mode === 'edit' && (
            <>
              <div className="guide-field">
                <label className="guide-field-label">Title</label>
                <input className="guide-input" value={fTitle} onChange={(e) => setFTitle(e.target.value)} placeholder="Guide title" />
              </div>
              <div className="guide-field">
                <label className="guide-field-label">Description</label>
                <input className="guide-input" value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="One-line summary" />
              </div>
              <div className="guide-field">
                <label className="guide-field-label">{creating ? 'Topic' : 'Topic (change to move)'}</label>
                <input className="guide-input" value={fTopic} onChange={(e) => setFTopic(e.target.value)} placeholder="data-chat-mini/joins" spellCheck={false} />
                {creating && (
                  <span className="guide-refs-note">Guides created here are private (<code>access: user</code>). The topic is a slash-separated folder label, e.g. <code>data-chat-mini/nba</code>.</span>
                )}
              </div>
              <div className="guide-field">
                <label className="guide-field-label">Content (markdown)</label>
                <textarea className="guide-textarea" value={fBody} onChange={(e) => setFBody(e.target.value)} placeholder="# Heading — rules the model should follow…" spellCheck={false} />
              </div>

              <div className="guide-field">
                <label className="guide-field-label" style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0 }}>
                  <input type="checkbox" checked={replaceRefs} onChange={(e) => setReplaceRefs(e.target.checked)} />
                  Replace references (advanced)
                </label>
                {replaceRefs && (
                  <>
                    <div className="guide-refs-note">
                      MotherDuck doesn’t expose a guide’s saved references for reading, so this can’t show existing ones — turning it on <strong>overwrites</strong> the full reference list with the rows below. Leave it off to keep current references. References usually also live in the guide’s markdown body above.
                    </div>
                    {refRows.map((r, i) => (
                      <div className="guide-ref-row" key={i}>
                        <input className="guide-input" value={r.database} placeholder="database" onChange={(e) => setRefRows((rows) => rows.map((x, j) => j === i ? { ...x, database: e.target.value } : x))} />
                        <input className="guide-input" value={r.schema} placeholder="schema" onChange={(e) => setRefRows((rows) => rows.map((x, j) => j === i ? { ...x, schema: e.target.value } : x))} />
                        <input className="guide-input" value={r.table} placeholder="table" onChange={(e) => setRefRows((rows) => rows.map((x, j) => j === i ? { ...x, table: e.target.value } : x))} />
                        <input className="guide-input" value={r.description} placeholder="why it matters" onChange={(e) => setRefRows((rows) => rows.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                        <button className="icon-button" title="Remove row" onClick={() => setRefRows((rows) => rows.filter((_, j) => j !== i))}>✕</button>
                      </div>
                    ))}
                    <button className="ghost-button" onClick={() => setRefRows((rows) => [...rows, { database: activeDatabase, schema: '', table: '', description: '' }])}>+ reference</button>
                  </>
                )}
              </div>

              <div className="guide-field">
                <label className="guide-field-label">Change note (optional)</label>
                <input className="guide-input" value={fComment} onChange={(e) => setFComment(e.target.value)} placeholder="what changed in this version" />
              </div>
            </>
          )}
        </div>

        {/* ACTIONS */}
        <div className="guide-modal-actions">
          {mode === 'view' && guide && (
            <>
              <button className="solid-button compact" onClick={beginEdit} disabled={busy || loading} title={loading ? 'Loading content…' : 'Edit this guide'}>Edit</button>
              <button
                className="ghost-button"
                disabled
                title="Changing org-wide visibility needs an authenticated admin/OAuth path — disabled in this app."
              >
                {guide.access === 'organization' ? 'Org-wide (admin-managed)' : 'Promote to org-wide'}
              </button>
              {version !== null && version > 1 && (
                <button className="ghost-button" onClick={openHistory} disabled={busy}>History</button>
              )}
              <span className="spacer" />
              <button className="ghost-button" onClick={remove} disabled={busy} style={{ color: 'var(--red)' }}>Delete</button>
            </>
          )}
          {mode === 'edit' && (
            <>
              <button className="solid-button compact" onClick={save} disabled={busy}>{busy ? 'Saving…' : (creating ? 'Create guide' : 'Save')}</button>
              <button className="ghost-button" onClick={() => (creating ? onClose() : setMode('view'))} disabled={busy}>Cancel</button>
            </>
          )}
          {mode === 'history' && <span className="text-xs text-[var(--muted)]">Viewing a past version (read-only).</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
