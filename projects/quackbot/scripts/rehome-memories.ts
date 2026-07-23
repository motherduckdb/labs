/**
 * rehome-memories.ts — Phase 4 of MCP_MIGRATION_PLAN.md.
 *
 * Re-homes the bot's 3 migrated memories from the literal legacy topic
 * `users/jm_quackbot/quackbot` to the new `quackbot/<area>` convention, and
 * attaches a `catalog` reference where the guide text names a confirmable
 * table.
 *
 * This is a one-shot keeper script run directly against the MCP with the
 * bot's PAT (not through the bot's own tool allowlist) — same transport
 * idiom as scripts/smoke-mcp.ts. It is hard-confined to the 3 uuids below;
 * it refuses to touch anything else.
 *
 * Run:
 *   npx tsx scripts/rehome-memories.ts
 *
 * Never logs the token.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const LEGACY_TOPIC = 'users/jm_quackbot/quackbot';

/** The ONLY guides this script is allowed to mutate. */
const TARGETS: Record<string, { label: string; newTopic: string }> = {
  'b00542d5-3dd5-4f95-947d-d95b4f37d9cd': {
    label: 'Ambient air quality data',
    newTopic: 'quackbot/air-quality',
  },
  '1d021566-1e73-4406-8a57-63a7e779c667': {
    label: 'NBA time-range scoring estimates',
    newTopic: 'quackbot/nba',
  },
  'ddff9b9d-90ab-431c-a24c-4992951272e8': {
    label: 'Taxi data table',
    newTopic: 'quackbot/taxi',
  },
};
const ALLOWED_UUIDS = new Set(Object.keys(TARGETS));

interface ToolResult {
  text: string;
  isError: boolean;
  json: unknown | null;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError === true;
  let text: string;
  let json: unknown | null = null;
  if (result.structuredContent != null) {
    json = result.structuredContent;
    text = JSON.stringify(result.structuredContent);
  } else {
    text = Array.isArray(result.content)
      ? result.content
          .map((b: { type: string; text?: string }) =>
            b.type === 'text' ? b.text : JSON.stringify(b))
          .join('\n')
      : JSON.stringify(result.content);
    try { json = JSON.parse(text); } catch { /* not JSON */ }
  }
  return { text, isError, json };
}

async function tryCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await callTool(client, name, args);
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true, json: null };
  }
}

/** Hard confinement guard — every mutating call in this script routes through here. */
async function guardedMutate(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const uuid = args.uuid;
  if (typeof uuid !== 'string' || !ALLOWED_UUIDS.has(uuid)) {
    throw new Error(
      `REFUSED: attempted to call ${name} on uuid ${JSON.stringify(uuid)} which is ` +
      `outside the confined set [${[...ALLOWED_UUIDS].join(', ')}]`,
    );
  }
  return tryCall(client, name, args);
}

function log(...parts: unknown[]) {
  console.log(...parts);
}

/** Extract a fully-qualified db.schema.table (or db.table) candidate from guide text. */
function findTableCandidates(text: string): string[] {
  // Look for markdown-code-spanned or bare dotted identifiers with 2-3 segments,
  // each segment a valid identifier (letters/digits/underscore, not starting with digit).
  const seg = '[a-zA-Z_][a-zA-Z0-9_]*';
  const re = new RegExp(`\\b(${seg})\\.(${seg})(?:\\.(${seg}))?\\b`, 'g');
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // Skip obvious non-table matches (urls, decimal-looking, single-letter noise)
    const whole = m[0];
    if (/^\d/.test(m[1])) continue;
    if (whole.includes('://')) continue;
    found.add(whole);
  }
  return [...found];
}

