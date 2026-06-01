'use client';

import { useState } from 'react';
import { DatabasePicker } from './DatabasePicker';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { SchemaExplorerSidebar } from './SchemaExplorerSidebar';
import { ChatPanel } from './ChatPanel';
import { DemoRail } from './DemoRail';
import { MotherDuckLogo } from './MotherDuckLogo';
import {
  CANONICAL_DEMO_DATABASE,
  getPromptForStep,
  resetDemoWorkspace,
  type DemoModeState,
  type DemoStepId,
} from '@/lib/demo-mode';
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
  const [draftPrompt, setDraftPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [submitPrompt, setSubmitPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [demoMode, setDemoMode] = useState<DemoModeState>({
    enabled: false,
    replay: false,
    activeStepId: 'pick-database',
  });

  // A conversation belongs to the database it was started under. Switching or
  // (re)picking a database must drop the active conversation so a chat from
  // database A can't be resumed under database B's prompt/context.
  const pickDatabase = (db: string) => {
    setDatabase(db);
    setConversationId(null);
  };

  const startDemo = (replay: boolean) => {
    setDemoMode({ enabled: true, replay, activeStepId: 'pick-database' });
    pickDatabase(CANONICAL_DEMO_DATABASE);
  };

  // Selecting a conversation from history switches to the database it was
  // started under, keeping its prompt/context consistent.
  const openConversation = (summary: { id: string; databases: string[] }) => {
    const db = summary.databases[0];
    if (db && db !== database) setDatabase(db);
    setConversationId(summary.id);
  };

  if (!database) {
    return (
      <div className="h-screen">
        <DatabasePicker onPick={pickDatabase} onStartDemo={startDemo} />
      </div>
    );
  }

  const databases = [database];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <MotherDuckLogo />
          <div>
            <span className="brand-name">data-chat-mini</span>
            <span className="brand-subtitle">Infrastructure for workshop answers</span>
          </div>
        </div>
        <span className="db-chip">
          <span />
          {database}
        </span>
        <button
          onClick={() => { setDatabase(null); setConversationId(null); }}
          className="ghost-button"
        >
          Switch
        </button>
        <button
          onClick={() => setDemoMode((mode) => ({ ...mode, enabled: !mode.enabled }))}
          className={demoMode.enabled ? 'solid-button compact' : 'ghost-button'}
        >
          Demo
        </button>
        <label className="thinking-control">
          Thinking
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
          >
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
      </header>

      <div className={`workspace-grid ${demoMode.enabled ? 'with-demo' : ''}`}>
        <ChatHistorySidebar
          activeId={conversationId}
          reloadKey={historyReloadKey}
          onSelect={openConversation}
          onNew={() => setConversationId(null)}
        />
        {demoMode.enabled && (
          <DemoRail
            demoMode={demoMode}
            onStepChange={(id) => setDemoMode((mode) => ({ ...mode, activeStepId: id }))}
            onInsertPrompt={(text) => setDraftPrompt({ text, nonce: Date.now() })}
            onReplayStep={(id) => {
              const text = getPromptForStep(id);
              if (!text) return;
              setSubmitPrompt({ text, nonce: Date.now() });
            }}
            onToggleReplay={(replay) => setDemoMode((mode) => ({ ...mode, replay }))}
            onReset={async () => {
              if (!window.confirm('Clear local conversations and saved context for a fresh workshop run?')) return;
              await resetDemoWorkspace();
              setConversationId(null);
              setHistoryReloadKey((k) => k + 1);
              setContextReloadKey((k) => k + 1);
              setDemoMode((mode) => ({ ...mode, activeStepId: 'pick-database' }));
            }}
          />
        )}
        <ChatPanel
          databases={databases}
          thinkingLevel={thinkingLevel}
          conversationId={conversationId}
          draftPrompt={draftPrompt}
          submitPrompt={submitPrompt}
          demoMode={demoMode}
          onConversationChange={setConversationId}
          onContextChanged={() => setContextReloadKey((k) => k + 1)}
          onSaved={() => setHistoryReloadKey((k) => k + 1)}
          onDemoStepComplete={(id: DemoStepId) => {
            setDemoMode((mode) => {
              if (!mode.enabled || mode.activeStepId !== id) return mode;
              if (id === 'inspect-schema') return { ...mode, activeStepId: 'adversarial-grain' };
              if (id === 'adversarial-grain') return { ...mode, activeStepId: 'chart-with-context' };
              if (id === 'chart-with-context') return { ...mode, activeStepId: 'unsupported-injuries' };
              if (id === 'unsupported-injuries') return { ...mode, activeStepId: 'reset-workshop' };
              return mode;
            });
          }}
        />
        <SchemaExplorerSidebar
          key={database}
          database={database}
          contextReloadKey={contextReloadKey}
          demoReplay={demoMode.enabled && demoMode.replay && database === CANONICAL_DEMO_DATABASE}
        />
      </div>
    </div>
  );
}
