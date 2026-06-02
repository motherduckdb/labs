'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MvizFrame } from '@/app/components/MvizFrame';
import { getSessionId } from '@/lib/session-id';
import { serviceContextTool } from '@/lib/context-store';
import { uuid7 } from '@/lib/uuid7';
import {
  applyReplaySideEffects,
  getReplayTurnForPrompt,
  type DemoModeState,
  type DemoStepId,
} from '@/lib/demo-mode';
import {
  loadConversation,
  saveConversation,
  deriveTitle,
} from '@/lib/chat-storage';
import {
  rebuildHistoryFromMessages,
  patchHistoryPlaceholders,
  type LlmTurn,
} from '@/lib/chat-history-replay';
import type {
  ChatMessage,
  ContentSegment,
  Step,
  ThinkingLevel,
  ResolvedContextTool,
} from '@/types/chat';

const THINKING_LEVELS: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function ChatPanel({
  databases,
  thinkingLevel,
  onThinkingLevelChange,
  conversationId,
  draftPrompt,
  submitPrompt,
  demoMode,
  onConversationChange,
  onContextChanged,
  onSaved,
  onDemoStepComplete,
}: {
  databases: string[];
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  conversationId: string | null;
  draftPrompt?: { text: string; nonce: number } | null;
  submitPrompt?: { text: string; nonce: number } | null;
  demoMode?: DemoModeState;
  onConversationChange: (id: string) => void;
  onContextChanged: () => void;
  onSaved: () => void;
  onDemoStepComplete?: (id: DemoStepId) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const historyRef = useRef<LlmTurn[]>([]);
  const convIdRef = useRef<string | null>(conversationId);
  const loadedRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const submittedPromptNonceRef = useRef<number | null>(null);

  // Load (or reset) when the active conversation changes.
  useEffect(() => {
    convIdRef.current = conversationId;
    if (!conversationId) {
      setMessages([]);
      historyRef.current = [];
      loadedRef.current = null;
      return;
    }
    if (loadedRef.current === conversationId) return;
    loadedRef.current = conversationId;
    (async () => {
      const conv = await loadConversation(conversationId);
      if (!conv) {
        setMessages([]);
        historyRef.current = [];
        return;
      }
      setMessages(conv.messages);
      historyRef.current = rebuildHistoryFromMessages(conv.messages);
      // Restore the conversation's saved thinking level into the shell-level
      // control. Without this, reopening a conversation keeps the shell's
      // current level and the next send re-persists it, silently overwriting
      // the conversation's original privacy/cost choice.
      if (conv.thinkingLevel) onThinkingLevelChange(conv.thinkingLevel);
    })();
  }, [conversationId, onThinkingLevelChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!draftPrompt?.text) return;
    setInput(draftPrompt.text);
  }, [draftPrompt]);

  const updateAsst = useCallback((id: string, updater: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
  }, []);

  const persist = useCallback(
    async (msgs: ChatMessage[]) => {
      const id = convIdRef.current;
      if (!id) return;
      const now = Date.now();
      try {
        await saveConversation({
          id,
          title: deriveTitle(msgs),
          createdAt: now,
          updatedAt: now,
          databases,
          thinkingLevel,
          messages: msgs,
        });
        // Notify the parent only after the write lands, so the history
        // sidebar reloads an index that actually contains this conversation.
        onSaved();
      } catch (e) {
        console.error('[ChatPanel] save failed', e);
      }
    },
    [databases, thinkingLevel, onSaved],
  );

  /** One streaming request → response. Recurses for the context round-trip. */
  const stream = useCallback(
    async (params: { history: LlmTurn[]; message: string; asstId: string; resolvedContext?: ResolvedContextTool[] }) => {
      const { asstId } = params;
      const contextCalls: { callId: string; name: string; args: Record<string, unknown> }[] = [];

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: params.message,
          history: params.history,
          databases,
          thinkingLevel,
          sessionId: getSessionId(),
          ...(params.resolvedContext && { resolvedContext: params.resolvedContext }),
        }),
      });

      if (!res.ok || !res.body) {
        updateAsst(asstId, (m) => ({ ...m, error: `Request failed (HTTP ${res.status})`, isStreaming: false }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (evt: Record<string, unknown>) => {
        const type = evt.type as string;
        if (type === 'text') {
          appendText(updateAsst, asstId, evt.content as string);
        } else if (type === 'thinking') {
          // The default thinking level is `medium`, so reasoning streams by
          // default — and therefore flows to OpenRouter, IndexedDB history, and
          // controllog. Set it to `none` (or NEXT_PUBLIC_DEFAULT_THINKING_LEVEL)
          // to suppress reasoning entirely. We render whatever streams in a
          // collapsed block (and controllog captures it regardless).
          appendThinking(updateAsst, asstId, evt.content as string);
        } else if (type === 'tool_start') {
          const tc = evt.toolCall as { id: string; name: string; args?: Record<string, unknown> };
          updateAsst(asstId, (m) => ({
            ...m,
            steps: [...(m.steps ?? []), { type: 'tool', id: tc.id, name: tc.name, status: 'running', args: tc.args }],
          }));
        } else if (type === 'tool_end') {
          const tc = evt.toolCall as { id: string; name: string; result?: string; error?: boolean };
          updateAsst(asstId, (m) => ({
            ...m,
            steps: (m.steps ?? []).map((s) =>
              s.type === 'tool' && s.id === tc.id
                ? { ...s, status: tc.error ? 'error' : 'complete', result: tc.result }
                : s,
            ),
          }));
        } else if (type === 'context_tool') {
          const c = evt.contextCall as { callId: string; name: string; args: Record<string, unknown> };
          contextCalls.push(c);
          updateAsst(asstId, (m) => ({
            ...m,
            steps: [
              ...(m.steps ?? []),
              { type: 'tool', id: c.callId, name: `${c.name} (local)`, status: 'running', args: c.args },
            ],
          }));
        } else if (type === 'mviz_pending') {
          updateAsst(asstId, (m) => ({
            ...m,
            segments: [...(m.segments ?? []), { type: 'mviz_pending', id: evt.id as string }],
            steps: [
              ...(m.steps ?? []),
              {
                type: 'tool',
                id: `mviz:${evt.id as string}`,
                name: 'mviz_render',
                status: 'running',
                args: { output: 'inline visualization' },
              },
            ],
          }));
        } else if (type === 'mviz_html') {
          insertMviz(updateAsst, asstId, evt.content as string, evt.id as string | undefined);
          updateAsst(asstId, (m) => ({
            ...m,
            steps: (m.steps ?? []).map((s) =>
              s.type === 'tool' && s.id === `mviz:${evt.id as string}`
                ? {
                    ...s,
                    status: 'complete',
                    result: `Rendered mviz artifact (${typeof evt.content === 'string' ? evt.content.length : 0} bytes).`,
                  }
                : s,
            ),
          }));
        } else if (type === 'turn_complete') {
          const th = evt.turnHistory as LlmTurn[];
          historyRef.current.push(...th);
          // Persist the structured turn on the assistant message so a chat
          // reopened from IndexedDB still carries the tool_use/tool_result
          // turns (rebuildHistory relies on m.turnHistory). Accumulate across
          // the multiple turn_complete events a context round-trip produces.
          updateAsst(asstId, (m) => ({ ...m, turnHistory: [...(m.turnHistory ?? []), ...th] }));
        } else if (type === 'error') {
          updateAsst(asstId, (m) => ({ ...m, error: evt.content as string }));
        } else if (type === 'auth_expired') {
          updateAsst(asstId, (m) => ({ ...m, error: evt.content as string }));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(data); } catch { continue; }
          handle(evt);
        }
      }

      // Context round-trip: service each intercepted call locally, patch the
      // placeholder in our LLM history, then resume the loop.
      if (contextCalls.length > 0) {
        const resolved: ResolvedContextTool[] = [];
        for (const c of contextCalls) {
          const { resultText, isError } = await serviceContextTool(c.name, c.args);
          resolved.push({ callId: c.callId, resultText, isError });
          updateAsst(asstId, (m) => ({
            ...m,
            steps: (m.steps ?? []).map((s) =>
              s.type === 'tool' && s.id === c.callId
                ? { ...s, status: isError ? 'error' : 'complete', result: resultText }
                : s,
            ),
          }));
        }
        // Patch the placeholder tool_result(s) in our local history so future
        // turns send the resolved text, not the placeholder.
        patchHistoryPlaceholders(historyRef.current, resolved);
        // Patch the assistant message copy too; this is what IndexedDB persists
        // and what rebuilds history when a conversation is reopened.
        updateAsst(asstId, (m) => {
          const turnHistory = (m.turnHistory ?? []).map((turn) => ({
            ...turn,
            content: Array.isArray(turn.content)
              ? turn.content.map((block) => ({ ...block }))
              : turn.content,
          }));
          patchHistoryPlaceholders(turnHistory, resolved);
          return { ...m, turnHistory };
        });
        onContextChanged();
        await stream({ history: [...historyRef.current], message: '', asstId, resolvedContext: resolved });
      }
    },
    [databases, thinkingLevel, updateAsst, onContextChanged],
  );

  const sendText = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || isStreaming) return;

    // Lazily mint a conversation id for a fresh chat.
    if (!convIdRef.current) {
      const id = uuid7();
      convIdRef.current = id;
      loadedRef.current = id;
      onConversationChange(id);
    }

    setInput('');
    setIsStreaming(true);

    if (demoMode?.enabled && demoMode.replay) {
      const replay = getReplayTurnForPrompt(text);
      const userMsg: ChatMessage = replay?.userMessage ?? {
        id: uuid7(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };
      const asstMsg: ChatMessage = replay?.assistantMessage ?? {
        id: uuid7(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        error: 'No deterministic replay is available for that prompt. Use one of the guided NBA prompts or switch Demo Mode to Live.',
        steps: [
          {
            type: 'tool',
            id: 'final:missing-replay',
            name: 'final_answer',
            status: 'error',
            result: 'Replay prompt did not match the deterministic validation transcript.',
          },
        ],
      };
      setMessages((prev) => [...prev, userMsg, asstMsg]);
      historyRef.current.push({ role: 'user', content: text }, ...(asstMsg.turnHistory ?? []));

      try {
        if (replay) {
          await applyReplaySideEffects(replay.step.id);
          onDemoStepComplete?.(replay.step.id);
          onContextChanged();
        }
      } finally {
        setIsStreaming(false);
        setMessages((prev) => {
          void persist(prev);
          return prev;
        });
      }
      return;
    }

    const userMsg: ChatMessage = { id: uuid7(), role: 'user', content: text, timestamp: Date.now() };
    const asstId = uuid7();
    const asstMsg: ChatMessage = {
      id: asstId, role: 'assistant', content: '', timestamp: Date.now(),
      isStreaming: true, segments: [], steps: [],
    };
    setMessages((prev) => [...prev, userMsg, asstMsg]);

    const historySnapshot = [...historyRef.current];
    historyRef.current.push({ role: 'user', content: text });

    try {
      await stream({ history: historySnapshot, message: text, asstId });
    } catch (err) {
      updateAsst(asstId, (m) => ({ ...m, error: err instanceof Error ? err.message : 'Stream error' }));
    } finally {
      setIsStreaming(false);
      updateAsst(asstId, (m) => ({ ...m, isStreaming: false, steps: ensureFinalAnswerStep(m.steps ?? []) }));
      // Persist after state settles.
      setMessages((prev) => {
        void persist(prev);
        return prev;
      });
    }
  }, [
    demoMode,
    input,
    isStreaming,
    stream,
    onConversationChange,
    persist,
    updateAsst,
    onContextChanged,
    onDemoStepComplete,
  ]);

  useEffect(() => {
    if (!submitPrompt?.text || submittedPromptNonceRef.current === submitPrompt.nonce) return;
    submittedPromptNonceRef.current = submitPrompt.nonce;
    void sendText(submitPrompt.text);
  }, [submitPrompt, sendText]);

  return (
    <main className="chat-panel">
      <div ref={scrollRef} className="message-scroll">
        <div className="message-stack">
          {messages.length === 0 && (
            <div className="empty-chat">
              <div className="answer-chip">Read-only MCP · traceable SQL · mviz</div>
              <h1>Ask {databases[0]} a data question.</h1>
              <p>
                The assistant can inspect schema, run safe SQL, save local context, and render charts inline.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
            rows={1}
            placeholder={`Ask about ${databases[0]}…`}
          />
          <button
            onClick={() => void sendText()}
            disabled={isStreaming || !input.trim()}
            className="send-button"
            title="Send"
            aria-label="Send message"
          >
            {isStreaming ? <span className="send-loading" /> : <SendIcon />}
          </button>
        </div>
        <div className="composer-meta">
          <label className="thinking-control">
            <BrainIcon />
            <span>Thinking</span>
            <select
              value={thinkingLevel}
              onChange={(e) => onThinkingLevelChange(e.target.value as ThinkingLevel)}
            >
              {THINKING_LEVELS.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </main>
  );
}

// --- message rendering -----------------------------------------------------

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="message-row user">
        <div className="user-bubble">
          {message.content}
        </div>
      </div>
    );
  }

  const segments = message.segments ?? [];
  const hasContent = segments.length > 0 || (message.steps?.length ?? 0) > 0 || message.content;

  return (
    <div className="message-row assistant">
      {message.steps && message.steps.length > 0 && (
        <div className="tool-timeline">
          {message.steps.map((s, i) => (
            <StepView key={i} step={s} />
          ))}
        </div>
      )}
      <div className="assistant-label">Assistant</div>
      <div className="assistant-content prose prose-sm max-w-none">
        {segments.map((seg, i) => (
          <SegmentView key={i} segment={seg} />
        ))}
      </div>
      {message.isStreaming && !hasContent && (
        <div className="loading-answer">Preparing answer…</div>
      )}
      {message.error && (
        <div className="error-card">
          {message.error}
        </div>
      )}
    </div>
  );
}

