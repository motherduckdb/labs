import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebClient } from '@slack/web-api';

import {
  buildTurnRunner,
  makeWorkerDeps,
  type IncomingMessage,
  type TurnRunner,
} from './slack/handlers';
import { closeBrowser } from './slack/screenshot';
import { closePool } from './store/pg';
import { kvGet, kvSet } from './store/kv';
import * as cl from './core/controllog';
import { redactError } from './core/redact';

/**
 * Per-turn entrypoint. One Slack event in on stdin, one turn run, then exit.
 *
 * `modal_app.py::run_turn` invokes this as `npx tsx src/worker.ts` with the
 * entire Slack event envelope piped to stdin. That is the whole interface:
 * stdin is the request, the exit code is the status, stdout/stderr are the
 * logs Modal collects.
 *
 * This replaces the Socket Mode process (`main.ts` + `slack/app.ts`), which
 * could not survive the move — Modal caps a function at 24 hours, so an
 * always-on outbound websocket has no supported shape here. The trade is that
 * everything bolt used to hold in module scope between events (the bot user
 * id, which channels are assistant containers, dedupe, the thread mutex) had
 * to become state that a process living for one turn can still see. Dedupe and
 * the mutex moved into `handlers.ts` on Postgres; the two lookups this file
 * owns are below, both in `kv_cache`.
 *
 * The normalization here deliberately mirrors `registerHandlers` in
 * handlers.ts rather than sharing code with it. Bolt hands its listeners a
 * decoded event and we get the raw envelope, so the two arrive at
 * `IncomingMessage` from different shapes; keeping them as two readable
 * functions beats one parameterized over the difference. handlers.ts stays the
 * reference for WHICH events are eligible — if you change a filter there,
 * change it here.
 */

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Note what is NOT here. `SLACK_APP_TOKEN` was Socket Mode's outbound-websocket
 * credential and no longer exists; `SLACK_SIGNING_SECRET` replaced it but is
 * verified by the Python edge, not by this process, so the worker does not need
 * it — and listing a variable this code never dereferences would only teach
 * whoever hits the error to distrust the list. `OPENROUTER_API_KEY` is gone with
 * the provider swap.
 *
 * `MODAL_INFERENCE_BASE_URL` IS here, because `llm-client.ts` deliberately has
 * no default for it (PLAN.md §7.1) and would otherwise throw halfway through a
 * turn — after the placeholder is posted and the eyes reaction is on. Failing
 * before any of that names the missing variable instead.
 *
 * The inference *credentials* are absent on purpose: `llm-client.ts` supports
 * two auth schemes pending confirmation of which one Modal's Shared API wants
 * (`Modal-Key`/`Modal-Secret` or a bearer key), so "exactly one of these sets is
 * present" is not a check this list can express — it fails at the first call
 * instead. Collapse it in here once §7.1 resolves.
 */
const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'MOTHERDUCK_TOKEN',
  'DATABASE_URL',
  'MODAL_INFERENCE_BASE_URL',
] as const;

/** Which of `REQUIRED_ENV` is absent. Takes the environment so tests need not mutate the real one. */
export function missingEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

function assertEnv(): void {
  const missing = missingEnv();
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'On Modal these come from the `quackbot-modal` secret; locally, from .env.',
    );
  }
}

// ---------------------------------------------------------------------------
// Envelope → IncomingMessage
// ---------------------------------------------------------------------------

/** The subset of Slack's `event_callback` envelope the worker reads. */
export interface SlackEnvelope {
  type?: string;
  event?: SlackEvent;
}

export interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  assistant_thread?: { channel_id?: string };
}

/**
 * Decide whether an event is a turn, and shape it if so.
 *
 * Returns null for anything that is not a user utterance addressed to us. Every
 * filter below exists because dropping it produces a specific misbehaviour, not
 * merely wasted work:
 *
 *   subtype    — message_changed / message_deleted / channel_join and friends.
 *                A `message_changed` carries the ORIGINAL text, so answering it
 *                makes the bot re-answer an edited message as if it were new.
 *   bot_id     — any bot's message, including our own. Without this the bot
 *                replies to itself in a DM and loops.
 *   user === botUserId — our own message when posted as the user rather than
 *                carrying a bot_id. Same loop, different envelope.
 *   channel_type !== 'im' — channel messages arrive as `app_mention`; without
 *                this a bot in a busy channel answers every message in it.
 *
 * `app_mention` skips the DM filter (that IS the addressed-to-us signal) but
 * still needs the bot_id guard, because a bot that mentions us would otherwise
 * start a conversation between two bots.
 */
