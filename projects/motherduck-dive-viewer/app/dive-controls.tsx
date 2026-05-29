'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { DiveSort, SortDir } from '@/lib/dives';

const SORT_LABELS: Record<DiveSort, string> = {
  modified: 'Last modified',
  created: 'Created',
  owner: 'Owner',
  title: 'Title',
};

export function DiveControls({
  sort,
  dir,
  q,
  scope,
}: {
  sort: DiveSort;
  dir: SortDir;
  q: string;
  scope: 'mine' | 'all';
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(q);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `isPending` stays true across the server round-trip a navigation triggers,
  // so it covers the slow "All dives" list query — letting us show a loading
  // indicator instead of the click appearing to do nothing.
  const [isPending, startTransition] = useTransition();

  // Keep refs to the LATEST params/pathname so a debounced `q` push that fires
  // after a later render reads current values instead of the closure captured
  // when it was scheduled. This prevents a delayed search push from clobbering
  // a scope/sort/dir change the user made while the search was still pending.
  const paramsRef = useRef(params);
  const pathnameRef = useRef(pathname);
  // Sync the refs to the latest values in an effect (not during render — refs
  // must not be written while rendering). Runs after every commit, so a
  // debounced `push` that fires later reads current params/pathname.
  useEffect(() => {
    paramsRef.current = params;
    pathnameRef.current = pathname;
  });

  // Clear any pending debounce timer on unmount so it can't fire (and navigate
  // via router.replace) after this component has gone away — e.g. the user
  // types in search then immediately opens a Dive before the 300ms elapses.
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  // Resync the controlled input when `q` changes from outside the component
  // (e.g. back/forward navigation). Adjusting state during render with a
  // previous-value guard is React's recommended alternative to a setState
  // call inside an effect.
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    setSearch(q);
  }

  function push(next: Record<string, string | undefined>) {
    const sp = new URLSearchParams(paramsRef.current.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    // Any navigation cancels a pending search debounce, so a stale debounced
    // `push` can't fire afterward and clobber this navigation's params.
    if (debounce.current) {
      clearTimeout(debounce.current);
      debounce.current = null;
    }
    const qs = sp.toString();
    const path = pathnameRef.current;
    startTransition(() => {
      router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    });
  }

  /**
   * Scope/sort/dir navigation. Folds in the current search-box value so a
   * query the user typed but hasn't yet debounced rides along with the change
   * (rather than being dropped when `push` cancels the pending debounce).
   */
  function pushControl(next: Record<string, string | undefined>) {
    push({ ...next, q: search.trim() || undefined });
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => push({ q: value.trim() || undefined }), 300);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6" aria-busy={isPending}>
      <div className="flex border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] overflow-hidden">
        {(['mine', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pushControl({ scope: s === 'mine' ? undefined : 'all' })}
            aria-pressed={scope === s}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              scope === s
                ? 'bg-primary text-primary-foreground'
                : 'bg-white text-foreground hover:bg-brutal-surface'
            } ${s === 'mine' ? 'border-r-2 border-foreground' : ''}`}
          >
            {s === 'mine' ? 'My dives' : 'All dives'}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search title or owner…"
        aria-label="Search dives"
        className="flex-1 min-w-[220px] px-3 py-2 text-sm bg-white border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />

      <label className="flex items-center gap-2 text-sm text-brutal-muted">
        Sort
        <select
          value={sort}
          onChange={(e) => pushControl({ sort: e.target.value })}
          className="px-2 py-2 text-sm text-foreground bg-white border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {(Object.keys(SORT_LABELS) as DiveSort[]).map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={() => pushControl({ dir: dir === 'asc' ? 'desc' : 'asc' })}
        aria-label={`Sort ${dir === 'asc' ? 'ascending' : 'descending'} — click to toggle`}
        title={dir === 'asc' ? 'Ascending' : 'Descending'}
        className="px-3 py-2 text-sm font-medium text-foreground bg-white border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] hover:bg-brutal-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
      </button>

      {isPending && (
        <span
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-brutal-muted"
        >
          <span className="w-4 h-4 rounded-full border-2 border-foreground/20 border-t-foreground animate-spin" />
          Loading…
        </span>
      )}
    </div>
  );
}