function SegmentView({ segment }: { segment: ContentSegment }) {
  if (segment.type === 'text') {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.text}</ReactMarkdown>
    );
  }
  if (segment.type === 'mviz_pending') {
    return <div className="mviz-pending">Rendering visualization…</div>;
  }
  if (segment.type === 'mviz') {
    return (
      <div className="mviz-shell not-prose">
        <MvizFrame html={segment.html} />
      </div>
    );
  }
  return null;
}

function StepView({ step }: { step: Step }) {
  if (step.type === 'thinking') {
    if (!step.content) return <div className="timeline-row muted">Reasoning hidden by default…</div>;
    return (
      <details className="timeline-row details">
        <summary>Reasoning details</summary>
        <pre>
          {step.content}
        </pre>
      </details>
    );
  }
  if (step.type === 'tool') {
    const meta = toolMeta(step.name);
    const status = step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'done';
    const hasArgs = step.args && Object.keys(step.args).length > 0;
    return (
      <details className={`timeline-row details ${status}`}>
        <summary>
          <span className="timeline-dot" />
          <span className="timeline-main">
            <span className="timeline-title">{meta.label}</span>
            <span className="timeline-subtitle">
              <code>{cleanToolName(step.name)}</code>
              {hasArgs && <span>{summarizeArgs(step.args!)}</span>}
            </span>
          </span>
          <span className="timeline-status">{status}</span>
        </summary>
        <div className="timeline-detail">
          <p>{meta.description}</p>
          {hasArgs && (
            <div>
              <div className="detail-label">Request</div>
              <pre>
                {formatRequestArgs(step.args!)}
              </pre>
            </div>
          )}
          {step.result && (
            <div>
              <div className="detail-label">Response</div>
              <pre>
                {step.result}
              </pre>
            </div>
          )}
        </div>
      </details>
    );
  }
  return null;
}

function SendIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 8h9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M8.5 4.5 12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3.2v9.6M8 4.2a2 2 0 0 0-3.6-1.2A1.9 1.9 0 0 0 2.6 5 1.9 1.9 0 0 0 2 8a1.9 1.9 0 0 0 .9 2.6A1.9 1.9 0 0 0 4.6 13 2 2 0 0 0 8 12M8 4.2a2 2 0 0 1 3.6-1.2A1.9 1.9 0 0 1 13.4 5a1.9 1.9 0 0 1 .6 3 1.9 1.9 0 0 1-.9 2.6A1.9 1.9 0 0 1 11.4 13 2 2 0 0 1 8 12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function toolMeta(name: string): { label: string; description: string } {
  const clean = cleanToolName(name);
  if (clean === 'list_tables' || clean === 'list_columns' || clean === 'search_catalog') {
    return {
      label: 'Schema exploration',
      description: 'The assistant inspected catalog metadata before claiming what the data can support.',
    };
  }
  if (clean === 'query') {
    return {
      label: 'SQL query',
      description: 'Read-only MotherDuck query. Expand to inspect the exact SQL and result payload.',
    };
  }
  if (clean === 'query_context_layer') {
    return {
      label: 'Context read',
      description: 'Browser-local context lookup using the same tool shape as the MotherDuck context layer.',
    };
  }
  if (clean === 'update_context_layer') {
    return {
      label: 'Context write',
      description: 'Browser-local durable context update; no MotherDuck writes are performed.',
    };
  }
  if (clean === 'mviz_render') {
    return {
      label: 'mviz render',
      description: 'The chart/table fence was converted into an embedded mviz artifact.',
    };
  }
  if (clean === 'final_answer') {
    return {
      label: 'Final answer',
      description: 'Presenter-facing response. Raw model reasoning stays hidden unless explicitly requested.',
    };
  }
  return {
    label: clean.replaceAll('_', ' '),
    description: 'Tool activity from the assistant run.',
  };
}

