/**
 * Chat-agent behavior that sits between `mcp-client` (generic MCP transport)
 * and the chat route. Two responsibilities:
 *
 *   1. Apply server-side argument defaults before dispatch, so the model
 *      doesn't have to remember flags we always want set.
 *   2. Detect payload-level failures. The MotherDuck MCP write tools return
 *      HTTP 200 + `{ success: false, error: "..." }` on failure. The MCP
 *      envelope's `isError` stays false, so the agent otherwise moves on
 *      thinking the write succeeded. We parse the content and surface the
 *      failure back to the model as a real tool error.
 *
 * Guide API note (post-migration): guides are selected by `uuid`, not path,
 * and grouped by an optional `topic` (slash-separated label) rather than a
 * folder-style path. `create_guide`/`update_guide` carry an optional
 * `references[]` array of structured refs; `edit_guide_content` carries an
 * `edits[]` array of `{old_string, new_string, replace_all?}` — never a flat
 * old/new pair.
 */

/**
 * Tools whose response envelope carries a `success` boolean we should honor.
 * This must be exactly the WRITE set. `list_guides` (a read) also returns
 * `{success: true, ...}` on the new server, so `detectPayloadFailure` keys off
 * this set rather than "does the payload have a `success` field" — otherwise
 * a read would get misclassified as a failure-checkable write. Includes
 * `update_guide_metadata` and `set_guide_access` for completeness even though
 * the bot currently blocks both at the allowlist (`mcp-client.ts`); if either
 * is ever enabled, its envelope is already handled here.
 */
const SUCCESS_FIELD_TOOLS = new Set([
  'save_dive',
  'update_dive',
  'edit_dive_content',
  'delete_dive',
  'create_guide',
  'update_guide',
  'edit_guide_content',
  'delete_guide',
  'update_guide_metadata',
  'set_guide_access',
  'share_dive_data',
  'query_rw',
]);

/**
 * Guide-tool args the models pad with junk. GPT profiles fill EVERY optional
 * schema field with "" / 0 / an all-empty reference object, and the server
 * rejects those — observed live as 3-4 failed `list_guides` rounds before the
 * model learned to send minimal args. Strip empty-string and null optional
 * fields (`topic`, `version`, `change_comment`, `external_id`, `description`,
 * ...), and drop a `references[]` entry whose only surviving field is `type`.
 *
 * `uuid`, `title`, `content`, and `edits` are never touched here — they are
 * either the required selector/payload or (for `edits`) a structured array
 * the model must get exactly right; blanket-stripping empty strings out of
 * them would silently corrupt a legitimate write.
 */
const GUIDE_ARG_SANITIZED_TOOLS = new Set([
  'list_guides',
  'get_guide',
  'update_guide',
  'edit_guide_content',
  'create_guide',
]);

const NEVER_STRIP_KEYS = new Set(['uuid', 'title', 'content', 'edits']);

function sanitizeReferenceEntry(ref: Record<string, unknown>): Record<string, unknown> | null {
  const cleaned = Object.fromEntries(
    Object.entries(ref).filter(([, v]) => v !== '' && v !== null && v !== undefined),
  );
  const meaningful = Object.keys(cleaned).filter((k) => k !== 'type');
  return meaningful.length === 0 ? null : cleaned;
}

function sanitizeGuideArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (NEVER_STRIP_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    if (value === '' || value === null || value === undefined) continue;
    if (key === 'references' && Array.isArray(value)) {
      const cleaned = value
        .map((ref) =>
          ref && typeof ref === 'object' ? sanitizeReferenceEntry(ref as Record<string, unknown>) : ref,
        )
        .filter((ref) => ref !== null);
      if (cleaned.length === 0) continue;
      out.references = cleaned;
      continue;
    }
    if (key === 'version' && typeof value === 'string' && /^\d+$/.test(value)) {
      out.version = Number(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function applyToolArgDefaults(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'list_dives' && !('include_org_shares' in args)) {
    return { ...args, include_org_shares: true };
  }
  if (name === 'get_dive_guide') {
    // The server requires `client` (enum claude/chatgpt/claude_cowork/
    // claude_code/other); quackbot is none of the first-party surfaces, so
    // always pin 'other' regardless of what the model passed.
    return { ...args, client: 'other' };
  }
  let result = args;
  if (GUIDE_ARG_SANITIZED_TOOLS.has(name)) {
    result = sanitizeGuideArgs(result);
  }
  if (name === 'create_guide') {
    // Defense-in-depth: force private access even though the server itself
    // already gates non-user access for this token (verified live, Phase 0)
    // and `mcp-client.ts` also rejects a non-user `access` before dispatch.
    // Forcing here means a rejected write never happens in the first place.
    result = { ...result, access: 'user' };
  }
  return result;
}

export function detectPayloadFailure(
  name: string,
  text: string,
): { failed: boolean; message?: string } {
  if (!SUCCESS_FIELD_TOOLS.has(name)) return { failed: false };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { failed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { failed: false };
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.success === false) {
      const msg =
        typeof rec.error === 'string' ? rec.error
        : typeof rec.message === 'string' ? rec.message
        : 'Tool reported success: false';
      return { failed: true, message: msg };
    }
  }
  return { failed: false };
}
