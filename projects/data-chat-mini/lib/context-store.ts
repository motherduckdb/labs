/**
 * Local context-fragment store (client-side, IndexedDB via idb-keyval).
 *
 * Mirrors the MotherDuck context-layer semantics so the model's
 * `query_context_layer` / `update_context_layer` calls — intercepted server-
 * side and routed here via the `context_tool` round-trip — behave the same as
 * the real MCP would, but with zero MotherDuck writes. Swappable later.
 *
 * The sidebar reads this store directly so humans can browse/edit fragments;
 * anything saved here is visible to the model on its next query_context_layer.
 */
import { get, set, createStore } from 'idb-keyval';
import { uuid7 } from './uuid7';

export interface Fragment {
  id: string;
  title: string;
  content: string;
  references: string[];
  createdAt: number;
  updatedAt: number;
}

// Distinct IndexedDB *database* name from chat-storage. idb-keyval's
// createStore creates a DB with exactly one object store at version 1 and
// never upgrades it, so two createStore calls sharing one DB name (with
// different store names) collide — the second store is never created and its
// transactions throw NotFoundError. Each store gets its own DB.
const STORE_DB = 'data-chat-mini-context';
const STORE_NAME = 'context-layer';
const KEY = 'fragments';

let storePromise: ReturnType<typeof createStore> | null = null;
function getStore() {
  if (!storePromise) storePromise = createStore(STORE_DB, STORE_NAME);
  return storePromise;
}

export async function listFragments(): Promise<Fragment[]> {
  const all = (await get<Fragment[]>(KEY, await getStore())) || [];
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function writeAll(frags: Fragment[]): Promise<void> {
  await set(KEY, frags, await getStore());
}

function matchesReference(f: Fragment, reference: string): boolean {
  const r = reference.toLowerCase();
  return f.references.some((ref) => ref.toLowerCase().includes(r) || r.includes(ref.toLowerCase()));
}

/**
 * Tokenized keyword score for a fragment against query terms. A term "hits" a
 * field if it appears as a substring; title hits are weighted higher than
 * content/reference hits. Returns how many distinct terms matched (for AND vs
 * OR selection) and a relevance score (for ranking).
 */
function scoreFragment(f: Fragment, terms: string[]): { matchedTerms: number; score: number } {
  const title = f.title.toLowerCase();
  const content = f.content.toLowerCase();
  const refs = f.references.join(' ').toLowerCase();
  let matchedTerms = 0;
  let score = 0;
  for (const t of terms) {
    let hit = false;
    if (title.includes(t)) { score += 3; hit = true; }
    if (content.includes(t)) { score += 1; hit = true; }
    if (refs.includes(t)) { score += 1; hit = true; }
    if (hit) matchedTerms++;
  }
  return { matchedTerms, score };
}

export interface QueryArgs {
  query?: string;
  reference?: string;
  fragment_ids?: string[];
}

/**
 * Local context retrieval: tokenized keyword search.
 *
 * - `fragment_ids` → exact lookup.
 * - `reference` → substring match on the fragment's references (AND-ed with query).
 * - `query` → split into whitespace-separated terms; rank fragments by a
 *   weighted term-hit score. Prefer fragments matching ALL terms; if none do,
 *   fall back to those matching ANY term (so multi-word queries still recall
 *   partial matches). Ties break by recency.
 * - No query/reference → all fragments, recency order.
 *
 * (The real MotherDuck context layer does richer server-side search; this is
 * the local mirror — better than naive whole-string substring, no FTS engine.)
 */
export async function queryFragments(args: QueryArgs): Promise<Fragment[]> {
  const all = await listFragments();
  if (args.fragment_ids?.length) {
    const ids = new Set(args.fragment_ids);
    return all.filter((f) => ids.has(f.id));
  }

  let pool = all;
  if (args.reference) {
    pool = pool.filter((f) => matchesReference(f, args.reference!));
  }

  const terms = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return pool; // recency order from listFragments

  const scored = pool
    .map((f) => ({ f, ...scoreFragment(f, terms) }))
    .filter((x) => x.matchedTerms > 0);
  const allTerms = scored.filter((x) => x.matchedTerms === terms.length);
  const ranked = (allTerms.length ? allTerms : scored).sort(
    (a, b) => b.score - a.score || b.f.updatedAt - a.f.updatedAt,
  );
  return ranked.map((x) => x.f);
}

export interface UpdateArgs {
  action: 'create' | 'update' | 'delete';
  id?: string;
  title?: string;
  content?: string;
  references?: string[];
}

export async function applyUpdate(args: UpdateArgs): Promise<{ ok: boolean; fragment?: Fragment; message: string }> {
  const all = await listFragments();
  const now = Date.now();
  if (args.action === 'create') {
    const fragment: Fragment = {
      id: uuid7(),
      title: args.title?.trim() || 'Untitled fragment',
      content: args.content?.trim() || '',
      references: args.references ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await writeAll([fragment, ...all]);
    return { ok: true, fragment, message: `Created fragment "${fragment.title}" (id ${fragment.id}).` };
  }
  if (args.action === 'update') {
    if (!args.id) return { ok: false, message: 'update requires an id.' };
    const idx = all.findIndex(f => f.id === args.id);
    if (idx === -1) return { ok: false, message: `No fragment with id ${args.id}.` };
    const updated: Fragment = {
      ...all[idx],
      ...(args.title !== undefined && { title: args.title }),
      ...(args.content !== undefined && { content: args.content }),
      ...(args.references !== undefined && { references: args.references }),
      updatedAt: now,
    };
    all[idx] = updated;
    await writeAll(all);
    return { ok: true, fragment: updated, message: `Updated fragment "${updated.title}".` };
  }
  if (args.action === 'delete') {
    if (!args.id) return { ok: false, message: 'delete requires an id.' };
    const next = all.filter(f => f.id !== args.id);
    if (next.length === all.length) return { ok: false, message: `No fragment with id ${args.id}.` };
    await writeAll(next);
    return { ok: true, message: `Deleted fragment ${args.id}.` };
  }
  return { ok: false, message: `Unknown action "${args.action}".` };
}

/** Manual save from the sidebar UI. */
export async function saveFragment(input: { title: string; content: string; references?: string[] }): Promise<Fragment> {
  const res = await applyUpdate({ action: 'create', ...input });
  return res.fragment!;
}

export async function deleteFragment(id: string): Promise<void> {
  await applyUpdate({ action: 'delete', id });
}

/**
 * Service one intercepted context-tool call against the local store and return
 * the text the model should see as the tool_result content.
 */
export async function serviceContextTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ resultText: string; isError: boolean }> {
  try {
    if (name === 'query_context_layer') {
      const frags = await queryFragments(args as QueryArgs);
      if (frags.length === 0) {
        return { resultText: 'No saved context fragments matched.', isError: false };
      }
      const body = frags
        .map(f => `### ${f.title}\nid: ${f.id}\nreferences: ${f.references.join(', ') || '(none)'}\n\n${f.content}`)
        .join('\n\n---\n\n');
      return { resultText: `${frags.length} context fragment(s):\n\n${body}`, isError: false };
    }
    if (name === 'update_context_layer') {
      const res = await applyUpdate(args as unknown as UpdateArgs);
      return { resultText: res.message, isError: !res.ok };
    }
    return { resultText: `Unknown context tool "${name}".`, isError: true };
  } catch (err) {
    return { resultText: `Context store error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
