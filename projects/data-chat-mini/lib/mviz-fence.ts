import { randomUUID } from 'node:crypto';
import {
  ENABLED_MVIZ_TYPES_PATTERN,
  MAX_MVIZ_OPENER_LEN,
} from '@/lib/mviz-types';

/**
 * Streaming mviz-fence state machine.
 *
 * The model emits assistant text that may contain one or more mviz blocks
 * (```table / ```bar / ```line / ```dumbbell — see `ENABLED_MVIZ_TYPES`).
 * Three concerns interleave:
 *
 *   1. Outside-fence text must forward to the client as `text` events.
 *   2. Inside-fence markdown must be suppressed — the client already shows
 *      a "Visualizing…" placeholder via `mviz_pending`. We never stream the
 *      raw JSON body as text.
 *   3. Each completed mviz block (`\`\`\`<type> ... \`\`\``) is extracted and
 *      handed back to the caller (via an `mviz_block` event) for rendering
 *      into final HTML. The pending placeholder id is paired with the block
 *      via a FIFO — openers produce placeholders in text order, closers
 *      produce blocks in the same order, so the pairing is stable.
 *
 * `stepMvizFence` is called after each delta arrives (with the growing
 * `fullText`) and returns any events that accumulated plus the new state.
 * `flushMvizFence` is called once at end-of-stream to release trailing text
 * held back by the opener lookahead and to emit fallback events for any
 * `mviz_pending` placeholders that never received a matching block (stream
 * cut off mid-fence, or malformed markdown).
 */

export type MvizFenceState = {
  /** How far we've scanned for complete `\`\`\`<type>...\`\`\`` blocks. */
  mvizScanCursor: number;
  /** How far we've decided what to forward as text vs suppress as fence body. */
  textEmitEnd: number;
  /** Start index of the current open fence (null while outside a fence). */
  openFenceStart: number | null;
  /** FIFO of placeholder ids awaiting an `mviz_block` pairing. */
  pendingFenceIds: string[];
};

export type MvizFenceEvent =
  | { kind: 'text'; content: string }
  | { kind: 'mviz_pending'; id: string }
  | { kind: 'mviz_block'; source: string; id?: string }
  | { kind: 'mviz_fallback'; id: string };

export function createMvizFenceState(): MvizFenceState {
  return { mvizScanCursor: 0, textEmitEnd: 0, openFenceStart: null, pendingFenceIds: [] };
}

/**
 * Regex source for an mviz fence opener: ```` ```<enabled-type> ```` immediately
 * followed by header whitespace. mviz headers are always `\`\`\`<type>\n` or
 * `\`\`\`<type> size=[…]\n`, so the type is always followed by whitespace — we
 * require a *present* whitespace char (`(?=\s)`) rather than merely "not an
 * identifier char". This matters in two ways:
 *   - Look-alikes don't match: ` ```barchart ` (next char `c`) and
 *     ` ```bar-chart ` (next char `-`) are both rejected, not read as `bar`.
 *   - End-of-buffer is NOT a boundary: a streamed ` ```bar ` whose `chart`
 *     hasn't arrived yet fails to match (no whitespace present), so the opener
 *     scan holds it back instead of emitting a premature `mviz_pending` that
 *     would later orphan into a fallback iframe when `barchart` completes.
 * Shared by `findFenceOpener` and `findNextMvizBlock` so the opener scan and
 * the completed-block matcher can never disagree on what's an enabled type.
 */
const FENCE_OPENER_SRC = '```(?:' + ENABLED_MVIZ_TYPES_PATTERN + ')(?=\\s)';

/**
 * Find the next mviz fence opener at or after `from`. Returns the opener
 * position and its byte length (variable: ` ```bar ` is 6, ` ```dumbbell ` 11).
 */
export function findFenceOpener(
  text: string,
  from: number,
): { index: number; length: number } | null {
  const re = new RegExp(FENCE_OPENER_SRC, 'g');
  re.lastIndex = from;
  const match = re.exec(text);
  if (!match) return null;
  return { index: match.index, length: match[0].length };
}

export function findNextMvizBlock(text: string, from: number): { source: string; end: number } | null {
  const re = new RegExp(FENCE_OPENER_SRC + '[^\\n]*\\n[\\s\\S]*?\\n```', 'g');
  re.lastIndex = from;
  const match = re.exec(text);
  if (!match) return null;
  return { source: match[0], end: match.index + match[0].length };
}

/**
 * Minimal HTML payload rendered into the mviz iframe when a placeholder
 * can't be paired with real mviz output. Plain inline styles; no network
 * dependencies. AutoSizeIframe's default 200 px height is fine — we skip
 * the height reporter on purpose so the error box stays compact.
 */
