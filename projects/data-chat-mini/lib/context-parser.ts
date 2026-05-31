/**
 * The MCP's structured `query_context_layer` truncates the `content` field
 * in list responses (`reference: …`, `query: …`) and appends a literal
 * `"...[truncated]"` marker. Only `fragment_ids: [id]` queries return the
 * full body. Detect the marker so callers can decide whether to display
 * the partial body, fetch by id for the canonical content, or refuse to
 * persist it back to the MCP (PUT with truncated content would clobber).
 */
export function isContentTruncated(content: string | undefined | null): boolean {
  if (typeof content !== 'string') return false;
  return content.endsWith('...[truncated]');
}

/**
 * Top-level parser for whatever shape `query_context_layer` happens to be
 * returning. The MCP has been through two response shapes:
 *
 *   1. Markdown body (the long-standing shape). Optional `{ context: "<md>" }`
 *      wrapper. `parseContextToFragments` parses these blocks.
 *
 *   2. Structured JSON `{ success, fragments: [...], fragmentCount, truncated }`
 *      with camelCase fields per-fragment. This is what the MCP returns as of
 *      2026-05 — and is what `parseContextToFragments`'s markdown splitter
 *      silently produces zero fragments from, since the JSON string has no
 *      `\n---\n` blocks or `## Title` lines.
 *
 * Caller doesn't have to know which is which — feed in the raw tool output,
 * get back fragment objects matching the legacy FragmentSummary shape so the
 * downstream UI doesn't have to branch.
 */
export function parseContextLayerResponse(raw: string): Array<Record<string, unknown>> {
  if (!raw) return [];
  // Shape 2 first — cheap to detect, and the new MCP is the common case now.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.fragments)) {
        return obj.fragments.map(normalizeStructuredFragment);
      }
      // Shape-1 wrapper `{ context: "<markdown>" }`.
      if (typeof obj.context === 'string') {
        return parseContextToFragments(obj.context);
      }
    }
  } catch {
    /* not JSON — fall through to markdown */
  }
  return parseContextToFragments(raw);
}

/**
 * Map the structured-JSON fragment shape (from the post-2026-05 MCP) onto
 * the legacy FragmentSummary/FragmentDetail field names the UI expects:
 *   visibility → accessMode (already 'USER' | 'ORGANIZATION')
 *   references → referencedObjects
 *   createdByUsername → createdBy (preferred over the uuid `createdBy`)
 *   updatedAt / createdAt → '' when absent
 */
function normalizeStructuredFragment(raw: unknown): Record<string, unknown> {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const visibility = typeof f.visibility === 'string' ? f.visibility : 'ORGANIZATION';
  const accessMode: 'USER' | 'ORGANIZATION' = visibility === 'USER' ? 'USER' : 'ORGANIZATION';
  const createdBy = typeof f.createdByUsername === 'string'
    ? f.createdByUsername
    : (typeof f.createdBy === 'string' ? f.createdBy : '');
  return {
    id: typeof f.id === 'string' ? f.id : '',
    title: typeof f.title === 'string' ? f.title : '',
    trustStatus: typeof f.trustStatus === 'string' ? f.trustStatus : 'in_development',
    referencedObjects: Array.isArray(f.references) ? f.references : [],
    content: typeof f.content === 'string' ? f.content : '',
    accessMode,
    source: typeof f.source === 'string' ? f.source : 'context_layer',
    createdBy,
    // The structured response doesn't carry timestamps yet. Mirror the
    // markdown parser's empty-string sentinel so the UI's falsy-check
    // hides MetaRow rather than rendering a dash.
    updatedAt: typeof f.updatedAt === 'string' ? f.updatedAt : '',
    createdAt: typeof f.createdAt === 'string' ? f.createdAt : '',
  };
}

/**
 * Parse the markdown-formatted context string from query_context_layer
 * into an array of fragment objects matching the FragmentSummary/FragmentDetail shape.
 */
