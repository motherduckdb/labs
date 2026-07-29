/**
 * smoke-mcp.ts — pin the live MotherDuck MCP tool surface for quackbot.
 *
 * Phase 0 of MCP_MIGRATION_PLAN.md. Connects to the prod MCP with the bot's
 * `jm_quackbot` PAT and exercises the guide/dive tool surface the bot's memory
 * layer will be rebuilt on: tools/list drift, guide CRUD envelopes, dupe-create
 * behavior, cross-user + org-access ACLs, the bot's existing memory inventory,
 * and the stock dive guide.
 *
 * This talks to the MCP directly (not through src/core/mcp-client's allowlist)
 * because Phase 0's job is to observe the *raw* server, including tools the bot
 * keeps blocked (delete_guide, set_guide_access). It reuses the same transport
 * idiom as createMCPClient so what we learn transfers verbatim.
 *
 * Run:
 *   set -a; source /path/to/quackbot/.env; set +a
 *   npx tsx scripts/smoke-mcp.ts [acl-target-uuid]
 *
 * The ACL target (probe 4) is a guide owned by a DIFFERENT user; pass its uuid
 * as argv[1] or ACL_TARGET_UUID. Never logs the token.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const SMOKE_TOPIC = 'quackbot/smoke';
// Where probe 8 saves the stock dive guide (override with DIVE_GUIDE_OUT).
const DIVE_GUIDE_OUT = process.env.DIVE_GUIDE_OUT ?? '/tmp/dive-guide-prod.md';

/** Tool names the migration plan expects the server to expose. */
const EXPECTED_TOOLS = [
  'query', 'query_rw', 'list_databases', 'list_tables', 'list_columns',
  'list_views', 'list_macros', 'list_shares', 'search_catalog',
  'list_guides', 'get_guide', 'create_guide', 'update_guide',
  'edit_guide_content', 'update_guide_metadata', 'set_guide_access',
  'delete_guide', 'get_query_guide', 'get_dive_guide', 'get_flight_guide',
  'save_dive', 'list_dives', 'read_dive', 'update_dive', 'edit_dive_content',
  'delete_dive', 'share_dive_data', 'dive_query', 'view_dive',
  'mint_dive_state_reference', 'log_dive_viewer_event', 'ask_docs_question',
  'get_short_lived_token', 'create_flight', 'update_flight', 'delete_flight',
  'run_flight', 'cancel_flight_run', 'get_flight', 'get_flight_logs',
  'list_flight_runs', 'list_flight_versions', 'edit_flight_source',
];

/** Guide tools whose inputSchema arg shapes we want pinned. */
const GUIDE_TOOLS = [
  'list_guides', 'get_guide', 'create_guide', 'update_guide',
  'edit_guide_content', 'update_guide_metadata', 'set_guide_access',
  'delete_guide', 'get_query_guide', 'get_dive_guide', 'get_flight_guide',
];

type Verdict = 'PASS' | 'FAIL' | 'INFO';
const summary: Array<{ probe: string; verdict: Verdict; note: string }> = [];
function record(probe: string, verdict: Verdict, note: string) {
  summary.push({ probe, verdict, note });
}

/** Guides this run created; every one must be deleted before exit. */
const createdUuids = new Set<string>();

interface ToolResult {
  text: string;
  isError: boolean;
  json: unknown | null;
}

/**
 * Call a tool and normalize its response the same way executeToolWithStatus
 * does (structuredContent wins, else joined text blocks), plus a best-effort
 * JSON parse so probes can inspect the envelope.
 */
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

/** callTool that never throws — turns a thrown/rejected call into an error result. */
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

