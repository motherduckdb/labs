import type { WebClient } from '@slack/web-api';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  createMCPClient,
  getFilteredTools,
  mcpToolsToAnthropicFormat,
  configuredDatabaseAllowlist,
} from '../core/mcp-client';
import { buildSystemPrompt } from '../core/system-prompt';
import { fetchQueryGuideBlock } from '../core/query-guide';
import { getModelProfile } from '../core/llm-client';
import { runAgenticLoop, type ThinkingLevel } from '../core/agentic-loop';
import * as controllog from '../core/controllog';
import { getConversation, saveConversation } from '../store/conversations';
import { resolveDatabases, setChannelDatabases } from '../store/settings';
import { markEventSeen } from '../store/events';
import { threadLockKey, withThreadLock } from '../store/locks';
import type { TurnSink } from '../core/turn-sink';
import { redactError } from '../core/redact';
import { SlackTurnSink, type SlackTurnSinkOpts } from './sink';
import {
  makeConfirmRequester,
  registerConfirmationActions,
  type ConfirmRequesterOpts,
  type ConfirmCall,
} from './confirm';

/**
 * Slack event → agentic turn orchestration.
 *
 * `registerHandlers(app)` wires the bolt listeners; the real work lives in the
 * `buildTurnRunner(deps)` seam so the dedupe / mutex / command-intercept logic
 * can be tested with injected fakes and no bolt or Postgres. The flow mirrors
 * data-chat-mini's app/api/chat/route.ts: createMCPClient → getFilteredTools →
 * mcpToolsToAnthropicFormat → buildSystemPrompt → runAgenticLoop, wrapped in a
 * controllog session that is flushed afterward.
 *
 * Dedupe and the per-thread mutex used to be a module-level `Set` and `Map`,
 * which was correct only because Fly ran exactly one process. Modal runs one
 * container per turn, so the two duplicate deliveries of a DM @-mention are
 * usually two *processes*; both now live in Postgres (src/store/events.ts,
 * src/store/locks.ts). Everything else in this file is unchanged.
 */

const DEFAULT_THINKING: ThinkingLevel = 'medium';
const VALID_THINKING = new Set<ThinkingLevel>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const USE_DB_RE = /^use\s+(?:db|database)\s+(.+)$/i;
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)>/g;

function resolveThinkingLevel(): ThinkingLevel {
  const raw = (process.env.QUACKBOT_THINKING_LEVEL || '').trim() as ThinkingLevel;
  return VALID_THINKING.has(raw) ? raw : DEFAULT_THINKING;
}

/** A normalized inbound Slack message, decoupled from the bolt event shapes. */
export interface IncomingMessage {
  channel: string;
  channelType?: string;
  user?: string;
  text: string;
  ts: string;
  /** event.thread_ts — undefined when the message is not itself in a thread. */
  threadTs?: string;
  /** True when the surface is a Slack assistant container. */
  isAssistant?: boolean;
}

type FinalizableSink = TurnSink & { finalize(): Promise<void> };

