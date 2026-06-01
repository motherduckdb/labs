import { beforeEach, describe, expect, it, vi } from 'vitest';

const idb = vi.hoisted(() => ({
  mem: new Map<string, unknown>(),
}));

vi.mock('idb-keyval', () => ({
  createStore: vi.fn((dbName: string, storeName: string) => ({ dbName, storeName })),
  get: vi.fn(async (key: string, store: { dbName: string; storeName: string }) =>
    idb.mem.get(`${store.dbName}:${store.storeName}:${key}`),
  ),
  set: vi.fn(async (key: string, val: unknown, store: { dbName: string; storeName: string }) => {
    idb.mem.set(`${store.dbName}:${store.storeName}:${key}`, val);
  }),
  del: vi.fn(async (key: string, store: { dbName: string; storeName: string }) => {
    idb.mem.delete(`${store.dbName}:${store.storeName}:${key}`);
  }),
}));

import {
  CANONICAL_DEMO_DATABASE,
  DEMO_STEPS,
  applyReplaySideEffects,
  getPromptForStep,
  getReplayTurnForPrompt,
  resetDemoWorkspace,
} from './demo-mode';
import { listFragments } from './context-store';
import { listConversations, saveConversation } from './chat-storage';

beforeEach(() => {
  idb.mem.clear();
});

describe('demo-mode', () => {
  it('defines the guided NBA presenter flow with one-click prompts', () => {
    expect(DEMO_STEPS.map((step) => step.id)).toEqual([
      'pick-database',
      'inspect-schema',
      'adversarial-grain',
      'chart-with-context',
      'unsupported-injuries',
      'reset-workshop',
    ]);
    expect(getPromptForStep('inspect-schema')).toContain(CANONICAL_DEMO_DATABASE);
    expect(getPromptForStep('unsupported-injuries')).toMatch(/injured players/i);
    expect(DEMO_STEPS.find((step) => step.id === 'adversarial-grain')?.expectedActivity).toEqual(
      expect.arrayContaining(['context read', 'SQL query', 'context write', 'mviz render', 'final answer']),
    );
  });

  it('builds replay turns from the deterministic validation transcript', () => {
    const replay = getReplayTurnForPrompt(getPromptForStep('chart-with-context'), 123);

    expect(replay?.step.id).toBe('chart-with-context');
    expect(replay?.userMessage.content).toBe(getPromptForStep('chart-with-context'));
    expect(replay?.assistantMessage.segments?.some((segment) => segment.type === 'mviz')).toBe(true);
    expect(replay?.assistantMessage.steps?.map((step) => step.type === 'tool' ? step.name : step.type)).toEqual(
      expect.arrayContaining(['query_context_layer (local)', 'query', 'mviz_render', 'final_answer']),
    );
    expect(replay?.assistantMessage.content).toMatch(/saved grain context/i);
  });

  it('applies replay context side effects without duplicating durable fragments', async () => {
    await applyReplaySideEffects('inspect-schema');
    await applyReplaySideEffects('inspect-schema');
    await applyReplaySideEffects('adversarial-grain');

    const fragments = await listFragments();
    expect(fragments.map((fragment) => fragment.title).sort()).toEqual([
      'box_scores to schedule join key',
      'full-game team scoring grain',
    ]);
    expect(fragments.find((fragment) => fragment.title === 'full-game team scoring grain')?.content).toMatch(
      /player_name IS NULL/,
    );
  });

  it('resets browser-local conversations and context for a fresh workshop run', async () => {
    await saveConversation({
      id: 'conv-demo',
      title: 'Demo run',
      createdAt: 1,
      updatedAt: 2,
      databases: [CANONICAL_DEMO_DATABASE],
      thinkingLevel: 'none',
      messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }],
    });
    await applyReplaySideEffects('inspect-schema');

    expect(await listConversations()).toHaveLength(1);
    expect(await listFragments()).toHaveLength(1);

    await resetDemoWorkspace();

    expect(await listConversations()).toHaveLength(0);
    expect(await listFragments()).toHaveLength(0);
  });
});
