import { describe, expect, it } from 'vitest';
import { parseTables, parseRelatedGuides } from './mcp-parsers';

// Real `list_tables` MCP response shape (nba_box_scores_v2), trimmed. Note
// `relatedGuides` sits alongside `tables` at the top level, not nested.
const LIST_TABLES_FIXTURE = JSON.stringify({
  success: true,
  database: 'nba_box_scores_v2',
  schema: 'all',
  tableCount: 12,
  viewCount: 4,
  tables: [{ schema: 'main', name: 'box_scores', type: 'table', comment: '3,820,649 rows' }],
  count: 1,
  totalCount: 16,
  truncated: true,
  message: 'Showing 1 of 16 results.',
  relatedGuides: [
    {
      uuid: '4089a7ab-7d24-4c23-ad38-9d6628b050fb',
      topic: 'nba',
      title: 'NBA box scores — querying nba_box_scores_v2',
      access: 'organization',
      description: 'Correctness rules (grain, joins, stat eras) and object reference for the nba_box_scores_v2 database',
    },
  ],
});

describe('parseRelatedGuides', () => {
  it('parses the realistic list_tables fixture into one guide with all fields', () => {
    const guides = parseRelatedGuides(LIST_TABLES_FIXTURE);
    expect(guides).toEqual([
      {
        uuid: '4089a7ab-7d24-4c23-ad38-9d6628b050fb',
        topic: 'nba',
        title: 'NBA box scores — querying nba_box_scores_v2',
        description: 'Correctness rules (grain, joins, stat eras) and object reference for the nba_box_scores_v2 database',
        access: 'organization',
      },
    ]);
  });

  it('returns [] when relatedGuides is missing', () => {
    const raw = JSON.stringify({ success: true, tables: [] });
    expect(parseRelatedGuides(raw)).toEqual([]);
  });

  it('returns [] on non-JSON input', () => {
    expect(parseRelatedGuides('not json at all')).toEqual([]);
  });

  it('drops rows without a uuid and coerces missing optional fields to empty strings', () => {
    const raw = JSON.stringify({
      relatedGuides: [
        { topic: 'nba', title: 'no uuid, should be dropped' },
        { uuid: 'abc-123' },
      ],
    });
    expect(parseRelatedGuides(raw)).toEqual([
      { uuid: 'abc-123', topic: '', title: '', description: '', access: '' },
    ]);
  });

  it('preserves a root-level private guide (empty topic, access user)', () => {
    const raw = JSON.stringify({
      relatedGuides: [
        { uuid: 'def-456', topic: '', title: 'My private notes', description: '', access: 'user' },
      ],
    });
    expect(parseRelatedGuides(raw)).toEqual([
      { uuid: 'def-456', topic: '', title: 'My private notes', description: '', access: 'user' },
    ]);
  });

  it('returns [] when relatedGuides is present but not an array', () => {
    expect(parseRelatedGuides(JSON.stringify({ relatedGuides: 'oops' }))).toEqual([]);
    expect(parseRelatedGuides(JSON.stringify({ relatedGuides: { uuid: 'x' } }))).toEqual([]);
  });
});

describe('parseTables (shared fixture)', () => {
  it('still parses the box_scores row out of the same list_tables payload', () => {
    expect(parseTables(LIST_TABLES_FIXTURE)).toEqual([
      { schema: 'main', name: 'box_scores', type: 'table', comment: '3,820,649 rows', fragmentCount: undefined },
    ]);
  });
});
