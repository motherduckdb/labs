import { describe, expect, it } from 'vitest';
import { CONTEXT_PLACEHOLDER } from './context-tools';
import {
  patchHistoryPlaceholders,
  rebuildHistoryFromMessages,
  type LlmTurn,
} from './chat-history-replay';
import type { ChatMessage } from '@/types/chat';

describe('chat-history-replay', () => {
  it('rebuilds structured tool turns when reopening a saved conversation', () => {
    const turnHistory: LlmTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'query', input: { sql: 'select 1' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: '{"rows":[{"x":1}]}' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    ];
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'run a query', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: 2, turnHistory },
    ];

    expect(rebuildHistoryFromMessages(messages)).toEqual([
      { role: 'user', content: 'run a query' },
      ...turnHistory,
    ]);
  });

  it('patches resolved context results into placeholder tool history', () => {
    const history: LlmTurn[] = [
      { role: 'user', content: 'remember the join' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'ctx_1', name: 'query_context_layer', input: { query: 'join' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'ctx_1', content: CONTEXT_PLACEHOLDER },
        ],
      },
    ];

    patchHistoryPlaceholders(history, [
      { callId: 'ctx_1', resultText: 'No saved context fragments matched.', isError: false },
    ]);

    const patched = history[2].content as Array<Record<string, unknown>>;
    expect(patched[0].content).toBe('No saved context fragments matched.');
    expect(patched[0].is_error).toBeUndefined();
  });

  it('keeps persisted assistant turnHistory reusable after a context round-trip', () => {
    const turnHistory: LlmTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'ctx_1', name: 'query_context_layer', input: { query: 'join' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'ctx_1', content: CONTEXT_PLACEHOLDER },
        ],
      },
    ];
    patchHistoryPlaceholders(turnHistory, [
      { callId: 'ctx_1', resultText: '1 context fragment:\n\n### Join key', isError: false },
    ]);

    const reopened = rebuildHistoryFromMessages([
      { id: 'u1', role: 'user', content: 'use the saved join', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, turnHistory },
    ]);

    expect(JSON.stringify(reopened)).not.toContain(CONTEXT_PLACEHOLDER);
    expect(JSON.stringify(reopened)).toContain('Join key');
  });
});
