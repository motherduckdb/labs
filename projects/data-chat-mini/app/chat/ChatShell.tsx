'use client';

import { useState } from 'react';
import { DatabasePicker } from './DatabasePicker';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { SchemaExplorerSidebar } from './SchemaExplorerSidebar';
import { ChatPanel } from './ChatPanel';
import type { ThinkingLevel } from '@/types/chat';

const THINKING_LEVELS: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// Default to `none` for an external demo — keeps raw upstream reasoning out of
// the request entirely. Override via NEXT_PUBLIC_DEFAULT_THINKING_LEVEL.
const DEFAULT_THINKING = (process.env.NEXT_PUBLIC_DEFAULT_THINKING_LEVEL as ThinkingLevel) || 'none';

export function ChatShell() {
  const [database, setDatabase] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [contextReloadKey, setContextReloadKey] = useState(0);

  if (!database) {
    return (
      <div className="h-screen">
        <DatabasePicker onPick={setDatabase} />
      </div>
    );
  }

  const databases = [database];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-[var(--border)] bg-white px-4 py-2 shrink-0">
        <span className="font-bold text-sm">data-chat-mini</span>
        <span className="text-xs text-[var(--muted)]">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)] mr-1 align-middle" />
          {database}
        </span>
        <button
          onClick={() => setDatabase(null)}
          className="text-xs text-[var(--muted)] hover:text-black underline"
        >
          switch
        </button>
        <div className="flex-1" />
        <label className="text-xs text-[var(--muted)] flex items-center gap-1">
          thinking
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            className="rounded border border-[var(--border)] px-1 py-0.5 text-xs"
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
      </header>

      <div className="flex flex-1 min-h-0">
        <ChatHistorySidebar
          activeId={conversationId}
          reloadKey={historyReloadKey}
          onSelect={setConversationId}
          onNew={() => setConversationId(null)}
        />
        <ChatPanel
          databases={databases}
          thinkingLevel={thinkingLevel}
          conversationId={conversationId}
          onConversationChange={setConversationId}
          onContextChanged={() => setContextReloadKey((k) => k + 1)}
          onSaved={() => setHistoryReloadKey((k) => k + 1)}
        />
        <SchemaExplorerSidebar key={database} database={database} contextReloadKey={contextReloadKey} />
      </div>
    </div>
  );
}
