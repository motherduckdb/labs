/**
 * Single source of truth for which mviz block types render inline in chat.
 *
 * The mviz library (and `lib/mviz-processor.ts`) can sanitize/lint the full
 * superset of block types, but the product deliberately exposes a narrow,
 * intentional set: a styled table plus three comparison charts. The fence
 * streaming detector (`lib/mviz-fence.ts`) gates on this list — anything not
 * here streams through as a plain code block instead of an inline render.
 *
 * To widen the surface, add a type here and teach it in `lib/system-prompt.ts`.
 * That's the whole change — the fence detector and width defaults derive from
 * this constant.
 */
export const ENABLED_MVIZ_TYPES = ['table', 'bar', 'line', 'dumbbell'] as const;

export type EnabledMvizType = (typeof ENABLED_MVIZ_TYPES)[number];

/** Regex-source alternation of the enabled types, e.g. `table|bar|line|dumbbell`. */
export const ENABLED_MVIZ_TYPES_PATTERN = ENABLED_MVIZ_TYPES.join('|');

/** Longest opener (```` ```<type> ````) length in chars — used to size the
 *  streaming partial-opener holdback so we never leak a partial fence opener
 *  as plain text before recognizing it. */
export const MAX_MVIZ_OPENER_LEN =
  3 + Math.max(...ENABLED_MVIZ_TYPES.map(t => t.length));
