import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { uuid7 } from '../core/uuid7';
import { redactError } from '../core/redact';
import { getPool } from '../store/pg';
import type { GuideWriteTarget } from '../core/agentic-loop';

/**
 * Slack confirmation handshake for durable writes.
 *
 * `requiresConfirmation` (mcp-client.ts) marks the allowlisted mutating tools
 * (`create_guide` / `update_guide` / `save_dive`). Before the agentic loop runs
 * one, it calls the `confirmTool` this module builds: a Block Kit message with
 * Approve / Deny buttons is posted into the thread, and the loop awaits the
 * click. This is what closes the prompt-injection "durable-memory poisoning"
 * gap — an injected instruction can propose a write, but it can't commit one
 * without the initiating human clicking Approve.
 *
 * ## Why this is a database handshake now
 *
 * On Fly the same always-on process posted the buttons AND received the click,
 * so a `Map<confirmId, {resolve}>` was a correct rendezvous. On Modal the two
 * halves live in different containers: the worker that posts the buttons exits
 * when its turn ends, and the click arrives at the Python `web` endpoint. The
 * only thing both can see is Postgres, so the rendezvous moves into a row:
 *
 *   1. worker INSERTs a `confirmations` row as 'pending'  ← before posting
 *   2. worker posts the Block Kit message
 *   3. worker polls the row every second, up to the 120s timeout
 *   4. the click hits /slack/interactive; the edge UPDATEs status + decided_by
 *   5. the worker's next poll sees the decision and returns it to the loop
 *   6. timeout still fails CLOSED (a denial), exactly as on Fly
 *
 * Insert-before-post is deliberate in both directions: if `postMessage` fails
 * there is no orphaned waiter (we return false immediately), and if the user
 * somehow clicks before our next statement runs, the row the edge updates
 * already exists. The reverse order has a real, if narrow, lost-update window.
 *
 * ## Why polling and not LISTEN/NOTIFY
 *
 * `LISTEN` requires a dedicated connection held open for the whole wait, and
 * node-postgres surfaces notifications only on a checked-out client. That is
 * exactly the resource an ephemeral worker should not be pinning: it would hold
 * one of the pool's two connections idle for up to two minutes per confirmation
 * while the rest of the turn still needs to query. Polling costs at most 120
 * primary-key lookups — microseconds of server time each — and needs no
 * connection state at all, which also means a dropped connection mid-wait
 * self-heals on the next poll instead of silently never delivering the wakeup.
 *
 * ## Contract the Python edge (/slack/interactive) must honour
 *
 * Table `confirmations` (migrations/002_modal.sql). The edge touches exactly
 * three columns and reads one payload field:
 *
 *   confirm_id  text   — the button's `value`; a uuid7 minted by the worker
 *   status      text   — 'pending' | 'approved' | 'denied'  (CHECK-constrained)
 *   decided_by  text   — the Slack user id that clicked, e.g. 'U123'. NULL on a
 *                        row the worker expired itself: `status='denied'` with
 *                        `decided_by IS NULL` means "timed out", not "a human
 *                        denied it". Nothing depends on that distinction today
 *                        beyond audit, but do not overwrite it with a sentinel.
 *   decided_at  timestamptz — now() at decision time
 *   payload->>'initiating_user' — the Slack user id allowed to decide, or NULL
 *                        to allow anyone. READ ONLY from the edge.
 *
 * The write is one conditional statement, and the conditions are load-bearing:
 *
 *   update confirmations
 *      set status = %(status)s, decided_by = %(user)s, decided_at = now()
 *    where confirm_id = %(id)s
 *      and status = 'pending'
 *      and coalesce(payload->>'initiating_user', %(user)s) = %(user)s
 *
 * `status = 'pending'` makes the first click win and a double-click a no-op.
 * The `coalesce(...)` clause is the authorization check — only the user who
 * triggered the turn may approve their own write; without it any bystander
 * could approve a durable write proposed by someone else's prompt. A rowcount
 * of 0 means "already decided, expired, or wrong user": SELECT the row to tell
 * those apart (see `pgConfirmStore.decide`, which is the reference
 * implementation of exactly this) and post an ephemeral to the clicker.
 *
 * The edge must NOT `chat.update` the confirmation message. The worker owns
 * that message's lifecycle and rewrites it (removing the buttons) when its poll
 * observes the decision or when it times out — one writer, no interleaving. The
 * cost is that the buttons linger for up to a second after the click; a stale
 * click in that window is harmless because `status = 'pending'` rejects it.
 */

