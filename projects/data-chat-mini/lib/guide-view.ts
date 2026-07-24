/**
 * Pure view logic for the sidebar's Guides section — extracted from
 * SchemaExplorerSidebar so the union/dedupe and count math are unit-testable.
 */

/** One guide as summarized by list_guides / list_tables.relatedGuides. */
export interface GuideSummary {
  uuid: string;
  topic: string;
  title: string;
  description: string;
  access: string;
}

/** One topic (folder) row as summarized by list_guides. */
export interface TopicSummary {
  topic: string;
  guide_count: number;
}

/**
 * Union for the database-scoped guide list: server-attested related guides
 * first (they're authoritative — reference-driven), then the text-matched
 * guides, deduplicated by uuid with the related entry winning.
 */
export function mergeRelatedGuides(
  related: GuideSummary[],
  textMatched: GuideSummary[],
): GuideSummary[] {
  const seen = new Set<string>();
  const merged: GuideSummary[] = [];
  for (const g of [...related, ...textMatched]) {
    if (seen.has(g.uuid)) continue;
    seen.add(g.uuid);
    merged.push(g);
  }
  return merged;
}

/**
 * Header total for the Guides section. Related guides carry real topics, so a
 * guide can appear both as a root card and inside a visible topic's
 * guide_count — subtract that overlap (exact topic match) so it isn't counted
 * twice.
 *
 * Known-imprecise by design: topic rows only expose an aggregate guide_count,
 * not uuid membership, so when several displayed guides share one topic the
 * subtraction can exceed that topic's count and the clamp makes the total
 * slightly low. Exact accounting would need per-topic uuid lists from the
 * MCP; this is a cosmetic count, so best-effort is fine.
 */
export function countSidebarGuides(
  display: GuideSummary[],
  topics: TopicSummary[],
): number {
  const topicSet = new Set(topics.map((t) => t.topic));
  const overlap = display.filter((g) => g.topic && topicSet.has(g.topic)).length;
  const topicTotal = topics.reduce((n, t) => n + t.guide_count, 0);
  return display.length + Math.max(0, topicTotal - overlap);
}