export function toIncomingMessage(
  event: SlackEvent,
  opts: { botUserId?: string; isAssistant?: boolean },
): IncomingMessage | null {
  if (!event.channel || !event.ts) return null;

  const base = {
    channel: event.channel,
    user: event.user,
    text: event.text ?? '',
    ts: event.ts,
    threadTs: event.thread_ts,
    channelType: event.channel_type,
    isAssistant: opts.isAssistant,
  };

  if (event.type === 'app_mention') {
    if (event.bot_id) return null;
    if (event.user && event.user === opts.botUserId) return null;
    return base;
  }

  if (event.type === 'message') {
    if (event.subtype) return null;
    if (event.bot_id) return null;
    if (event.user && event.user === opts.botUserId) return null;
    if (event.channel_type !== 'im') return null;
    return base;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cross-turn lookups that bolt used to hold in module scope
// ---------------------------------------------------------------------------

const BOT_USER_ID_KEY = 'slack:bot_user_id';
/**
 * A bot user id is fixed for the lifetime of an installation — it only changes
 * if the app is uninstalled and reinstalled. A day is therefore not a staleness
 * bound so much as a cheap self-heal: if the app IS reinstalled, the cache
 * corrects itself within 24h instead of needing a manual flush.
 */
const BOT_USER_ID_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The bot's own user id, for mention-stripping and self-message filtering.
 *
 * `registerHandlers` resolved this from `auth.test()` in the background and let
 * the first turns run with it undefined. A one-shot worker cannot do that — the
 * turn IS the first turn — so we must have it before handling anything, and
 * paying an `auth.test()` round trip on every single turn to learn a value that
 * never changes is worth avoiding. Hence the cache.
 *
 * A cache read failure is not fatal: we fall through to `auth.test()`, and a
 * failure THERE returns undefined rather than throwing. Undefined degrades
 * gracefully — an un-stripped `<@U123>` prefix reaches the model, which is
 * cosmetic. Refusing to answer would not be.
 */
export async function resolveBotUserId(client: WebClient): Promise<string | undefined> {
  try {
    const cached = await kvGet<string>(BOT_USER_ID_KEY);
    if (cached) return cached;
  } catch (err) {
    console.warn('[quackbot] bot-user-id cache read failed:', redactError(err));
  }

  try {
    const res = await client.auth.test();
    const id = (res as { user_id?: string }).user_id;
    if (id) {
      await kvSet(BOT_USER_ID_KEY, id, BOT_USER_ID_TTL_MS).catch((err) => {
        console.warn('[quackbot] bot-user-id cache write failed:', redactError(err));
      });
    }
    return id;
  } catch (err) {
    console.warn('[quackbot] auth.test failed:', redactError(err));
    return undefined;
  }
}

/**
 * Assistant-container channels.
 *
 * Bolt tracked these in a module-level `Set` populated by
 * `assistant_thread_started`, which a per-turn container cannot keep. The event
 * still arrives — as its own worker invocation — so the Set becomes a row: that
 * invocation writes the flag, and later message turns in the same channel read
 * it. The flag only selects native assistant status affordances in the sink, so
 * the failure mode if it is missing is a slightly plainer thread, not a broken
 * one.
 *
 * The 30-day TTL is a garbage-collection bound, not a correctness one. An
 * assistant thread that goes quiet for a month and then resumes renders as an
 * ordinary thread; that is an acceptable trade against keeping a row per
 * assistant channel forever.
 */
const ASSISTANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function assistantKey(channel: string): string {
  return `slack:assistant:${channel}`;
}

export async function isAssistantChannel(channel: string): Promise<boolean> {
  try {
    return (await kvGet<boolean>(assistantKey(channel))) === true;
  } catch (err) {
    console.warn('[quackbot] assistant-channel lookup failed:', redactError(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Where a last-ditch failure notice goes.
 *
 * Mirrors handlers.ts's `replyThreadTs`, which is module-private there. The one
 * input it takes that we may not have — `isAssistant` — cannot change the
 * answer here, because an assistant container's messages always carry a
 * `thread_ts` and so take the same branch either way. Spelled out rather than
 * defaulted to `threadTs ?? ts`, because that default would open a thread under
 * a plain DM whose conversation lives on the main timeline: the user would
 * never see the notice, which is the exact failure this function exists to
 * prevent.
 */
export function errorNoticeThreadTs(msg: IncomingMessage): string | undefined {
  if (msg.channel.startsWith('D') && !msg.threadTs) return undefined;
  return msg.threadTs ?? msg.ts;
}

/**
 * Best-effort "something broke" notice.
 *
 * A worker that dies silently is the worst outcome available: the user sees
 * their message acknowledged by nothing at all and has no way to tell whether
 * the bot is thinking or dead. Dedupe has already claimed the event by this
 * point (see the at-most-once note in handlers.ts), so nothing will retry it —
 * saying so is the only recovery the user gets.
 *
 * The text is generic and the detail goes to the logs. `redactError` returns a
 * *stack trace* for an Error, and posting one into a Slack channel is both
 * unreadable and a small disclosure of internals; handlers.ts says the same
 * sentence for the same reason, so the two failure paths look identical to a
 * user who cannot tell which one they hit.
 */
async function reportFailure(
  client: WebClient,
  channel: string | undefined,
  threadTs: string | undefined,
): Promise<void> {
  if (!channel) return;
  try {
    await client.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: ':warning: Something went wrong handling that — check the logs.',
    });
  } catch (postErr) {
    console.error('[quackbot] could not report failure to Slack:', redactError(postErr));
  }
}

async function main(): Promise<void> {
  assertEnv();
  // logDir is vestigial — controllog writes to Postgres now.
  cl.init('quackbot');

  const raw = await readStdin();
  if (!raw.trim()) throw new Error('worker received empty stdin; expected a Slack event envelope');

  const envelope = JSON.parse(raw) as SlackEnvelope;
  const event = envelope.event;
  if (!event) {
    // Not an error: the edge forwards whatever Slack posts, and some of it
    // (url_verification is handled upstream, but app_uninstalled and friends
    // are not) simply isn't a turn.
    console.log(`[quackbot] no event in envelope (type=${envelope.type}); nothing to do`);
    return;
  }

  const client = new WebClient(process.env.SLACK_BOT_TOKEN);

  // Assistant lifecycle events are bookkeeping, not turns. Handle and exit
  // before paying for anything else — notably before resolving the bot user id.
  if (event.type === 'assistant_thread_started') {
    const channel = event.assistant_thread?.channel_id;
    if (channel) await kvSet(assistantKey(channel), true, ASSISTANT_TTL_MS);
    return;
  }
  if (event.type === 'assistant_thread_context_changed') return;

  const botUserId = await resolveBotUserId(client);
  const shaped = toIncomingMessage(event, { botUserId });
  if (!shaped) {
    console.log(`[quackbot] event type=${event.type} subtype=${event.subtype ?? '-'} is not a turn`);
    return;
  }

  // Resolved only once the event is known to be a turn — the filters above
  // reject far more events than they pass, and each rejected one would
  // otherwise pay for a Postgres round trip to answer a question nobody asks.
  const msg: IncomingMessage = { ...shaped, isAssistant: await isAssistantChannel(shaped.channel) };

  // The bot user id is passed in already resolved, unlike registerHandlers
  // which backfills it on a promise — a one-shot worker has no "later".
  const runner: TurnRunner = buildTurnRunner(makeWorkerDeps(client, botUserId));

  try {
    await runner.handle(msg);
  } catch (err) {
    // `handle` reports its own turn failures in-thread, so reaching here means
    // something outside it broke — and the user is looking at a thread the bot
    // reacted to and then abandoned. Tell them before letting the process exit
    // nonzero: Modal marking the invocation failed is invisible from Slack.
    await reportFailure(client, msg.channel, errorNoticeThreadTs(msg));
    throw err;
  }
}

/**
 * Cleanup is not optional. Chromium (chart PNGs) and the pg pool both hold the
 * event loop open, so a worker that skips this does not exit — it idles until
 * Modal's 900s timeout kills it, billing the whole time for a turn that
 * finished in twenty seconds. Both run regardless of outcome, and neither is
 * allowed to mask the real error.
 */
async function shutdown(): Promise<void> {
  await closeBrowser().catch((err) => console.warn('[quackbot] closeBrowser failed:', redactError(err)));
  await closePool().catch((err) => console.warn('[quackbot] closePool failed:', redactError(err)));
}

/**
 * Exit without truncating the logs.
 *
 * `process.exit()` does not flush a stdout that is a PIPE, and Modal reads ours
 * through one (`subprocess.run(..., capture_output=True)`) precisely so that
 * `modal app logs` shows the bot's output — so exiting eagerly can discard the
 * last thing the worker said, which is usually the error you went looking for.
 * Setting `exitCode` lets Node drain and leave on its own.
 *
 * The timer is the backstop for the opposite failure: if `shutdown` missed a
 * handle (an MCP transport socket, a stray interval) Node will not exit at all,
 * and an idle worker bills to `run_turn`'s 900s timeout. Unref'd, so in the
 * normal case — nothing else on the loop — Node exits immediately and the timer
 * never runs.
 */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

/**
 * Run only when this file IS the process, not when something imports it.
 *
 * `src/worker.test.ts` imports the exported normalizers above; without this
 * guard that import would run a whole turn — read stdin, throw on the missing
 * env, and set `process.exitCode = 1`, failing the vitest run no matter what
 * the assertions said.
 *
 * The comparison is against the resolved path of both sides, because a mismatch
 * fails SILENTLY and in the worst possible direction: the worker would start,
 * do nothing, and exit 0, so every Slack message would vanish with a green tick
 * in Modal. `realpath` on argv[1] is what covers the case where /app or the
 * repo is reached through a symlink, which is the only way the two spellings
 * have been observed to differ.
 */
function isEntrypoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return pathToFileURL(realpathSync(argv)).href === import.meta.url;
  } catch {
    return pathToFileURL(argv).href === import.meta.url;
  }
}

if (isEntrypoint()) {
  main()
    .then(async () => {
      await shutdown();
      finish(0);
    })
    .catch(async (err) => {
      console.error('[quackbot] worker failed:', redactError(err));
      await shutdown();
      finish(1);
    });
}
