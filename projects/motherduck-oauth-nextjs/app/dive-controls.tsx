'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
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
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => push({ q: value.trim() || undefined }), 300);
  }

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      <div className="flex border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] overflow-hidden">
        {(['mine', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => push({ scope: s === 'mine' ? undefined : 'all' })}
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
          onChange={(e) => push({ sort: e.target.value })}
          className="px-2 py-2 text-sm text-foreground bg-white border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {(Object.keys(SORT_LABELS) as DiveSort[]).map((k) => (
            <option key={k} value={k}>{SORT_LABELS[k]}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={() => push({ dir: dir === 'asc' ? 'desc' : 'asc' })}
        aria-label={`Sort ${dir === 'asc' ? 'ascending' : 'descending'} — click to toggle`}
        title={dir === 'asc' ? 'Ascending' : 'Descending'}
        className="px-3 py-2 text-sm font-medium text-foreground bg-white border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] hover:bg-brutal-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
      </button>
    </div>
  );
}
