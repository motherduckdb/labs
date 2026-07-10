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
 */

/** Tools whose response envelope carries a `success` boolean we should honor. */
const SUCCESS_FIELD_TOOLS = new Set([
  'save_dive',
  'update_dive',
  'edit_dive_content',
  'delete_dive',
  'create_guide',
  'update_guide',
  'edit_guide_content',
  'delete_guide',
  'share_dive_data',
  'query_rw',
]);

/**
 * Guide-tool args the models pad with junk. GPT profiles fill EVERY optional
 * schema field with "" / 0 / an all-empty `reference` object, and the server
 * rejects those — observed live as 3-4 failed `list_guides` rounds before the
 * model learned to send minimal args. Strip empty-string and null values, and
 * drop a `reference` whose only surviving field is `type`.
 */
const GUIDE_ARG_SANITIZED_TOOLS = new Set(['list_guides', 'get_guide']);

function sanitizeGuideArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === '' || value === null || value === undefined) continue;
    if (key === 'reference' && value && typeof value === 'object') {
      const ref = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([, v]) => v !== '' && v !== null && v !== undefined,
        ),
      );
      const meaningful = Object.keys(ref).filter((k) => k !== 'type');
      if (meaningful.length === 0) continue;
      out.reference = ref;
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
  if (GUIDE_ARG_SANITIZED_TOOLS.has(name)) {
    return sanitizeGuideArgs(args);
  }
  return args;
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
