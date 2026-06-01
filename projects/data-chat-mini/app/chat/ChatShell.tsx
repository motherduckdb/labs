'use client';

import { useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { SchemaExplorerSidebar } from './SchemaExplorerSidebar';

export function ChatShell() {
  const [database] = useState('nba_box_scores_v2');

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <strong>data-chat-mini</strong>
          <span>{database}</span>
        </div>
      </header>
      <div className="workspace-grid">
        <ChatPanel database={database} />
        <SchemaExplorerSidebar database={database} />
      </div>
    </main>
  );
}