export function buildMvizFallbackHtml(reason: string): string {
  const safe = reason.replace(/[<>&]/g, c => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
  return `<!DOCTYPE html><html><body style="margin:0;padding:10px;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#7c1d0d;background:#fef2f0;border:1px solid #fbd5cc;border-radius:4px;line-height:1.4"><strong>Table render failed.</strong> ${safe}</body></html>`;
}

export function stepMvizFence(
  fullText: string,
  state: MvizFenceState,
  makeId: () => string = randomUUID,
): { events: MvizFenceEvent[]; newState: MvizFenceState } {
  const events: MvizFenceEvent[] = [];
  const s: MvizFenceState = {
    mvizScanCursor: state.mvizScanCursor,
    textEmitEnd: state.textEmitEnd,
    openFenceStart: state.openFenceStart,
    pendingFenceIds: [...state.pendingFenceIds],
  };

  // Walk forward through any newly-arrived bytes, splitting them into
  // outside-fence text and inside-fence markdown (suppressed).
  while (s.textEmitEnd < fullText.length) {
    if (s.openFenceStart === null) {
      const opener = findFenceOpener(fullText, s.textEmitEnd);
      if (opener === null) {
        // No unopened fence in the remaining bytes — but the last few bytes
        // might be a partial `\`\`\`dumbbel` waiting on the next chunk. Hold
        // back up to MAX_MVIZ_OPENER_LEN trailing chars so we don't leak the
        // opener as plain text before recognizing it.
        const safeEnd = Math.max(s.textEmitEnd, fullText.length - MAX_MVIZ_OPENER_LEN);
        if (safeEnd > s.textEmitEnd) {
          events.push({ kind: 'text', content: fullText.slice(s.textEmitEnd, safeEnd) });
          s.textEmitEnd = safeEnd;
        }
        break;
      }
      if (opener.index > s.textEmitEnd) {
        events.push({ kind: 'text', content: fullText.slice(s.textEmitEnd, opener.index) });
      }
      const id = makeId();
      s.pendingFenceIds.push(id);
      events.push({ kind: 'mviz_pending', id });
      s.openFenceStart = opener.index;
      s.textEmitEnd = opener.index + opener.length;
    } else {
      // Inside a fence — look for the closing `\n\`\`\`` at line start.
      const closer = fullText.indexOf('\n```', s.textEmitEnd);
      if (closer < 0) {
        // Still streaming fence body — silently consume what's here, but
        // hold back the last 3 bytes so a `\n\`\`\`` straddling a chunk
        // boundary can complete on the next call. Without this, the closer-
        // find can miss a `\n` that arrived in the previous chunk because
        // `textEmitEnd` already advanced past it. The downstream symptom:
        // when the model emits two adjacent mviz blocks and a chunk
        // boundary lands mid-closer, the second opener is swallowed
        // silently, only one mviz_pending fires, and the second mviz_block
        // emits with no id — the placeholder for the missed second fence
        // never gets swapped (#65).
        s.textEmitEnd = Math.max(s.textEmitEnd, fullText.length - 3);
        break;
      }
      s.textEmitEnd = closer + '\n```'.length;
      s.openFenceStart = null;
    }
  }

  // Detect each newly-completed ```<type>...``` block and hand it to the
  // caller for rendering. Pair with the oldest pending placeholder id so
  // text-order = block-order.
  while (true) {
    const match = findNextMvizBlock(fullText, s.mvizScanCursor);
    if (!match) break;
    const id = s.pendingFenceIds.shift();
    events.push({ kind: 'mviz_block', source: match.source, ...(id ? { id } : {}) });
    s.mvizScanCursor = match.end;
  }

  return { events, newState: s };
}

/**
 * End-of-stream cleanup. Emits any text held back by the opener lookahead
 * and fires `mviz_fallback` for placeholders never paired with a block
 * (stream cut off mid-fence, or block source was malformed so
 * `findNextMvizBlock` never matched).
 */
export function flushMvizFence(
  fullText: string,
  state: MvizFenceState,
): { events: MvizFenceEvent[]; newState: MvizFenceState } {
  const events: MvizFenceEvent[] = [];
  const s: MvizFenceState = {
    mvizScanCursor: state.mvizScanCursor,
    textEmitEnd: state.textEmitEnd,
    openFenceStart: state.openFenceStart,
    pendingFenceIds: [...state.pendingFenceIds],
  };

  if (s.openFenceStart === null && s.textEmitEnd < fullText.length) {
    events.push({ kind: 'text', content: fullText.slice(s.textEmitEnd) });
    s.textEmitEnd = fullText.length;
  }
  while (s.pendingFenceIds.length > 0) {
    const id = s.pendingFenceIds.shift()!;
    events.push({ kind: 'mviz_fallback', id });
  }
  s.openFenceStart = null;
  return { events, newState: s };
}
