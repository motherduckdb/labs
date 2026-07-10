import type { WebClient } from '@slack/web-api';
import type { TurnUsage } from '../core/types';
import type {
  AgenticLoopFinishReason,
  MvizBlockEvent,
  ToolEndCall,
  ToolStartCall,
  TurnSink,
} from '../core/turn-sink';
import { toMarkdownBlocks, toMrkdwn } from './markdown';
import { classifyMvizBlock, tableBlockToMarkdown } from './viz';
import { renderHtmlToPng } from './screenshot';

/**
 * TurnSink that streams an agentic turn into a single Slack message.
 *
 * The agentic loop drives this sink with text, tool, and mviz events. We
 * accumulate the model's text and repaint one placeholder message as it
 * grows — throttled so we don't hammer `chat.update`. Two render modes:
 *
 *   - INTERIM: cheap plain-`mrkdwn` `chat.update`s while the turn streams,
 *     with a trailing italic progress line ("_→ running query…_") and a
 *     "_visualizing…_" marker wherever a chart is still being rendered.
 *   - FINAL: one `chat.update` with native markdown blocks (`toMarkdownBlocks`),
 *     tables spliced inline, charts uploaded as PNGs into the thread.
 *
 * Every Slack call is best-effort (try/catch + warn) — the sink must never
 * throw back into the loop. All writes funnel through a serialized promise
 * chain so an interim repaint can't race the final render or a split.
 */

// Slack hard-caps a text field ~4k and blocks/messages larger still; we split
// well under those. Interim updates are plain text (tighter cap); the final
// render uses markdown blocks which `toMarkdownBlocks` pre-splits to ≤12k.
const INTERIM_CAP = 3900;
const FINAL_CAP = 12000;
// Slack's hard limit for a message `text` field is ~40k; stay safely under it.
const SLACK_TEXT_CAP = 38000;
const MIN_UPDATE_MS = 1500;
const DEFAULT_POST_RETRY_MS = 1000;

const MARKER_RE = /@@MVIZ:([^@]+)@@/g;
const mvizMarker = (id: string): string => `@@MVIZ:${id}@@`;

const TOOL_VERBS: Record<string, string> = {
  query: 'running query',
  list_tables: 'inspecting schema',
  list_columns: 'inspecting schema',
  list_databases: 'inspecting schema',
  query_context_layer: 'checking saved context',
  update_context_layer: 'saving context',
  search_catalog: 'searching catalog',
  ask_docs_question: 'reading docs',
  save_dive: 'saving dive',
  list_dives: 'browsing dives',
  read_dive: 'reading dive',
  get_dive_guide: 'reading the dive guide',
};

function verbFor(name: string): string {
  return TOOL_VERBS[name] ?? 'working';
}

/** Split `s` at or before `cap`, preferring a newline boundary. */
function findSplit(s: string, cap: number): number {
  const nl = s.lastIndexOf('\n', cap);
  if (nl > cap * 0.5) return nl + 1;
  return cap;
}