const APPROVE_ACTION = 'quackbot_confirm_approve';
const DENY_ACTION = 'quackbot_confirm_deny';
const CONFIRM_TIMEOUT_MS = 120_000;
/** Poll cadence for the decision row. 120 PK lookups per confirmation, worst case. */
const POLL_INTERVAL_MS = 1_000;
const PREVIEW_MAX = 280;

export interface ConfirmCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * For uuid-selected guide writes (`update_guide`/`edit_guide_content`), the
   * target guide resolved before this prompt (see the agentic loop's
   * pre-confirmation resolve). Lets the prompt name the guide being overwritten
   * instead of an opaque uuid. Absent for create_guide (its title/topic are in
   * `args`) and non-guide writes.
   */
  target?: GuideWriteTarget;
}

export type ConfirmStatus = 'pending' | 'approved' | 'denied';

/** The decision-relevant projection of a `confirmations` row. */
export interface ConfirmationRow {
  status: ConfirmStatus;
  decidedBy?: string;
}

/**
 * Outcome of an attempted decision write. The three failure shapes are
 * distinguished because each needs a different thing said to the clicker.
 */
export type DecisionResult =
  | { outcome: 'recorded' }
  | { outcome: 'not-initiator'; initiatingUser: string }
  | { outcome: 'already-decided'; status: ConfirmStatus }
  | { outcome: 'missing' };

/**
 * The `confirmations` persistence seam. Real callers get `pgConfirmStore`;
 * tests inject a fake so the suite never needs a database.
 */
