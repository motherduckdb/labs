import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  createMCPClient,
  getFilteredTools,
  mcpToolsToAnthropicFormat,
  configuredDatabaseAllowlist,
} from '../core/mcp-client';
import { buildSystemPrompt } from '../core/system-prompt';
import { getModelProfile } from '../core/llm-client';
import { runAgenticLoop, type ThinkingLevel } from '../core/agentic-loop';
import * as controllog from '../core/controllog';
import { getConversation, saveConversation } from '../store/conversations';
import { resolveDatabases, setChannelDatabases } from '../store/settings';
import type { TurnSink } from '../core/turn-sink';
import { SlackTurnSink, type SlackTurnSinkOpts } from './sink';

/**
 * Slack event → agentic turn orchestration.
 *
 * `registerHandlers(app)` wires the bolt listeners; the real work lives in the
 * `buildTurnRunner(deps)` seam so the dedupe / mutex / command-intercept logic
 * can be tested with injected fakes and no bolt or Postgres. The flow mirrors
 * data-chat-mini's app/api/chat/route.ts: createMCPClient → getFilteredTools →
 * mcpToolsToAnthropicFormat → buildSystemPrompt → runAgenticLoop, wrapped in a
 * controllog session that is flushed afterward.
 */

const DEDUPE_TTL_MS = 60_000;
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
  getModelProfile: typeof getModelProfile;
  runAgenticLoop: typeof runAgenticLoop;
  getConversation: typeof getConversation;
  saveConversation: typeof saveConversation;
  resolveDatabases: typeof resolveDatabases;
  setChannelDatabases: typeof setChannelDatabases;
  controllog: Pick<typeof controllog, 'createSession' | 'runInSession' | 'flushSession'>;
  createSink: (opts: SlackTurnSinkOpts) => FinalizableSink;
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
    getModelProfile,
    runAgenticLoop,
    getConversation,
    saveConversation,
    resolveDatabases,
    setChannelDatabases,
    controllog,
    createSink: (opts) => new SlackTurnSink(opts),
    botUserId,
    thinkingLevel: resolveThinkingLevel(),
  };
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
  // Event dedupe: Slack redelivers events on retry, and a DM @-mention can fire
  // both message.im and app_mention. Key on (channel, ts) with a short TTL.
  const seen = new Set<string>();
  // Per-thread mutex: at most one turn in flight per (channel, threadTs).
  const inflight = new Map<string, Promise<void>>();
  // users.info cache for mention labeling.
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
          const systemPrompt = deps.buildSystemPrompt(databases);

          const messages: Array<{ role: string; content: unknown }> = [
            ...priorMessages,
            { role: 'user', content: userText },
          ];
          const turnStartIndex = messages.length - 1;

          const runId = `chat_${Date.now()}`;
          const taskId = `chat:${runId}`;
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
      console.error('[quackbot] turn failed:', err);
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
    const dedupeKey = `${msg.channel}:${msg.ts}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    setTimeout(() => seen.delete(dedupeKey), DEDUPE_TTL_MS).unref?.();

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

    const mutexKey = `${msg.channel}:${threadTs}`;
    if (inflight.has(mutexKey)) {
      await addReaction(msg.channel, msg.ts, 'hourglass_flowing_sand');
      await post(msg.channel, replyTs, '_still working on the previous message…_');
      return;
    }

    // Reserve the thread synchronously — BEFORE the labelMentions await —
    // so two same-thread events racing through can't both pass the check
    // above and run concurrent turns (which would race Postgres saves). The
    // mention lookup and the turn itself run inside the reserved promise.
    const p = (async () => {
      const userText = await labelMentions(stripped);
      await runTurn(msg, threadTs, replyTs, userText);
    })().finally(() => {
      // Only clear our own reservation — never a successor's.
      if (inflight.get(mutexKey) === p) inflight.delete(mutexKey);
    });
    inflight.set(mutexKey, p);
    await p;
  }

  return { handle };
}

/**
 * Wire the bolt app to a turn runner. Thin: normalizes bolt events into
 * `IncomingMessage` and delegates to `buildTurnRunner`.
 */
export function registerHandlers(app: App): void {
  let botUserId: string | undefined;
  // Keep deps mutable so the bot user id can be filled in once auth.test
  // resolves — the runner closure reads `deps.botUserId` on each turn.
  const deps = defaultDeps(app.client, undefined);
  const runner = buildTurnRunner(deps);

  void app.client.auth
    .test()
    .then((res) => {
      botUserId = (res as { user_id?: string }).user_id;
      deps.botUserId = botUserId;
    })
    .catch((err) => console.warn('[quackbot] auth.test failed:', err));

  // Assistant containers: remember which channels are assistant threads so the
  // sink can use native status affordances.
  const assistantChannels = new Set<string>();

  app.event('app_mention', async ({ event }) => {
    const e = event as {
      channel: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
    };
    await runner.handle({
      channel: e.channel,
      user: e.user,
      text: e.text ?? '',
      ts: e.ts,
      threadTs: e.thread_ts,
      channelType: e.channel_type,
      isAssistant: assistantChannels.has(e.channel),
    });
  });

  app.message(async ({ message }) => {
    const m = message as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      channel_type?: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
    };
    // Ignore edits/deletes/joins/etc, bot messages, and non-DM channels
    // (channel messages arrive via app_mention).
    if (m.subtype) return;
    if (m.bot_id) return;
    if (m.user && m.user === botUserId) return;
    if (m.channel_type !== 'im') return;
    await runner.handle({
      channel: m.channel,
      user: m.user,
      text: m.text ?? '',
      ts: m.ts,
      threadTs: m.thread_ts,
      channelType: m.channel_type,
      isAssistant: assistantChannels.has(m.channel),
    });
  });

  app.event('assistant_thread_started', async ({ event }) => {
    const t = (event as { assistant_thread?: { channel_id?: string } }).assistant_thread;
    if (t?.channel_id) assistantChannels.add(t.channel_id);
  });

  app.event('assistant_thread_context_changed', async () => {
    /* ack only — bolt auto-acknowledges */
  });
}