/** Pull a guide uuid out of whatever envelope create_guide returns. */
function extractUuid(r: ToolResult): string | undefined {
  const j = r.json as Record<string, unknown> | null;
  if (j && typeof j === 'object') {
    for (const k of ['uuid', 'id', 'guide_uuid']) {
      const v = j[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    const guide = j.guide as Record<string, unknown> | undefined;
    if (guide && typeof guide.uuid === 'string') return guide.uuid;
  }
  const m = r.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m?.[0];
}

/** Short preview of an envelope for the console (never the token). */
function envelope(r: ToolResult): string {
  const j = r.json as Record<string, unknown> | null;
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    return `keys={${Object.keys(j).join(', ')}} isError=${r.isError}`;
  }
  return `text[${r.text.length}c] isError=${r.isError}`;
}

async function createGuide(
  client: Client,
  extra: Record<string, unknown>,
): Promise<ToolResult> {
  const r = await tryCall(client, 'create_guide', extra);
  const uuid = extractUuid(r);
  if (uuid) createdUuids.add(uuid);
  return r;
}

async function deleteGuide(client: Client, uuid: string): Promise<ToolResult> {
  const r = await tryCall(client, 'delete_guide', { uuid });
  if (!r.isError) createdUuids.delete(uuid);
  return r;
}

function log(...parts: unknown[]) {
  console.log(...parts);
}

async function main() {
  const token = process.env.MOTHERDUCK_TOKEN;
  const apiUrl = (process.env.MOTHERDUCK_API_URL ?? '').trim().replace(/\/$/, '');
  if (!token) throw new Error('No MOTHERDUCK_TOKEN in env — source the bot .env first.');
  if (!apiUrl) throw new Error('No MOTHERDUCK_API_URL in env.');
  const aclTarget = process.argv[2] ?? process.env.ACL_TARGET_UUID;

  log(`MCP endpoint: ${apiUrl}/mcp`);
  log(`ACL target (probe 4): ${aclTarget ?? '(none — probe 4 will be skipped)'}`);
  log('');

  const client = new Client({ name: 'quackbot-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  try {
    // ---- Probe 1: tools/list diff + guide-tool arg shapes --------------------
    log('=== Probe 1: tools/list diff ===');
    const listed = (await client.listTools()).tools ?? [];
    const liveNames = new Set(listed.map((t) => t.name));
    const missing = EXPECTED_TOOLS.filter((n) => !liveNames.has(n));
    const added = [...liveNames].filter((n) => !EXPECTED_TOOLS.includes(n));
    log(`  live tools: ${liveNames.size}`);
    log(`  missing (expected but absent): ${missing.length ? missing.join(', ') : '(none)'}`);
    log(`  added (present but unexpected): ${added.length ? added.join(', ') : '(none)'}`);
    log('  guide-tool arg shapes:');
    for (const name of GUIDE_TOOLS) {
      const t = listed.find((x) => x.name === name);
      if (!t) { log(`    ${name}: ABSENT`); continue; }
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = schema.properties ? Object.keys(schema.properties) : [];
      const req = schema.required ?? [];
      log(`    ${name}: props=[${props.join(', ')}] required=[${req.join(', ')}]`);
    }
    record('1 tools/list', missing.length === 0 ? 'PASS' : 'FAIL',
      `missing=${missing.length} added=${added.length}`);

    // ---- Probe 2: guide CRUD round-trip -------------------------------------
    log('\n=== Probe 2: guide CRUD round-trip ===');
    const created = await createGuide(client, {
      title: 'smoke-2026-07-23',
      topic: SMOKE_TOPIC,
      content: '# smoke test\ninitial content',
      description: 'phase-0 smoke probe',
    });
    log(`  create_guide -> ${envelope(created)}`);
    log(`    raw: ${created.text.slice(0, 400)}`);
    const uuid = extractUuid(created);
    const j = created.json as Record<string, unknown> | null;
    const createdAccess = j?.access
      ?? (j?.guide as Record<string, unknown> | undefined)?.access;
    log(`    access on create response: ${JSON.stringify(createdAccess)}`);
    if (!uuid) {
      record('2 CRUD', 'FAIL', 'create_guide returned no uuid — cannot continue CRUD');
    } else {
      const listed2 = await tryCall(client, 'list_guides', { topic: SMOKE_TOPIC });
      const found = listed2.text.includes(uuid);
      log(`  list_guides({topic}) -> ${envelope(listed2)}; finds new uuid: ${found}`);
      log(`    raw: ${listed2.text.slice(0, 500)}`);

      const got = await tryCall(client, 'get_guide', { uuid });
      log(`  get_guide(uuid) -> ${envelope(got)}`);
      log(`    raw: ${got.text.slice(0, 500)}`);
      const gj = got.json as Record<string, unknown> | null;
      const metaFields = gj ? Object.keys(gj) : [];
      log(`    get_guide metadata fields: [${metaFields.join(', ')}]`);

      const upd = await tryCall(client, 'update_guide', {
        uuid, content: '# smoke test\nupdated body v2',
      });
      log(`  update_guide -> ${envelope(upd)}`);

      const editc = await tryCall(client, 'edit_guide_content', {
        uuid, edits: [{ old_string: 'updated body v2', new_string: 'edited body v3' }],
      });
      log(`  edit_guide_content -> ${envelope(editc)}`);

      const meta = await tryCall(client, 'update_guide_metadata', {
        uuid, description: 'phase-0 smoke probe (edited)',
      });
      log(`  update_guide_metadata -> ${envelope(meta)}`);

      const del = await deleteGuide(client, uuid);
      log(`  delete_guide -> ${envelope(del)}`);

      const allOk = !created.isError && found && !got.isError && !upd.isError
        && !editc.isError && !meta.isError && !del.isError;
      record('2 CRUD', allOk ? 'PASS' : 'FAIL',
        `access=${JSON.stringify(createdAccess)} listFound=${found} ` +
        `update=${!upd.isError} editContent=${!editc.isError} ` +
        `updateMeta=${!meta.isError} delete=${!del.isError}`);
    }

    // ---- Probe 3: dupe-create check -----------------------------------------
    log('\n=== Probe 3: dupe-create check ===');
    const dupeArgs = { title: 'smoke-dupe', topic: SMOKE_TOPIC, content: 'dupe body' };
    const d1 = await createGuide(client, dupeArgs);
    const d2 = await createGuide(client, dupeArgs);
    const u1 = extractUuid(d1);
    const u2 = extractUuid(d2);
    const forked = !!u1 && !!u2 && u1 !== u2 && !d2.isError;
    log(`  create #1 -> ${envelope(d1)} uuid=${u1}`);
    log(`  create #2 -> ${envelope(d2)} uuid=${u2}`);
    log(`  verdict: ${forked ? 'SILENTLY FORKED (two uuids)' : 'not forked (collision or error)'}`);
    for (const u of [u1, u2]) if (u) await deleteGuide(client, u);
    record('3 dupe-create', 'INFO',
      forked ? 'duplicate title+topic silently forks (no collision safety)'
             : `second create did NOT fork (isError=${d2.isError})`);

    // ---- Probe 4: cross-user write ACL --------------------------------------
    log('\n=== Probe 4: cross-user write ACL ===');
    if (!aclTarget) {
      log('  skipped — no ACL target uuid provided');
      record('4 cross-user write', 'INFO', 'skipped (no target uuid)');
    } else {
      const w1 = await tryCall(client, 'update_guide', {
        uuid: aclTarget, content: 'SMOKE PROBE — should be rejected',
      });
      const w2 = await tryCall(client, 'edit_guide_content', {
        uuid: aclTarget, edits: [{ old_string: 'a', new_string: 'SMOKE-b' }],
      });
      log(`  update_guide(other) -> isError=${w1.isError}: ${w1.text.slice(0, 300)}`);
      log(`  edit_guide_content(other) -> isError=${w2.isError}: ${w2.text.slice(0, 300)}`);
      const breach = !w1.isError || !w2.isError;
      if (breach) {
        log('  *** CRITICAL: a cross-user WRITE SUCCEEDED — do not retry ***');
      }
      record('4 cross-user write', breach ? 'FAIL' : 'PASS',
        breach ? 'CRITICAL: cross-user write succeeded'
               : `both rejected (update:"${w1.text.slice(0, 80)}" edit:"${w2.text.slice(0, 80)}")`);
    }

    // ---- Probe 5: org-visible create ----------------------------------------
    log('\n=== Probe 5: org-visible create ===');
    const org = await createGuide(client, {
      title: 'smoke-org-2026-07-23', topic: SMOKE_TOPIC,
      content: 'org visibility probe', access: 'organization',
    });
    const orgUuid = extractUuid(org);
    log(`  create_guide(access:organization) -> isError=${org.isError}: ${org.text.slice(0, 300)}`);
    if (!org.isError && orgUuid) {
      log('  org create ALLOWED for this PAT — deleting immediately');
      const d = await deleteGuide(client, orgUuid);
      log(`    cleanup delete -> isError=${d.isError}`);
      record('5 org create', 'INFO', 'NOT gated — org-access create succeeded (deleted)');
    } else {
      record('5 org create', 'INFO', `gated/rejected: "${org.text.slice(0, 120)}"`);
    }

    // ---- Probe 6: set_guide_access flip -------------------------------------
    log('\n=== Probe 6: set_guide_access probe ===');
    const g6 = await createGuide(client, {
      title: 'smoke-access-flip', topic: SMOKE_TOPIC, content: 'access flip probe',
    });
    const u6 = extractUuid(g6);
    if (!u6) {
      log(`  could not create probe guide: ${g6.text.slice(0, 200)}`);
      record('6 set_guide_access', 'INFO', 'setup guide create failed');
    } else {
      const flip = await tryCall(client, 'set_guide_access', { uuid: u6, access: 'organization' });
      log(`  set_guide_access->organization -> isError=${flip.isError}: ${flip.text.slice(0, 300)}`);
      if (!flip.isError) {
        log('  access flip ALLOWED — flipping back to user');
        const back = await tryCall(client, 'set_guide_access', { uuid: u6, access: 'user' });
        log(`    flip back -> isError=${back.isError}`);
        record('6 set_guide_access', 'INFO', 'NOT gated — flip to organization succeeded');
      } else {
        record('6 set_guide_access', 'INFO', `gated/rejected: "${flip.text.slice(0, 120)}"`);
      }
      await deleteGuide(client, u6);
    }

    // ---- Probe 7: bot memory inventory --------------------------------------
    // list_guides({topic}) returns only guides AT that exact topic, so a root
    // call misses the bot's memories. The bot's PAT owns guides under its own
    // personal namespace only — after the server migration those appear as the
    // literal topic `users/jm_quackbot/quackbot` (old paths
    // `users/jm_quackbot/quackbot/<slug>.md` collapsed into that topic, slug ->
    // title, `.md` dropped). Drill just the bot-owned topics: root + any topic
    // under `users/jm_quackbot`. (Other `.md`-suffixed topics like `dbt/*.md`
    // are ORG guides owned by someone else — not the bot's memory and out of
    // scope for the Phase-4 re-home.)
    log('\n=== Probe 7: bot memory inventory ===');
    const root = await tryCall(client, 'list_guides', {});
    const rj = root.json as Record<string, unknown> | null;
    const topics = (rj?.topics as Array<Record<string, unknown>> | undefined) ?? [];
    log(`  root: ${topics.length} topics total`);

    const ownNs = (t: string) => /^users\/jm_quackbot(\/|$)/i.test(t);
    const rootGuides = (rj?.guides as Array<Record<string, unknown>> | undefined) ?? [];
    const ownTopics = topics.map((t) => String(t.topic)).filter(ownNs);
    log(`  bot-owned topics: ${ownTopics.join(', ') || '(none)'}`);

    const inventory: Array<Record<string, unknown> & { _topic: string }> = [];
    for (const topic of ownTopics) {
      const r = await tryCall(client, 'list_guides', { topic });
      const gj = r.json as Record<string, unknown> | null;
      const gs = (gj?.guides as Array<Record<string, unknown>> | undefined) ?? [];
      for (const g of gs) inventory.push({ ...g, _topic: topic });
    }
    log(`  root-topic guides (context; may be org-owned): ${rootGuides
      .map((g) => `${g.title}[${g.access}]`).join(', ') || '(none)'}`);
    log('  BOT-OWNED guide inventory (uuid | topic | title | access | old-path-migrated?):');
    for (const g of inventory) {
      // Every bot-owned guide sits under the old users/<bot>/quackbot path, so
      // all of these are migrated old-path memories to re-home in Phase 4.
      log(`    ${g.uuid} | ${g._topic} | ${g.title} | ${g.access} | YES`);
    }
    // Confirm ownership via each guide's get_guide header (owner_name line).
    for (const g of inventory) {
      const got = await tryCall(client, 'get_guide', { uuid: String(g.uuid) });
      const ownedByBot = /jm_quackbot/.test(got.text);
      log(`    owner check ${g.uuid}: ${ownedByBot ? 'jm_quackbot' : '??? NOT bot'}`);
    }
    record('7 inventory', 'INFO',
      `${topics.length} topics total; ${inventory.length} bot-owned guides under ${ownTopics.join('/')}`);

    // ---- Probe 8: get_dive_guide({client:'other'}) --------------------------
    log('\n=== Probe 8: get_dive_guide({client:"other"}) ===');
    const dg = await tryCall(client, 'get_dive_guide', { client: 'other' });
    if (dg.isError) {
      log(`  get_dive_guide error: ${dg.text.slice(0, 300)}`);
      record('8 dive guide', 'FAIL', dg.text.slice(0, 120));
    } else {
      writeFileSync(DIVE_GUIDE_OUT, dg.text);
      const usesSqlHook = /useSQLQuery|@motherduck\/react-sql-query/.test(dg.text);
      const usesRequiredDbs = /REQUIRED_DATABASES/.test(dg.text);
      log(`  saved ${dg.text.length} chars -> ${DIVE_GUIDE_OUT}`);
      log(`  mentions useSQLQuery/react-sql-query: ${usesSqlHook}`);
      log(`  mentions REQUIRED_DATABASES: ${usesRequiredDbs}`);
      record('8 dive guide', 'PASS',
        `saved ${dg.text.length}c; useSQLQuery=${usesSqlHook} REQUIRED_DATABASES=${usesRequiredDbs}`);
    }

    // ---- Cleanup contract ---------------------------------------------------
    log('\n=== Cleanup ===');
    if (createdUuids.size > 0) {
      log(`  ${createdUuids.size} guide(s) still tracked — deleting`);
      for (const u of [...createdUuids]) {
        const d = await deleteGuide(client, u);
        log(`    delete ${u} -> isError=${d.isError}`);
      }
    }
    const leftovers = await tryCall(client, 'list_guides', { topic: SMOKE_TOPIC });
    const lj = leftovers.json as Record<string, unknown> | null;
    const remaining = (lj?.guides as unknown[] | undefined)?.length ?? -1;
    log(`  leftovers under ${SMOKE_TOPIC}: ${remaining} (raw: ${leftovers.text.slice(0, 300)})`);
    const clean = remaining === 0 && createdUuids.size === 0;
    if (!clean) {
      log(`  *** LEAK: ${createdUuids.size} tracked + ${remaining} listed under smoke topic ***`);
    }
    record('cleanup', clean ? 'PASS' : 'FAIL',
      `tracked-remaining=${createdUuids.size} listed-under-smoke=${remaining}`);

  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }

  // ---- Summary --------------------------------------------------------------
  log('\n======== SUMMARY ========');
  for (const s of summary) {
    log(`  [${s.verdict}] ${s.probe} — ${s.note}`);
  }
  const failed = summary.filter((s) => s.verdict === 'FAIL');
  log(`\n${failed.length === 0 ? 'ALL PASS/INFO' : `${failed.length} FAIL`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('smoke-mcp fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
