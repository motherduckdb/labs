'use client';

import { useEffect, useState } from 'react';
import { listConversations, deleteConversation } from '@/lib/chat-storage';
import type { ConversationSummary } from '@/types/chat';

export function ChatHistorySidebar({
  activeId,
  reloadKey,
  onSelect,
  onNew,
}: {
  activeId: string | null;
  reloadKey: number;
  onSelect: (conversation: ConversationSummary) => void;
  onNew: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    listConversations().then(setItems).catch(() => setItems([]));
  }, [reloadKey]);

  return (
    <aside className="history-panel">
      <button className="new-chat" onClick={onNew}>New chat</button>
      {items.map((item) => (
        <div className={activeId === item.id ? 'history-row active' : 'history-row'} key={item.id}>
          <button onClick={() => onSelect(item)}>{item.title}</button>
          <button
            aria-label={`Delete ${item.title}`}
            onClick={async () => {
              await deleteConversation(item.id);
              setItems(await listConversations());
            }}
          >
            x
          </button>
        </div>
      ))}
    </aside>
  );
}