function cleanToolName(name: string): string {
  return name.replace(' (local)', '');
}

function summarizeArgs(args: Record<string, unknown>): string {
  const sql = args.sql;
  if (typeof sql === 'string') return sql.replace(/\s+/g, ' ').slice(0, 80);
  const parts = Object.entries(args)
    .filter(([k]) => k !== 'new_fragments')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' ').slice(0, 80);
}

/** Full, readable request body for the expanded tool step. Surfaces SQL as-is
 *  (with any other params above it) and pretty-prints everything else. */
function formatRequestArgs(args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...args };
  delete rest.new_fragments; // internal noise the model is forced to pass
  if (typeof rest.sql === 'string') {
    const sql = rest.sql;
    delete rest.sql;
    const others = Object.entries(rest)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
    return others ? `${others}\n\n${sql}` : sql;
  }
  return JSON.stringify(rest, null, 2);
}

// --- streaming helpers -----------------------------------------------------

function appendText(
  update: (id: string, fn: (m: ChatMessage) => ChatMessage) => void,
  id: string,
  text: string,
) {
  update(id, (m) => {
    const segs = [...(m.segments ?? [])];
    const last = segs[segs.length - 1];
    if (last && last.type === 'text') {
      segs[segs.length - 1] = { type: 'text', text: last.text + text };
    } else {
      segs.push({ type: 'text', text });
    }
    return { ...m, segments: segs, content: m.content + text };
  });
}

