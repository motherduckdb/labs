'use client';

import { useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { SchemaExplorerSidebar } from './SchemaExplorerSidebar';

export function ChatShell() {
  const [database] = useState('nba_box_scores_v2');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <strong>data-chat-mini</strong>
          <span>{database}</span>
        </div>
      </header>
      <div className="workspace-grid">
        <ChatHistorySidebar
          activeId={conversationId}
          reloadKey={historyReloadKey}
          onSelect={(conversation) => setConversationId(conversation.id)}
          onNew={() => setConversationId(null)}
        />
        <ChatPanel
          database={database}
          conversationId={conversationId}
          onConversationChange={setConversationId}
          onSaved={() => setHistoryReloadKey((key) => key + 1)}
        />
        <SchemaExplorerSidebar database={database} />
      </div>
    </main>
  );
}
