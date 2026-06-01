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
  onSelect: (summary: ConversationSummary) => void;
  onNew: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    listConversations().then(setItems).catch(() => setItems([]));
  }, [reloadKey]);

  const refresh = () => listConversations().then(setItems).catch(() => {});

  return (
    <aside className="history-sidebar">
      <div className="history-header">
        <div>
          <div className="eyebrow">Workspace</div>
          <h2>Threads</h2>
        </div>
        <button
          onClick={onNew}
          className="icon-button strong"
          title="New chat"
        >
          +
        </button>
      </div>
      <div className="history-list">
        {items.length === 0 && (
          <div className="empty-note">No conversations yet.</div>
        )}
        {items.map((c) => (
          <div
            key={c.id}
            className={`history-item ${c.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(c)}
          >
            <span className="history-title">{c.title}</span>
            <button
              title="Rename"
              className="history-action"
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
              className="history-action danger"
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
    </aside>
  );
}