export interface ConfirmStore {
  create(row: {
    confirmId: string;
    channel: string;
    threadTs?: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  read(confirmId: string): Promise<ConfirmationRow | null>;
  decide(confirmId: string, approved: boolean, decidedBy: string): Promise<DecisionResult>;
  /** Mark an un-clicked confirmation denied once the worker stops waiting. */
  expire(confirmId: string): Promise<void>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Narrow a raw `status` column value; anything unexpected reads as pending. */
function asStatus(v: unknown): ConfirmStatus {
  return v === 'approved' || v === 'denied' ? v : 'pending';
}

export const pgConfirmStore: ConfirmStore = {
  async create({ confirmId, channel, threadTs, payload }) {
    await getPool().query(
      `insert into confirmations (confirm_id, channel, thread_ts, status, payload)
       values ($1, $2, $3, 'pending', $4)`,
      // thread_ts is NOT NULL but a plain (unthreaded) DM genuinely has no
      // thread — the empty string records that honestly and keeps the
      // (channel, thread_ts) audit index usable.
      [confirmId, channel, threadTs ?? '', JSON.stringify(payload)],
    );
  },

  async read(confirmId) {
    const res = await getPool().query<{ status: string; decided_by: string | null }>(
      'select status, decided_by from confirmations where confirm_id = $1',
      [confirmId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { status: asStatus(row.status), decidedBy: str(row.decided_by) };
  },

  /**
   * Reference implementation of the contract documented at the top of this
   * file — the Python edge performs the same UPDATE. Keep the two in step.
   */
  async decide(confirmId, approved, decidedBy) {
    const pool = getPool();
    const res = await pool.query(
      `update confirmations
          set status = $2, decided_by = $3, decided_at = now()
        where confirm_id = $1
          and status = 'pending'
          and coalesce(payload->>'initiating_user', $3) = $3`,
      [confirmId, approved ? 'approved' : 'denied', decidedBy],
    );
    if (res.rowCount === 1) return { outcome: 'recorded' };

    // Zero rows: the WHERE clause has three ways to fail and the clicker
    // deserves to know which. One extra read, only on the unhappy path.
    const after = await pool.query<{ status: string; initiating_user: string | null }>(
      `select status, payload->>'initiating_user' as initiating_user
         from confirmations where confirm_id = $1`,
      [confirmId],
    );
    const row = after.rows[0];
    if (!row) return { outcome: 'missing' };
    const initiatingUser = str(row.initiating_user);
    if (row.status === 'pending' && initiatingUser && initiatingUser !== decidedBy) {
      return { outcome: 'not-initiator', initiatingUser };
    }
    return { outcome: 'already-decided', status: asStatus(row.status) };
  },

  async expire(confirmId) {
    // decided_by stays NULL — that is the "the worker gave up" marker. Still
    // conditional on 'pending' so a decision that landed in the same instant
    // as the timeout is not overwritten.
    await getPool().query(
      `update confirmations
          set status = 'denied', decided_at = now()
        where confirm_id = $1 and status = 'pending'`,
      [confirmId],
    );
  },
};

const EDIT_SNIPPET_MAX = 80;

/** `*Title* `topic` (`uuid`)` for a resolved guide target — whichever parts exist. */
function describeTarget(target?: GuideWriteTarget): string {
  if (!target) return '';
  const parts: string[] = [];
  const title = str(target.title);
  const topic = str(target.topic);
  const uuid = str(target.uuid);
  if (title) parts.push(`*${title}*`);
  if (topic) parts.push(`\`${topic}\``);
  if (uuid) parts.push(`(\`${uuid}\`)`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Summarize an `edit_guide_content` change: edit count + first old_string snippet. */
function describeEdits(edits: unknown): string {
  if (!Array.isArray(edits) || edits.length === 0) return '';
  const n = edits.length;
  const first = edits[0] as { old_string?: unknown } | null;
  const snippet = typeof first?.old_string === 'string' ? first.old_string : '';
  const oneLine = snippet.replace(/\s+/g, ' ').trim();
  const clipped = oneLine.length > EDIT_SNIPPET_MAX ? `${oneLine.slice(0, EDIT_SNIPPET_MAX)}…` : oneLine;
  const count = `${n} edit${n === 1 ? '' : 's'}`;
  return clipped ? ` — ${count}, first replaces \`${clipped}\`` : ` — ${count}`;
}

/** Human-readable summary of what the write will do. */
export function describeWrite(call: ConfirmCall): string {
  switch (call.name) {
    case 'create_guide': {
      const title = str(call.args?.title);
      const topic = str(call.args?.topic);
      return (
        `save a new guide${title ? ` *${title}*` : ''}` +
        `${topic ? ` under \`${topic}\`` : ''}`
      );
    }
    case 'update_guide':
      return `overwrite the guide${describeTarget(call.target)}`;
    case 'edit_guide_content':
      return `edit the guide${describeTarget(call.target)}${describeEdits(call.args?.edits)}`;
    case 'save_dive':
      return `save a new Dive${str(call.args?.title) ? ` — *${str(call.args?.title)}*` : ''}`;
    default:
      return `run \`${call.name}\``;
  }
}

function previewContent(call: ConfirmCall): string | undefined {
  const body = str(call.args?.content) ?? str(call.args?.source) ?? str(call.args?.tsx);
  if (!body) return undefined;
  const clipped = body.length > PREVIEW_MAX ? `${body.slice(0, PREVIEW_MAX)}…` : body;
  return '```\n' + clipped + '\n```';
}

function buildBlocks(id: string, call: ConfirmCall, initiatingUser?: string): unknown[] {
  const who = initiatingUser ? ` for <@${initiatingUser}>` : '';
  const preview = previewContent(call);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:lock: I'd like to *${describeWrite(call)}*${who}. This writes durable data that future conversations will read — approve?`,
      },
    },
    ...(preview ? [{ type: 'section', text: { type: 'mrkdwn', text: preview } }] : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: APPROVE_ACTION,
          value: id,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: DENY_ACTION,
          value: id,
        },
      ],
    },
  ];
}

/**
 * Rewrite the prompt message to its terminal text. Passing `blocks` with a
 * single section is what REMOVES the Approve/Deny buttons — leaving them
 * rendered after a decision invites a click that can no longer do anything,
 * which reads to the user as the bot being broken.
 */
async function updateMessage(
  client: WebClient,
  channel: string,
  ts: string | undefined,
  text: string,
): Promise<void> {
  if (!ts) return;
  try {
    await client.chat.update({ channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  } catch {
    /* best-effort — the decision is already durable in the confirmations row */
  }
}

/**
 * Sleep between polls. Deliberately NOT `unref`'d, unlike the timer the
 * in-memory version used: in a per-turn worker an unref'd timer is the only
 * thing on the event loop during a confirmation wait, and Node would exit the
 * process mid-turn rather than wait for the click.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ConfirmRequesterOpts {
  client: WebClient;
  channel: string;
  threadTs?: string;
  initiatingUser?: string;
  /** Persistence seam; defaults to Postgres. Injected by tests. */
  store?: ConfirmStore;
  /** Overrides for the wait, for tests. Production uses the constants above. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Build the `confirmTool` the agentic loop calls. Returns true if the initiating
 * user approves, false on deny/timeout/post-failure/database-failure
 * (fail-closed in every direction — a durable write only happens on a decision
 * we positively observed).
 */
export function makeConfirmRequester(opts: ConfirmRequesterOpts): (call: ConfirmCall) => Promise<boolean> {
  const store = opts.store ?? pgConfirmStore;
  const timeoutMs = opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  return async (call) => {
    const id = uuid7();

    // Insert first: see the header note on ordering. A failure here means we
    // have no rendezvous point at all, so there is nothing to wait for.
    try {
      await store.create({
        confirmId: id,
        channel: opts.channel,
        threadTs: opts.threadTs,
        payload: {
          // Read by the edge to authorize the click. Everything else is audit.
          initiating_user: opts.initiatingUser ?? null,
          tool: call.name,
          summary: describeWrite(call),
          // The rendered preview, not `call.args` — a guide write's `content`
          // can be tens of kilobytes and this row exists to explain a decision,
          // not to archive the payload.
          preview: previewContent(call) ?? null,
          target: call.target ?? null,
        },
      });
    } catch (err) {
      console.warn('[quackbot] could not record confirmation:', redactError(err));
      return false;
    }

    let messageTs: string | undefined;
    try {
      const res = await opts.client.chat.postMessage({
        channel: opts.channel,
        thread_ts: opts.threadTs,
        text: `Confirm: ${describeWrite(call).replace(/[*`]/g, '')}`,
        blocks: buildBlocks(id, call, opts.initiatingUser) as never,
      });
      messageTs = str((res as { ts?: string }).ts);
    } catch (err) {
      console.warn('[quackbot] confirmation prompt failed to post:', redactError(err));
      // Close the row we just opened so a later sweep doesn't see a 'pending'
      // confirmation nobody was ever asked about.
      await store.expire(id).catch(() => {});
      return false;
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let row: ConfirmationRow | null = null;
      let readFailed = false;
      try {
        row = await store.read(id);
      } catch (err) {
        // A transient read failure is not a decision. Keep polling; if it never
        // recovers the timeout below fails us closed, which is the right end
        // state for "we could not confirm anything".
        readFailed = true;
        console.warn('[quackbot] confirmation poll failed:', redactError(err));
      }

      if (!readFailed && !row) {
        // We inserted this row ourselves, so its absence means something else
        // deleted it. Waiting out the full timeout would be pointless.
        console.warn('[quackbot] confirmation row vanished before a decision');
        await updateMessage(
          opts.client,
          opts.channel,
          messageTs,
          `:warning: Confirmation state was lost — \`${call.name}\` was not run.`,
        );
        return false;
      }

      if (row && row.status !== 'pending') {
        const approved = row.status === 'approved';
        const by = row.decidedBy ? ` by <@${row.decidedBy}>` : '';
        await updateMessage(
          opts.client,
          opts.channel,
          messageTs,
          approved ? `:white_check_mark: Approved${by}.` : `:x: Declined${by}.`,
        );
        return approved;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }

    // Fail closed. Expire the row first so a click arriving after we stop
    // listening cannot record an approval for a write that will never run.
    await store.expire(id).catch((err) => {
      console.warn('[quackbot] could not expire confirmation:', redactError(err));
    });
    await updateMessage(
      opts.client,
      opts.channel,
      messageTs,
      `:hourglass: Confirmation timed out — \`${call.name}\` was not run.`,
    );
    return false;
  };
}

/**
 * Register the Approve/Deny button handlers on a bolt app.
 *
 * On Modal this path is dead — the click reaches the Python edge, which runs
 * the UPDATE documented at the top of this file. It is kept because bolt is
 * still how this fork receives events until `src/worker.ts` lands (step 4), and
 * because it is the executable statement of the contract: if the TypeScript and
 * the Python ever disagree, this is the side with tests.
 *
 * Note what it no longer does: it does not resolve a promise (there isn't one
 * in this process any more) and it does not touch the Slack message. It records
 * the decision and acks; the waiting worker renders the outcome.
 */
export function registerConfirmationActions(app: App, store: ConfirmStore = pgConfirmStore): void {
  const makeHandler = (approved: boolean) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ ack, body, action, client }: any): Promise<void> => {
      await ack();
      const id = str(action?.value);
      const clicker = str(body?.user?.id);
      if (!id || !clicker) return;

      let result: DecisionResult;
      try {
        result = await store.decide(id, approved, clicker);
      } catch (err) {
        console.warn('[quackbot] could not record confirmation decision:', redactError(err));
        return;
      }

      if (result.outcome === 'not-initiator') {
        try {
          await client.chat.postEphemeral({
            channel: str(body?.channel?.id) ?? '',
            user: clicker,
            text: `Only <@${result.initiatingUser}> can approve this action.`,
          });
        } catch {
          /* ignore */
        }
      }
      // 'recorded'   → the polling worker rewrites the message within ~1s.
      // 'already-decided' / 'missing' → a stale click; silently ignored.
    };

  app.action(APPROVE_ACTION, makeHandler(true));
  app.action(DENY_ACTION, makeHandler(false));
}