export function parseContextToFragments(context: string): Array<Record<string, unknown>> {
  const fragments: Array<Record<string, unknown>> = [];

  // Naively splitting on `\n---\n` mangles any fragment whose content uses
  // markdown horizontal rules — exactly the case for style guides written
  // with section separators like:
  //
  //   ## Palette
  //   - accent: #ff5500
  //   ---
  //   ## Typography
  //
  // We split on `\n---\n` as the MCP framing separator, then re-join any
  // chunk that doesn't look like a fresh fragment header (must have a
  // `## Title` line AND an `_id:` line) back onto the previous one. That
  // preserves the HR inside the content.
  const rawBlocks = context.split('\n---\n').filter(b => b.trim());
  const isFragmentStart = (block: string): boolean => {
    const lines = block.split('\n');
    const hasTitle = lines.some(l => l.startsWith('## '));
    const hasId = lines.some(l => /_id:\s*[0-9a-f-]/i.test(l));
    return hasTitle && hasId;
  };
  const blocks: string[] = [];
  for (const raw of rawBlocks) {
    if (blocks.length > 0 && !isFragmentStart(raw)) {
      // Continuation of the previous fragment's content — restore the `---`
      // separator we split on so the horizontal rule survives.
      blocks[blocks.length - 1] = blocks[blocks.length - 1] + '\n---\n' + raw;
    } else {
      blocks.push(raw);
    }
  }

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    // Title line format: "## Title [status] (visibility)"
    //   - [status] is optional: in_development | completed | endorsed | archived
    //   - (visibility) is optional: personal | organization (and any future labels)
    // Prior regex required \s*$ right after the optional [status], which silently
    // dropped the status whenever the (visibility) suffix was present — so every
    // fragment defaulted to 'in_development' in the UI regardless of actual state.
    const titleLine = lines.find(l => l.startsWith('## '));
    if (!titleLine) continue;

    const titleMatch = titleLine.match(/^## (.+?)(?:\s*\[(\w+)\])?(?:\s*\(([^)]+)\))?\s*$/);
    const title = titleMatch?.[1]?.trim() || titleLine.slice(3).trim();
    const trustStatus = titleMatch?.[2] || 'in_development';
    const visibilityLabel = titleMatch?.[3]?.trim().toLowerCase();
    // MCP convention: USER fragments render with `(personal)`; ORGANIZATION
    // fragments have no visibility suffix at all. A missing suffix therefore
    // means ORGANIZATION — NOT USER. The inverse of the naive default caused
    // the "change scope Personal → Shared silently rolls back" bug: the MCP
    // actually flipped the fragment, dropped the `(personal)` marker, and
    // our parser re-derived USER and snapped the UI back.
    const accessMode: 'USER' | 'ORGANIZATION' = visibilityLabel === 'personal' ? 'USER' : 'ORGANIZATION';

    // ID line: `_id: UUID | by: USERNAME_` — the leading `_id:` and trailing
    // `_` are markdown italics markers wrapping the whole line. Username can
    // include `@` (e.g. `mdw-writer@motherduck-com`) so we capture greedily
    // up to the closing italics underscore.
    const idLine = lines.find(l => l.includes('_id:'));
    const idMatch = idLine?.match(/_id:\s*([0-9a-f-]+)/);
    const id = idMatch?.[1];
    if (!id) continue;
    const byMatch = idLine?.match(/\bby:\s*([^_\n]+?)_?\s*$/);
    const createdBy = byMatch?.[1]?.trim() || '';

    // References line
    const refLine = lines.find(l => l.startsWith('References:'));
    const refs = refLine
      ? refLine.slice('References:'.length).trim().split(/,\s*/).filter(Boolean)
      : [];

    // Content: everything after the metadata lines (title, id, references)
    const titleIdx = lines.indexOf(titleLine);
    const refIdx = lines.findIndex(l => l.startsWith('References:'));
    const contentStart = Math.max(titleIdx, refIdx) + 1;
    const content = lines.slice(contentStart).join('\n').trim();

    fragments.push({
      id,
      title,
      trustStatus,
      referencedObjects: refs,
      content,
      accessMode,
      source: 'context_layer',
      createdBy,
      // Timestamps are not in the query_context_layer markdown response —
      // leaving these empty so the UI's MetaRow falsy-check hides them
      // rather than rendering a sentinel like "—".
      updatedAt: '',
    });
  }

  return fragments;
}
