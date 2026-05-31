'use client';

import { useEffect, useState } from 'react';
import {
  listConversations,
  deleteConversation,
  renameConversation,
} from '@/lib/chat-storage';
import type { ConversationSummary } from '@/types/chat';

export function ChatHistorySidebar({
  activeId,
  reloadKey,
  onSelect,
  onNew,
}: {
  activeId: string | null;
  reloadKey: number;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    listConversations().then(setItems).catch(() => setItems([]));
  }, [reloadKey]);

  const refresh = () => listConversations().then(setItems).catch(() => {});

  return (
    <div className="flex h-full flex-col border-r border-[var(--border)] bg-[var(--panel)] w-64 shrink-0">
      <div className="p-3 border-b border-[var(--border)]">
        <button
          onClick={onNew}
          className="w-full rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 && (
          <div className="px-2 py-3 text-xs text-[var(--muted)]">No conversations yet.</div>
        )}
        {items.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center gap-1 rounded-md px-2 py-2 text-sm cursor-pointer ${
              c.id === activeId ? 'bg-white border border-[var(--border)]' : 'hover:bg-white/60'
            }`}
            onClick={() => onSelect(c.id)}
          >
            <span className="flex-1 truncate">{c.title}</span>
            <button
              title="Rename"
              className="opacity-0 group-hover:opacity-100 text-xs text-[var(--muted)] hover:text-black px-1"
              onClick={async (e) => {
                e.stopPropagation();
                const next = window.prompt('Rename conversation', c.title);
                if (next && next.trim()) {
                  await renameConversation(c.id, next.trim());
                  refresh();
                }
              }}
            >
              ✎
            </button>
            <button
              title="Delete"
              className="opacity-0 group-hover:opacity-100 text-xs text-[var(--muted)] hover:text-red-600 px-1"
              onClick={async (e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${c.title}"?`)) {
                  await deleteConversation(c.id);
                  if (c.id === activeId) onNew();
                  refresh();
                }
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
