import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserAccessToken } from '@/lib/require-auth';
import { listDives, type DiveSort, type SortDir, type DiveSummary } from '@/lib/dives';
import { isAuthError } from '@/lib/api-helpers';
import { DiveControls } from './dive-controls';
import { DeleteDiveButton } from './delete-dive-button';

// Reads cookies + lists dives per request — never statically cached.
export const dynamic = 'force-dynamic';

const VALID_SORTS: DiveSort[] = ['modified', 'created', 'owner', 'title'];

function fmtDate(ts?: string): string {
  if (!ts) return '';
  // Timestamps look like "2026-05-22 18:54:56.546+00" — keep date + HH:MM.
  return ts.replace('T', ' ').slice(0, 16);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string; q?: string; scope?: string }>;
}) {
  const accessToken = await requireUserAccessToken('/');

  const sp = await searchParams;
  const sort: DiveSort = VALID_SORTS.includes(sp.sort as DiveSort) ? (sp.sort as DiveSort) : 'modified';
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';
  const q = typeof sp.q === 'string' ? sp.q : '';
  const scope: 'mine' | 'all' = sp.scope === 'all' ? 'all' : 'mine';

  let dives: DiveSummary[] = [];
  let error: string | null = null;
  try {
    dives = await listDives(accessToken, {
      sort,
      dir,
      search: q,
      includeOrgShares: scope === 'all',
    });
  } catch (e) {
    if (isAuthError(e)) redirect('/login');
    console.error('[Home] Failed to list dives:', e);
    error = 'Could not load your Dives. Try reconnecting.';
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between mb-6 pb-6 border-b-2 border-foreground/10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {scope === 'all' ? 'All Dives' : 'Your Dives'}
          </h1>
          <p className="text-sm text-brutal-muted mt-1">
            {q
              ? `${dives.length} match${dives.length === 1 ? '' : 'es'} for “${q}”`
              : `${dives.length} dive${dives.length === 1 ? '' : 's'} ${scope === 'all' ? 'across your org' : 'you own'}`}
          </p>
        </div>
        <a
          href="/api/auth/motherduck/logout"
          className="text-sm font-medium text-foreground underline underline-offset-2 hover:text-accent-foreground"
        >
          Sign out
        </a>
      </header>

      <DiveControls sort={sort} dir={dir} q={q} scope={scope} />

      {error && <p className="text-sm text-destructive mb-6">{error}</p>}

      {!error && dives.length === 0 && (
        <p className="text-sm text-brutal-muted">
          {q ? (
            'No Dives match your search.'
          ) : (
            <>
              No Dives found on your account yet. Create one at{' '}
              <a
                href="https://app.motherduck.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                app.motherduck.com
              </a>
              .
            </>
          )}
        </p>
      )}

      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {dives.map((dive) => {
          const title = dive.title || `Dive ${dive.id.slice(0, 8)}…`;
          return (
            <li key={dive.id} className="relative">
              {scope === 'mine' && <DeleteDiveButton id={dive.id} title={title} />}
              <Link
                href={`/dives/${dive.id}?title=${encodeURIComponent(title)}`}
                className="flex flex-col h-full bg-brutal-surface border-2 border-foreground rounded-sm shadow-[3px_3px_0_#171717] p-5 transition-all duration-150 hover:shadow-[5px_5px_0_#171717] hover:-translate-x-0.5 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="block text-base font-semibold text-foreground leading-snug pr-9">
                  {title}
                </span>
                {dive.owner && (
                  <span className="block text-xs text-brutal-muted mt-2">
                    by <span className="font-medium text-foreground/80">{dive.owner}</span>
                  </span>
                )}
                <span className="mt-auto pt-3 flex flex-col gap-0.5 text-xs text-brutal-muted font-mono">
                  {dive.updatedAt && <span>modified {fmtDate(dive.updatedAt)}</span>}
                  <span className="truncate">{dive.id}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
