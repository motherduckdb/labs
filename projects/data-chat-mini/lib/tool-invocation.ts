export function applyToolArgDefaults(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'query' && typeof args.query === 'string') {
    return { ...args, database: args.database || 'nba_box_scores_v2' };
  }
  return args;
}

export function detectPayloadFailure(content: string): string | null {
  return /error|failed|unauthorized|forbidden/i.test(content) ? content.slice(0, 300) : null;
}