export interface TurnRunnerDeps {
  client: WebClient;
  createMCPClient: (sessionHint?: string) => Promise<Client>;
  getFilteredTools: typeof getFilteredTools;
  mcpToolsToAnthropicFormat: typeof mcpToolsToAnthropicFormat;
  buildSystemPrompt: typeof buildSystemPrompt;
  fetchQueryGuideBlock: typeof fetchQueryGuideBlock;
  getModelProfile: typeof getModelProfile;
  runAgenticLoop: typeof runAgenticLoop;
  getConversation: typeof getConversation;
  saveConversation: typeof saveConversation;
  resolveDatabases: typeof resolveDatabases;
  setChannelDatabases: typeof setChannelDatabases;
  controllog: Pick<typeof controllog, 'createSession' | 'runInSession' | 'flushSession'>;
  createSink: (opts: SlackTurnSinkOpts) => FinalizableSink;
  makeConfirmRequester: (opts: ConfirmRequesterOpts) => (call: ConfirmCall) => Promise<boolean>;
  /** Postgres-backed event dedupe; true means this container owns the turn. */
  markEventSeen: typeof markEventSeen;
  /** Postgres-backed per-thread mutex. Non-blocking — see the note in handle(). */
  withThreadLock: typeof withThreadLock;
  botUserId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface TurnRunner {
  handle(msg: IncomingMessage): Promise<void>;
}

function defaultDeps(client: WebClient, botUserId?: string): TurnRunnerDeps {
  return {
    client,
    createMCPClient,
    getFilteredTools,
    mcpToolsToAnthropicFormat,
    buildSystemPrompt,
    fetchQueryGuideBlock,
    getModelProfile,
    runAgenticLoop,
    getConversation,
    saveConversation,
    resolveDatabases,
    setChannelDatabases,
    controllog,
    createSink: (opts) => new SlackTurnSink(opts),
    makeConfirmRequester,
    markEventSeen,
    withThreadLock,
    botUserId,
    thinkingLevel: resolveThinkingLevel(),
  };
}

/**
 * The production dependency set, for callers that drive a turn without bolt.
 *
 * `src/worker.ts` is the one caller: it has already resolved the bot user id
 * (a one-shot worker cannot fill it in asynchronously the way `registerHandlers`
 * does) and needs exactly these defaults otherwise. Exported as a named wrapper
 * rather than exporting `defaultDeps` itself so the "pass a client and a bot id,
 * get the real wiring" contract is explicit at the call site.
 */
export function makeWorkerDeps(client: WebClient, botUserId?: string): TurnRunnerDeps {
  return defaultDeps(client, botUserId);
}

/** Strip every `<@BOT>` token from `text`. */
function stripMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Where visible replies + the progress placeholder are posted. Channels thread
 * off the triggering message to stay tidy; a plain DM posts to the main
 * timeline unless the surface is an assistant container or the user was already
 * threading. Mirrors superduck's `_reply_thread_ts`.
 */
function replyThreadTs(
  channel: string,
  threadTs: string,
  opts: { isAssistant: boolean; userThreaded: boolean },
): string | undefined {
  if (channel.startsWith('D') && !opts.isAssistant && !opts.userThreaded) return undefined;
  return threadTs;
}

/** Stable key used for a plain (unthreaded, non-assistant) DM's rolling timeline. */
const DM_ROOT_KEY = 'dm-root';

/**
 * The logical conversation/thread key for a message — used for history storage,
 * the per-thread mutex, and the MCP session hint. A plain DM has a single
 * rolling timeline, so every unthreaded DM message must resolve to ONE stable
 * key (else each message keys by its own ts and turn 2 never sees turn 1). A
 * channel mention threads off the mention; a user-threaded DM or assistant
 * container keeps its real thread_ts.
 */
function conversationKeyFor(msg: IncomingMessage): string {
  if (msg.channel.startsWith('D') && !msg.threadTs && !msg.isAssistant) {
    return DM_ROOT_KEY;
  }
  return msg.threadTs ?? msg.ts;
}

export function buildTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  // users.info cache for mention labeling. Still in memory on purpose: it is a
  // read-through cache of immutable-ish data scoped to a single turn's text, so
  // a per-container copy costs at most one extra users.info call.
  const userNames = new Map<string, string>();
  const thinkingLevel = deps.thinkingLevel ?? DEFAULT_THINKING;

  async function userName(id: string): Promise<string | undefined> {
    if (userNames.has(id)) return userNames.get(id);
    try {
      const res = await deps.client.users.info({ user: id });
      const u = (res as { user?: { real_name?: string; name?: string } }).user;
      const name = u?.real_name || u?.name;
      if (name) {
        userNames.set(id, name);
        return name;
      }
    } catch {
      /* best-effort */
    }
    return undefined;
  }

  async function labelMentions(text: string): Promise<string> {
    const ids = Array.from(new Set(Array.from(text.matchAll(USER_MENTION_RE), (m) => m[1])));
    let out = text;
    for (const id of ids) {
      const name = await userName(id);
      if (name) out = out.replaceAll(`<@${id}>`, `@${name}`);
    }
    return out;
  }