/** Accumulate streamed reasoning text into a single thinking step. */
function appendThinking(
  update: (id: string, fn: (m: ChatMessage) => ChatMessage) => void,
  id: string,
  text: string,
) {
  update(id, (m) => {
    const steps = [...(m.steps ?? [])];
    const last = steps[steps.length - 1];
    if (last && last.type === 'thinking') {
      steps[steps.length - 1] = { type: 'thinking', content: last.content + text };
    } else {
      steps.push({ type: 'thinking', content: text });
    }
    return { ...m, steps };
  });
}

function insertMviz(
  update: (id: string, fn: (m: ChatMessage) => ChatMessage) => void,
  id: string,
  html: string,
  pendingId?: string,
) {
  update(id, (m) => {
    const segs = [...(m.segments ?? [])];
    if (pendingId) {
      const idx = segs.findIndex((s) => s.type === 'mviz_pending' && s.id === pendingId);
      if (idx !== -1) {
        segs[idx] = { type: 'mviz', html };
        return { ...m, segments: segs };
      }
    }
    segs.push({ type: 'mviz', html });
    return { ...m, segments: segs };
  });
}

function ensureFinalAnswerStep(steps: Step[]): Step[] {
  if (steps.some((step) => step.type === 'tool' && step.name === 'final_answer')) return steps;
  return [
    ...steps,
    {
      type: 'tool',
      id: `final:${steps.length + 1}`,
      name: 'final_answer',
      status: 'complete',
      result: 'Assistant response streamed to the chat.',
    },
  ];
}
