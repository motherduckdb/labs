import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { uuid7 } from '../core/uuid7';
import { redactError } from '../core/redact';
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
 * Requires interactivity to be enabled on the Slack app (Socket Mode delivers
 * the button events over the same websocket — no public URL). If it is NOT
 * enabled, the click never arrives and the request times out → treated as a
 * denial (fail-closed): writes simply won't happen until interactivity is on.
 */

const APPROVE_ACTION = 'quackbot_confirm_approve';
const DENY_ACTION = 'quackbot_confirm_deny';
const CONFIRM_TIMEOUT_MS = 120_000;
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

interface Pending {
  resolve: (approved: boolean) => void;
  initiatingUser?: string;
  channel: string;
  messageTs?: string;
  timer: ReturnType<typeof setTimeout>;
}

// Keyed by a fresh confirmation id (the button `value`). Module-level so the
// once-registered action handler and the per-turn requester share it. In-memory
// only — a restart drops pending confirmations, which is fine: the turn holding
// them dies on restart too.
const pending = new Map<string, Pending>();

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

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
    /* best-effort — the decision is already recorded in the pending resolve */
  }
}

export interface ConfirmRequesterOpts {
  client: WebClient;
  channel: string;
  threadTs?: string;
  initiatingUser?: string;
}

/**
 * Build the `confirmTool` the agentic loop calls. Returns true if the initiating
 * user approves, false on deny/timeout/post-failure (fail-closed).
 */
export function makeConfirmRequester(opts: ConfirmRequesterOpts): (call: ConfirmCall) => Promise<boolean> {
  return async (call) => {
    const id = uuid7();
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
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        void updateMessage(
          opts.client,
          opts.channel,
          messageTs,
          `:hourglass: Confirmation timed out — \`${call.name}\` was not run.`,
        );
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, {
        resolve,
        initiatingUser: opts.initiatingUser,
        channel: opts.channel,
        messageTs,
        timer,
      });
    });
  };
}

/**
 * Register the Approve/Deny button handlers on the bolt app. Call once at
 * startup. Only the user who initiated the turn may resolve the confirmation.
 */
export function registerConfirmationActions(app: App): void {
  const makeHandler = (approved: boolean) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ ack, body, action, client }: any): Promise<void> => {
      await ack();
      const id = str(action?.value);
      if (!id) return;
      const p = pending.get(id);
      if (!p) return; // stale / already resolved / expired

      const clicker = str(body?.user?.id);
      if (p.initiatingUser && clicker && clicker !== p.initiatingUser) {
        try {
          await client.chat.postEphemeral({
            channel: p.channel,
            user: clicker,
            text: `Only <@${p.initiatingUser}> can approve this action.`,
          });
        } catch {
          /* ignore */
        }
        return; // leave pending unresolved for the right user
      }

      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(approved);
      await updateMessage(
        client,
        p.channel,
        p.messageTs,
        approved
          ? `:white_check_mark: Approved${clicker ? ` by <@${clicker}>` : ''}.`
          : `:x: Declined${clicker ? ` by <@${clicker}>` : ''}.`,
      );
    };

  app.action(APPROVE_ACTION, makeHandler(true));
  app.action(DENY_ACTION, makeHandler(false));
}

/** Test-only: resolve a pending confirmation as if a button were clicked. */
export function __resolvePendingForTest(id: string, approved: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(approved);
  return true;
}

/** Test-only: number of outstanding confirmations. */
export function __pendingCount(): number {
  return pending.size;
}
