import { runUserQuery } from './motherduck-sql';

export interface DiveSummary {
  /** UUID — the dive identifier. */
  id: string;
  /** Human title; empty when missing (UI falls back to a short UUID slice). */
  title: string;
  /** Account that owns the dive (MD_LIST_DIVES `owner_name`). */
  owner?: string;
  /** ISO-ish timestamp the dive was created. */
  createdAt?: string;
  /** ISO-ish timestamp the dive was last modified (MD has no "last accessed"). */
  updatedAt?: string;
}

export type DiveSort = 'modified' | 'created' | 'owner' | 'title';
export type SortDir = 'asc' | 'desc';

/** Sort key → MD_LIST_DIVES() column. Allowlisted so the key can't inject SQL. */
const SORT_COLUMNS: Record<DiveSort, string> = {
  modified: 'updated_at',
  created: 'created_at',
  owner: 'owner_name',
  title: 'title',
};

export interface ListDivesOptions {
  sort?: DiveSort;
  dir?: SortDir;
  search?: string;
  /** Include dives shared with the user's org (all owners), not just their own. */
  includeOrgShares?: boolean;
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Wrap a value as a single-quoted SQL string literal, escaping quotes. */
function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * List Dives by running actual SQL against MotherDuck (via a DuckDB
 * connection — see `runUserQuery`), using the `MD_LIST_DIVES()` table
 * function. Sorting and filtering happen server-side in SQL, and the full
 * result set comes back in one query (no MCP tool, no 50KB cap, no
 * pagination).
 *
 * `includeOrgShares` switches between the user's own dives and every dive
 * shared with their org. Sorting is limited to columns MotherDuck stores —
 * there is no "last accessed" timestamp, so `modified` (updated_at) is the
 * default.
 */
export async function listDives(
  accessToken: string,
  opts: ListDivesOptions = {},
): Promise<DiveSummary[]> {
  const sort: DiveSort = opts.sort && opts.sort in SORT_COLUMNS ? opts.sort : 'modified';
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  const column = SORT_COLUMNS[sort];
  const search = (opts.search ?? '').trim();
  const orgArg = opts.includeOrgShares ? 'include_org_shares = true' : '';

  // DuckDB's Postgres endpoint can't describe a prepared statement whose
  // result comes from a table function, so we use the simple query protocol
  // and inline values instead of binding them. `column`/`dir`/`orgArg` are
  // allowlisted constants; the search term is single-quote-escaped into a
  // string literal (see sqlString).
  const term = sqlString(search);
  const sql = `
    SELECT id, title, owner_name, created_at, updated_at
    FROM MD_LIST_DIVES(${orgArg})
    WHERE ${term} = ''
       OR title ILIKE '%' || ${term} || '%'
       OR owner_name ILIKE '%' || ${term} || '%'
       OR description ILIKE '%' || ${term} || '%'
    ORDER BY ${column} ${dir} NULLS LAST, id ASC
  `;

  const rows = await runUserQuery(accessToken, sql);
  return rows
    .map((r): DiveSummary => ({
      id: str(r.id) ?? '',
      title: str(r.title) ?? '',
      owner: str(r.owner_name),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    }))
    .filter((d) => d.id);
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Permanently delete a Dive by id via the `MD_DELETE_DIVE()` SQL function.
 * Only succeeds for dives the signed-in user is allowed to delete (their
 * own). Throws if the id is malformed or the function doesn't report success.
 */
export async function deleteDive(accessToken: string, id: string): Promise<void> {
  if (!UUID_RE.test(id)) {
    throw new Error('Invalid dive id');
  }
  // id is validated as a UUID above, so it's safe to inline (required: the
  // pg endpoint rejects bound params as table-function args). Simple query
  // protocol — no bound params.
  const rows = await runUserQuery(
    accessToken,
    `SELECT success FROM MD_DELETE_DIVE(id = '${id}'::UUID)`,
  );
  if (rows[0]?.success !== true) {
    throw new Error('MD_DELETE_DIVE did not report success');
  }
}