  async function addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await deps.client.reactions.add({ channel, timestamp: ts, name });
    } catch {
      /* best-effort */
    }
  }

  async function removeReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await deps.client.reactions.remove({ channel, timestamp: ts, name });
    } catch {
      /* best-effort */
    }
  }

  async function post(channel: string, threadTs: string | undefined, text: string): Promise<string | undefined> {
    try {
      const res = await deps.client.chat.postMessage({
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text,
      });
      return (res as { ts?: string }).ts;
    } catch (err) {
      console.warn('[quackbot] postMessage failed:', err);
      return undefined;
    }
  }

  async function runTurn(
    msg: IncomingMessage,
    threadTs: string,
    replyTs: string | undefined,
    userText: string,
  ): Promise<void> {
    await addReaction(msg.channel, msg.ts, 'eyes');

    let mcpClient: Client | null = null;
    const session = deps.controllog.createSession(`${msg.channel}:${threadTs}`);
    let ok = false;
    try {
      await deps.controllog.runInSession(session, async () => {
        const stored = await deps.getConversation(msg.channel, threadTs);
        const priorMessages = (stored?.messages ?? []) as Array<{ role: string; content: unknown }>;
        // Prefer the conversation's own database list for continuity; fall back
        // to the channel/env resolution for a fresh thread.
        const databases =
          stored?.databases && stored.databases.length > 0
            ? stored.databases
            : await deps.resolveDatabases(msg.channel);

        const placeholderTs = await post(msg.channel, replyTs, '_:duck: on it…_');
        if (!placeholderTs) {
          throw new Error('Could not post placeholder reply');
        }

        // Create the sink immediately so ANY later failure (MCP connect, tool
        // fetch, or the loop itself throwing) still runs finalize() — otherwise
        // the placeholder is left half-painted with a dangling status line and
        // pending chart uploads are never awaited.
        const sink = deps.createSink({
          client: deps.client,
          channel: msg.channel,
          threadTs: replyTs,
          placeholderTs,
          isAssistant: msg.isAssistant,
        });

        try {
          const sessionHint = `${msg.channel}:${threadTs}`;
          mcpClient = await deps.createMCPClient(sessionHint);
          const mcpTools = await deps.getFilteredTools(mcpClient);
          const tools = deps.mcpToolsToAnthropicFormat(mcpTools);
          const profile = deps.getModelProfile();
          // Eagerly pull the org query guidance once (cached ~15min) and inject
          // it into the system prompt, saving a get_query_guide round-trip per
          // turn. Failure-tolerant: null falls back to the "call it first"
          // prompt mandate rather than breaking the turn.
          const queryGuide = await deps.fetchQueryGuideBlock(mcpClient);
          const systemPrompt = deps.buildSystemPrompt(databases, queryGuide);

          const messages: Array<{ role: string; content: unknown }> = [
            ...priorMessages,
            { role: 'user', content: userText },
          ];
          const turnStartIndex = messages.length - 1;

          const runId = `chat_${Date.now()}`;
          const taskId = `chat:${runId}`;
          // Durable writes pause for an Approve/Deny click from the initiating
          // user, posted into this same thread.
          const confirmTool = deps.makeConfirmRequester({
            client: deps.client,
            channel: msg.channel,
            threadTs: replyTs,
            initiatingUser: msg.user,
          });
          const result = await deps.runAgenticLoop({
            messages,
            turnStartIndex,
            profile,
            thinkingLevel,
            client: mcpClient,
            tools,
            systemPrompt,
            sink,
            taskId,
            runId,
            requestText: userText,
            historyLength: priorMessages.length,
            confirmTool,
          });

          await deps.saveConversation(msg.channel, threadTs, result.finalMessages, databases);
          ok = true;
        } catch (err) {
          // Surface a terminal render in the placeholder (unless the loop
          // already reported an error), then rethrow so the outer handler
          // posts the separate warning message + sets the ⚠️ reaction.
          sink.onError('Something went wrong while answering — see the thread.');
          throw err;
        } finally {
          // Always settle the sink: terminal render + await pending uploads.
          await sink.finalize();
        }
      });
    } catch (err) {
      console.error('[quackbot] turn failed:', redactError(err));
      await post(msg.channel, replyTs, ':warning: Something went wrong handling that — check the logs.');
    } finally {
      if (mcpClient) {
        try {
          await (mcpClient as Client).close();
        } catch {
          /* ignore */
        }
      }
      try {
        await deps.controllog.flushSession(session);
      } catch (err) {
        console.warn('[quackbot] controllog flush failed:', err);
      }
      await removeReaction(msg.channel, msg.ts, 'eyes');
      await addReaction(msg.channel, msg.ts, ok ? 'white_check_mark' : 'warning');
    }
  }

  async function handle(msg: IncomingMessage): Promise<void> {
    // Dedupe key: the Slack MESSAGE timestamp, NOT Slack's `event_id`. A DM
    // @-mention is delivered twice — once as `message.im`, once as
    // `app_mention` — with two *different* event_ids for one human utterance,
    // so deduping on the real event_id would let the double-fire through and
    // the bot would answer itself twice. (channel, ts) is the identity of the
    // utterance. Do not "fix" this to use event_id.
    const dedupeKey = `${msg.channel}:${msg.ts}`;

    // AT-MOST-ONCE, chosen deliberately. The claim is written before any work,
    // so a worker that dies mid-turn leaves the event marked seen and nothing
    // ever retries it: the user sees a half-finished thread and has to ask
    // again. The alternative — claim on completion — would be at-least-once,
    // and a crash after the LLM spend but before the mark would re-run the
    // whole turn, re-billing it and possibly re-executing durable writes that
    // were already approved and committed. Slack itself already retries
    // deliveries, so "mark late" turns one crash into an unbounded retry loop.
    // Given a visible failure is cheaper than a duplicated one, we mark first.
    // Nothing here is a retry system, and none is planned.
    let first = true;
    try {
      first = await deps.markEventSeen(dedupeKey);
    } catch (err) {
      // Fail OPEN. If Postgres is unreachable, dropping the message means total
      // silence; proceeding means the turn will probably fail loudly a moment
      // later (it needs the same database for history) and the user finds out.
      // The duplicate risk this reopens is bounded by the thread lock below,
      // which is also in Postgres — if that is up, a double-delivery loses the
      // race and gets the busy reply rather than a second answer.
      console.warn('[quackbot] dedupe check failed, proceeding:', err);
    }
    if (!first) return;

    const threadTs = conversationKeyFor(msg);
    const replyTs = replyThreadTs(msg.channel, threadTs, {
      isAssistant: msg.isAssistant ?? false,
      userThreaded: Boolean(msg.threadTs),
    });

    const stripped = stripMention(msg.text, deps.botUserId).trim();

    // Command intercept BEFORE any LLM turn (and before the mutex, so a stray
    // command never gets blocked behind a running turn). The command is
    // single-line, and stripMention collapses newlines — so match against the
    // raw first line, or a following prose line would fold into the name list.
    const firstLine = stripMention(msg.text.split('\n')[0], deps.botUserId).trim();
    const cmd = firstLine.match(USE_DB_RE);
    if (cmd) {
      // Slack clients can also append same-line junk to the message text
      // (e.g. an app-attribution "*Sent using* <@…>" suffix) — keep only
      // tokens shaped like database names.
      const dbs = cmd[1]
        .split(/[,\s]+/)
        .map((s) => s.trim().replace(/^`|`$/g, ''))
        .filter((s) => /^[A-Za-z0-9_][\w.$-]*$/.test(s));
      if (dbs.length === 0) {
        await post(msg.channel, replyTs, 'Usage: `use db <name>[, <name>…]`');
        return;
      }
      // If the deployment pins an allowlist (QUACKBOT_DATABASES), reject names
      // outside it here for immediate feedback — the dispatch-time guard in
      // mcp-client would block queries against them anyway.
      const allow = configuredDatabaseAllowlist();
      if (allow.length > 0) {
        const rejected = dbs.filter((d) => !allow.includes(d));
        if (rejected.length > 0) {
          await post(
            msg.channel,
            replyTs,
            `:no_entry: Not available to this bot: ${rejected.map((d) => `\`${d}\``).join(', ')}. ` +
              `Allowed: ${allow.map((d) => `\`${d}\``).join(', ')}.`,
          );
          return;
        }
      }
      try {
        await deps.setChannelDatabases(msg.channel, dbs);
        await post(
          msg.channel,
          replyTs,
          `:white_check_mark: Databases for this channel → ${dbs.map((d) => `\`${d}\``).join(', ')}`,
        );
      } catch (err) {
        console.warn('[quackbot] setChannelDatabases failed:', err);
        await post(msg.channel, replyTs, ':warning: Could not save the database list — check the logs.');
      }
      return;
    }

    if (!stripped) {
      await post(msg.channel, replyTs, 'Hi! Ask me a question about your data, or set the scope with `use db <name>`.');
      return;
    }

    // Per-thread mutex. Everything that touches the thread's stored history —
    // the mention lookup included, since it sits before the turn's first await
    // — runs inside the lock, so two same-thread events cannot interleave their
    // Postgres saves.
    //
    // BEHAVIOUR CHANGE from the in-memory version: `pg_try_advisory_lock` is
    // non-blocking, so a lost race is reported rather than queued. The old Map
    // queued the second turn behind the first; on Modal that would mean a
    // container billing for minutes doing nothing but waiting, and the loser
    // may not even be the same process. Losing fast and telling the human is
    // both cheaper and more honest. One reply, no retry loop.
    //
    // `runTurn` handles its own failures, so the only way this throws is the
    // lock machinery itself — i.e. Postgres is unreachable. Say so rather than
    // letting the rejection escape into bolt's logs where the user never sees it.
    let outcome: { acquired: boolean };
    try {
      outcome = await deps.withThreadLock(threadLockKey(msg.channel, threadTs), async () => {
        const userText = await labelMentions(stripped);
        await runTurn(msg, threadTs, replyTs, userText);
      });
    } catch (err) {
      console.error('[quackbot] could not take the thread lock:', redactError(err));
      await post(msg.channel, replyTs, ':warning: Something went wrong handling that — check the logs.');
      return;
    }

    if (!outcome.acquired) {
      await addReaction(msg.channel, msg.ts, 'hourglass_flowing_sand');
      await post(msg.channel, replyTs, '_still working on your last message — one sec…_');
    }
  }

  return { handle };
}