/** Split a stable final body into chunks each ≤ FINAL_CAP, at newline boundaries. */
function splitForFinal(body: string): string[] {
  const chunks: string[] = [];
  let rest = body;
  while (rest.length > FINAL_CAP) {
    const at = findSplit(rest, FINAL_CAP);
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  return chunks;
}

/** Cap the notification-fallback `text` well under Slack's recommended 4k. */
function truncateFallback(s: string): string {
  if (s.length <= INTERIM_CAP) return s;
  return `${s.slice(0, INTERIM_CAP - 1)}…`;
}

/**
 * Cap a plain-`text` payload under Slack's hard ~40k text limit. The ≤12k split
 * happens on the MARKDOWN body, but `toMrkdwn` renders tables as padded ASCII
 * (every cell padded to its column width), which can expand a sparse wide table
 * well past 40k — so the converted string must be re-capped before it's sent as
 * text, with the note appended AFTER truncating so it always survives.
 */
function capForText(s: string): string {
  if (s.length <= SLACK_TEXT_CAP) return s;
  const note = '\n\n_…truncated…_';
  return `${s.slice(0, SLACK_TEXT_CAP - note.length)}${note}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SlackTurnSinkOpts {
  /** bolt/Slack WebClient (`app.client`). Tests pass a fake cast to it. */
  client: WebClient;
  channel: string;
  /**
   * Thread the reply, continuation messages, and chart uploads belong to.
   * `undefined` in a plain DM where replies go to the main timeline.
   */
  threadTs?: string;
  /** ts of the already-posted placeholder reply we repaint. */
  placeholderTs: string;
  /** Whether the surface is a Slack assistant thread (enables setStatus). */
  isAssistant?: boolean;
  /** Delay before the single retry of a failed fresh-post (default 1s). Tests set 0. */
  postRetryDelayMs?: number;
}

type MvizMarker =
  | { kind: 'pending' }
  | { kind: 'table'; md: string }
  | { kind: 'chart' }
  | { kind: 'error' };

export class SlackTurnSink implements TurnSink {
  private readonly client: WebClient;
  private readonly channel: string;
  private readonly threadTs: string | undefined;
  private readonly isAssistant: boolean;

  private text = '';
  private readonly markers = new Map<string, MvizMarker>();
  private statusLine: string | null = null;
  private thinking = false;
  private usage: TurnUsage | undefined;
  private errorText: string | undefined;
  private finishReason: AgenticLoopFinishReason | undefined;

  private finalized = false;
  private targetTs: string;
  private readonly postRetryDelayMs: number;
  /** Count of answer chunks that could not be posted at all (data loss). */
  private droppedChunks = 0;
  private droppedNoteSent = false;

  // Throttle/coalesce state. At most one interim repaint is in flight at a
  // time (`inFlight`); `dirty` marks that state changed since the last paint;
  // `lastUpdateAt` is stamped when a paint COMPLETES (not when it's queued) so
  // a slow API call can't be immediately followed by another.
  private lastUpdateAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private readonly uploads: Promise<void>[] = [];
  private assistantStatusFailed = false;

  constructor(opts: SlackTurnSinkOpts) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.targetTs = opts.placeholderTs;
    this.isAssistant = opts.isAssistant ?? false;
    this.postRetryDelayMs = opts.postRetryDelayMs ?? DEFAULT_POST_RETRY_MS;
    if (!this.isAssistant) this.assistantStatusFailed = true;
  }

  // --- TurnSink surface -----------------------------------------------------

  onText(content: string): void {
    this.text += content;
    this.scheduleUpdate();
  }

  onThinking(_content: string): void {
    if (!this.thinking) {
      this.thinking = true;
      void this.setAssistantStatus('thinking…');
      this.scheduleUpdate();
    }
  }

  onThinkingDone(): void {
    this.thinking = false;
    this.scheduleUpdate();
  }

  onToolStart(call: ToolStartCall): void {
    this.statusLine = verbFor(call.name);
    void this.setAssistantStatus(this.statusLine);
    this.scheduleUpdate();
  }

  onToolEnd(_call: ToolEndCall): void {
    this.statusLine = null;
    this.scheduleUpdate();
  }

  onMvizPending(id: string): void {
    this.markers.set(id, { kind: 'pending' });
    this.text += mvizMarker(id);
    this.scheduleUpdate();
  }

  onMvizBlock(block: MvizBlockEvent): void {
    const { id, source, html, fallback } = block;
    // Try native table rendering whenever we have real fence source — even a
    // `fallback: true` block (HTML render failed upstream) keeps its real
    // source, so a valid table spec can still be recovered into markdown. Only
    // never-completed fences arrive with source ''.
    let md: string | null = null;
    if (source && classifyMvizBlock(source) === 'table') {
      md = tableBlockToMarkdown(source);
    }
    if (md) {
      this.markers.set(id, { kind: 'table', md });
      this.scheduleUpdate();
      return;
    }
    if (fallback) {
      // Render already failed upstream and it isn't a recoverable table; the
      // html is just a small error card. Skip the PNG round-trip (no point
      // launching Chromium to screenshot an error) and leave a compact note.
      this.markers.set(id, { kind: 'error' });
      this.scheduleUpdate();
      return;
    }
    // Real chart: render to PNG and upload as its own thread message; the
    // marker collapses to nothing in the text stream.
    this.markers.set(id, { kind: 'chart' });
    this.scheduleUpdate();
    this.uploads.push(this.renderAndUpload(id, html));
  }

  onUsage(usage: TurnUsage): void {
    this.usage = usage;
  }

  onError(message: string): void {
    this.errorText = message;
    this.scheduleUpdate();
  }

  onAuthExpired(message: string): void {
    this.errorText = message;
    this.scheduleUpdate();
  }

  onTurnComplete(finishReason: AgenticLoopFinishReason): void {
    this.finishReason = finishReason;
  }

  // --- Public accessors / lifecycle ----------------------------------------

  getUsage(): TurnUsage | undefined {
    return this.usage;
  }

  getFinishReason(): AgenticLoopFinishReason | undefined {
    return this.finishReason;
  }

  /** Number of answer chunks that failed to post even after a retry (data loss). */
  getDroppedChunks(): number {
    return this.droppedChunks;
  }

  /**
   * Flush the final render. Idempotent. Waits for any in-flight interim
   * repaint (so it can't race the final update) and for all pending chart
   * uploads (so failed charts have swapped their marker to an error note
   * before we paint).
   */
  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* interim errors are already swallowed internally */
      }
    }
    await Promise.allSettled(this.uploads);
    try {
      await this.doFinal();
    } catch (err) {
      console.warn('[quackbot] final render failed:', err);
    }
  }

  // --- internals ------------------------------------------------------------

  private scheduleUpdate(): void {
    if (this.finalized) return;
    this.dirty = true;
    this.maybeFlush();
  }

  /**
   * Start an interim repaint if one isn't already scheduled or in flight and
   * the throttle window has elapsed; otherwise arm a trailing timer. Re-invoked
   * after each paint completes to pick up changes that arrived mid-flight.
   */
  private maybeFlush(): void {
    if (this.finalized || this.inFlight || this.timer) return;
    if (!this.dirty) return;
    const since = Date.now() - this.lastUpdateAt;
    if (since < MIN_UPDATE_MS) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.maybeFlush();
      }, MIN_UPDATE_MS - since);
      return;
    }
    this.dirty = false;
    const run = this.doInterim()
      .catch((err) => console.warn('[quackbot] interim render failed:', err))
      .finally(() => {
        this.inFlight = null;
        // Stamp on COMPLETION so a slow update throttles the next from when it
        // actually finished, not from when it was queued.
        this.lastUpdateAt = Date.now();
        this.maybeFlush();
      });
    this.inFlight = run;
  }

  private async doInterim(): Promise<void> {
    if (this.finalized) return;
    await this.commit(this.interimRender(), false);
  }

  private async doFinal(): Promise<void> {
    await this.clearAssistantStatus();
    await this.commit(this.renderBody(true), true);
  }

  private renderBody(final: boolean): string {
    let out = this.text.replace(MARKER_RE, (_m, id: string) => {
      const marker = this.markers.get(id);
      if (!marker) return '';
      switch (marker.kind) {
        case 'pending':
          return final ? '' : '_visualizing…_';
        case 'table':
          return `\n${marker.md}\n`;
        case 'error':
          return '_(chart failed to render)_';
        case 'chart':
        default:
          return '';
      }
    });
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    if (this.errorText) {
      out = out ? `${out}\n\n:warning: ${this.errorText}` : `:warning: ${this.errorText}`;
    }
    return out;
  }

  private interimRender(): string {
    const body = this.renderBody(false);
    let suffix = '';
    if (!this.errorText) {
      if (this.statusLine) suffix = `\n\n_→ ${this.statusLine}…_`;
      else if (this.thinking) suffix = '\n\n_thinking…_';
    }
    return `${body}${suffix}` || '_:duck: on it…_';
  }

  /**
   * Paint `body` into Slack.
   *
   * Interim repaints are a SINGLE message (the placeholder) — never split.
   * Splitting an interim across messages was the source of a stale-offset bug:
   * the accumulated text mutates as mviz markers collapse (a table splices in,
   * a chart marker vanishes), so a char offset committed mid-stream no longer
   * points where it did. The authoritative full render happens in `finalize`,
   * where every marker is resolved and the body is stable — so we split there.
   */
  private async commit(body: string, final: boolean): Promise<void> {
    if (!final) {
      // Interim: one best-effort update of the placeholder. Kept under a safe
      // cap so a single chat.update always succeeds; the authoritative full
      // answer (split across messages) lands in finalize. A failed interim is
      // fine to swallow — finalize self-heals.
      const shown = body.length > INTERIM_CAP ? `${body.slice(0, INTERIM_CAP - 1)}…` : body;
      // The 3.9k cap is on the MARKDOWN source, but toMrkdwn's ASCII-table
      // padding can expand a small table past Slack's text limit — so re-cap the
      // CONVERTED string (note appended after slicing) or the update is rejected.
      const text = capForText(toMrkdwn(shown) || '…');
      await this.tryUpdate({ channel: this.channel, ts: this.targetTs, text });
      return;
    }

    // Final: the body is stable (all markers resolved), so split it into
    // ≤cap chunks up front. Chunk 0 repaints the placeholder; the rest post as
    // fresh thread messages, in order. Content is NEVER dropped — every write
    // self-heals to a fresh post if the target message is gone.
    const chunks = splitForFinal(body);
    await this.paintFinalChunk(this.targetTs, chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await this.paintFinalChunk(null, chunks[i]);
    }
  }

  /**
   * Land one final chunk. When `ts` is set we try to update that message
   * first; if the update fails (e.g. the placeholder was deleted) — or when
   * `ts` is null — we post the content as a fresh thread message so it is never
   * silently lost. Within each target we try native blocks first, then plain
   * text (the full chunk, not the short notification fallback).
   */
  private async paintFinalChunk(ts: string | null, content: string): Promise<void> {
    // The short `text` is only the notification fallback WHEN blocks render; the
    // plain-text retry below sends the full chunk — capped under Slack's ~40k
    // text limit (toMrkdwn can expand a table-heavy chunk past 12k).
    const full = capForText(toMrkdwn(content) || '…');
    const notify = truncateFallback(full);
    const blocks = toMarkdownBlocks(content);

    if (ts) {
      if (await this.tryUpdate({ channel: this.channel, ts, blocks, text: notify })) return;
      if (await this.tryUpdate({ channel: this.channel, ts, text: full })) return;
      // The target message is unusable (deleted?) — fall through to a fresh post
      // rather than drop the chunk.
    }
    if (await this.tryPost({ blocks, text: notify })) return;
    if (await this.tryPost({ text: full })) return;

    // Everything failed — most likely a transient rate limit. Wait and retry
    // the fresh-post path once before giving up.
    await delay(this.postRetryDelayMs);
    if (await this.tryPost({ blocks, text: notify })) return;
    if (await this.tryPost({ text: full })) return;

    // Persistent failure: this chunk is lost. Make the loss OBSERVABLE — count
    // it, log loudly, and (once per turn) best-effort tell the reader something
    // is missing. finalize still resolves; we never hang the turn.
    this.droppedChunks += 1;
    console.error('[quackbot] DROPPED a final answer chunk after retry — content lost');
    if (!this.droppedNoteSent) {
      this.droppedNoteSent = true;
      await this.tryPost({ text: ':warning: _part of this answer failed to post._' });
    }
  }

  private async tryUpdate(args: {
    channel: string;
    ts: string;
    text: string;
    blocks?: object[];
  }): Promise<boolean> {
    try {
      await this.client.chat.update(args);
      return true;
    } catch (err) {
      console.warn('[quackbot] chat.update failed:', err);
      return false;
    }
  }

  private async tryPost(args: { text: string; blocks?: object[] }): Promise<boolean> {
    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        ...args,
      });
      return true;
    } catch (err) {
      console.warn('[quackbot] chat.postMessage failed:', err);
      return false;
    }
  }

  private async renderAndUpload(id: string, html: string): Promise<void> {
    try {
      const png = await renderHtmlToPng(html);
      const base = { channel_id: this.channel, file: png, filename: 'chart.png' };
      // @slack/web-api's FilesUploadV2Arguments is a finicky union; cast the
      // fully-built object once (values are all valid) rather than fight it.
      const args = (this.threadTs
        ? { ...base, thread_ts: this.threadTs }
        : base) as Parameters<WebClient['files']['uploadV2']>[0];
      await this.client.files.uploadV2(args);
    } catch (err) {
      console.warn('[quackbot] chart render/upload failed:', err);
      this.markers.set(id, { kind: 'error' });
      this.scheduleUpdate();
    }
  }

  private async setAssistantStatus(status: string): Promise<void> {
    if (this.assistantStatusFailed) return;
    const threads = this.client.assistant?.threads;
    if (!threads || !this.threadTs) {
      this.assistantStatusFailed = true;
      return;
    }
    try {
      await threads.setStatus({ channel_id: this.channel, thread_ts: this.threadTs, status });
    } catch {
      this.assistantStatusFailed = true; // stop trying for this turn
    }
  }

  private async clearAssistantStatus(): Promise<void> {
    if (this.assistantStatusFailed) return;
    await this.setAssistantStatus('');
  }
}