interface Db { name: string; url: string }

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN;
  const apiUrl = (process.env.MOTHERDUCK_API_URL ?? '').trim().replace(/\/$/, '');
  if (!token) throw new Error('No MOTHERDUCK_TOKEN in env.');
  if (!apiUrl) throw new Error('No MOTHERDUCK_API_URL in env.');

  log(`MCP endpoint: ${apiUrl}/mcp`);
  log(`Confined to ${ALLOWED_UUIDS.size} uuids: ${[...ALLOWED_UUIDS].join(', ')}`);
  log('');

  const client = new Client({ name: 'quackbot-rehome', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  const report: Array<{
    uuid: string; label: string; beforeTopic: string; afterTopic: string;
    metaUpdate: string; refAttached: string;
  }> = [];

  try {
    // ---- List databases up front (for catalog reference url values) ----------
    log('=== list_databases ===');
    const dbsRes = await tryCall(client, 'list_databases', {});
    const dbsJson = dbsRes.json as { databases?: Array<Record<string, unknown>> } | null;
    const databases: Db[] = (dbsJson?.databases ?? []).map((d) => ({
      name: String(d.alias ?? d.name ?? d.database_name ?? ''),
      url: String(d.url ?? `md:${d.alias ?? d.name ?? d.database_name ?? ''}`),
    })).filter((d) => d.name);
    log(`  ${databases.length} databases: ${databases.map((d) => d.name).join(', ')}`);
    if (dbsRes.isError) log(`  WARNING: list_databases errored: ${dbsRes.text.slice(0, 300)}`);

    for (const [uuid, target] of Object.entries(TARGETS)) {
      log(`\n=== Guide ${uuid} (${target.label}) ===`);

      // 1. get_guide + print text
      const got = await tryCall(client, 'get_guide', { uuid });
      if (got.isError) {
        log(`  get_guide FAILED: ${got.text.slice(0, 300)}`);
        report.push({
          uuid, label: target.label, beforeTopic: 'ERROR', afterTopic: 'SKIPPED',
          metaUpdate: `get_guide failed: ${got.text.slice(0, 150)}`, refAttached: 'skipped',
        });
        continue;
      }
      log(`  --- guide text (${got.text.length} chars) ---`);
      log(got.text);
      log('  --- end guide text ---');

      // Parse current topic out of the rendered text header if present.
      const topicMatch = got.text.match(/topic:\s*([^\n]+)/i);
      const beforeTopic = topicMatch ? topicMatch[1].trim() : LEGACY_TOPIC;

      // 2/3. update_guide_metadata to new topic (confined mutate)
      const metaRes = await guardedMutate(client, 'update_guide_metadata', {
        uuid, topic: target.newTopic,
      });
      const metaUpdate = metaRes.isError
        ? `FAILED: ${metaRes.text.slice(0, 200)}`
        : `topic -> ${target.newTopic}`;
      log(`  update_guide_metadata -> isError=${metaRes.isError}: ${metaRes.text.slice(0, 300)}`);

      // 4. Attach a catalog reference if an obvious, confirmable table is named.
      let refAttached = 'skipped (no confirmable table found)';
      const candidates = findTableCandidates(got.text);
      log(`  table candidates in text: ${candidates.join(', ') || '(none)'}`);

      let confirmedTable: string | undefined;
      let confirmedDb: Db | undefined;
      for (const cand of candidates) {
        const parts = cand.split('.');
        const dbName = parts[0];
        const db = databases.find((d) => d.name === dbName);
        if (!db) continue;
        // db.schema.table or db.table -> schema defaults to main
        const tableName = parts.length === 3 ? parts[2] : parts[1];
        const schemaName = parts.length === 3 ? parts[1] : 'main';
        const tablesRes = await tryCall(client, 'list_tables', { database: dbName });
        const tablesJson = tablesRes.json as { tables?: Array<Record<string, unknown>> } | null;
        const tables = tablesJson?.tables ?? [];
        const match = tables.find((t) =>
          String(t.name ?? t.table_name ?? '') === tableName &&
          (t.schema === undefined || String(t.schema) === schemaName));
        if (match) {
          confirmedTable = cand;
          confirmedDb = db;
          log(`  confirmed table exists: ${cand} (db=${db.name})`);
          break;
        }
        log(`  candidate ${cand} NOT found in list_tables(${dbName})`);
      }

      if (confirmedTable && confirmedDb) {
        const refRes = await guardedMutate(client, 'update_guide', {
          uuid,
          references: [{ type: 'catalog', url: confirmedDb.url, name: confirmedTable }],
        });
        if (refRes.isError) {
          refAttached = `FAILED: ${refRes.text.slice(0, 200)}`;
        } else {
          const rj = refRes.json as Record<string, unknown> | null;
          const versionText = JSON.stringify(rj).slice(0, 200);
          refAttached = `attached catalog ref -> ${confirmedTable} (${confirmedDb.url})`;
          log(`  update_guide(references) -> isError=false: ${versionText}`);
          // Verify content wasn't blanked by re-fetching.
          const verify = await tryCall(client, 'get_guide', { uuid });
          const blanked = verify.text.trim().length < got.text.trim().length * 0.5;
          if (blanked) {
            refAttached += ' -- WARNING: content may have been blanked, verify manually';
            log(`  *** WARNING: post-reference get_guide text shrank a lot (before=${got.text.length} after=${verify.text.length}) ***`);
          } else {
            log(`  verified content preserved after reference attach (before=${got.text.length}c after=${verify.text.length}c)`);
          }
        }
      } else {
        log(`  ${refAttached}`);
      }

      report.push({
        uuid, label: target.label, beforeTopic, afterTopic: target.newTopic,
        metaUpdate, refAttached,
      });
    }

    // ---- Verification: legacy topic empty, new topics populated ---------------
    log('\n=== Verification ===');
    const legacyList = await tryCall(client, 'list_guides', { topic: LEGACY_TOPIC });
    const legacyJson = legacyList.json as { guides?: unknown[] } | null;
    const legacyRemaining = legacyJson?.guides?.length ?? -1;
    log(`  list_guides({topic:'${LEGACY_TOPIC}'}) -> ${legacyRemaining} guides remaining`);

    for (const target of Object.values(TARGETS)) {
      const r = await tryCall(client, 'list_guides', { topic: target.newTopic });
      const rj = r.json as { guides?: Array<Record<string, unknown>> } | null;
      const guides = rj?.guides ?? [];
      log(`  list_guides({topic:'${target.newTopic}'}) -> ${guides.length} guide(s): ` +
        guides.map((g) => g.title).join(', '));
    }

    // ---- Before/after table -----------------------------------------------
    log('\n======== BEFORE/AFTER ========');
    for (const r of report) {
      log(`  uuid=${r.uuid}`);
      log(`    label:        ${r.label}`);
      log(`    topic before: ${r.beforeTopic}`);
      log(`    topic after:  ${r.afterTopic}`);
      log(`    metadata:     ${r.metaUpdate}`);
      log(`    reference:    ${r.refAttached}`);
    }
    log(`\n  legacy topic '${LEGACY_TOPIC}' remaining guides: ${legacyRemaining}`);

  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('rehome-memories fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
