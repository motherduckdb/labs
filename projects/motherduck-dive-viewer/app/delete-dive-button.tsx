'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export function DeleteDiveButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete(e: React.MouseEvent) {
    // The card behind this button is a navigation link — don't follow it.
    e.preventDefault();
    e.stopPropagation();

    if (!window.confirm(`Delete “${title}”?\n\nThis permanently deletes the Dive and cannot be undone.`)) {
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/dives/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        window.alert(data.error === 'auth_expired'
          ? 'Your session expired. Please sign in again.'
          : 'Could not delete this Dive.');
        setBusy(false);
        return;
      }
      // Re-run the server component so the list reflects the deletion.
      router.refresh();
    } catch {
      window.alert('Could not delete this Dive.');
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={busy}
      aria-label={`Delete ${title}`}
      title="Delete dive"
      className="absolute top-2.5 right-2.5 z-10 inline-flex items-center justify-center w-8 h-8 rounded-sm border-2 border-foreground bg-white text-foreground transition-colors hover:bg-destructive hover:text-white disabled:opacity-50 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {busy ? <span className="text-xs">…</span> : <TrashIcon />}
    </button>
  );
}
