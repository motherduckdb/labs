'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MvizFrame } from '@/app/components/MvizFrame';
import { getSessionId } from '@/lib/session-id';
import { serviceContextTool } from '@/lib/context-store';
import { CONTEXT_PLACEHOLDER } from '@/lib/context-tools';
import { uuid7 } from '@/lib/uuid7';
import {
  loadConversation,
  saveConversation,
  deriveTitle,
} from '@/lib/chat-storage';
import type {
  ChatMessage,
  ContentSegment,
  Step,
  ThinkingLevel,
  ResolvedContextTool,
} from '@/types/chat';

type LlmTurn = { role: string; content: unknown };

export function ChatPanel({
  databases,
  thinkingLevel,
  conversationId,
  onConversationChange,
  onContextChanged,
  onSaved,
}: {
  databases: string[];
  thinkingLevel: ThinkingLevel;
  conversationId: string | null;
  onConversationChange: (id: string) => void;
  onContextChanged: () => void;
  onSaved: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const historyRef = useRef<LlmTurn[]>([]);
  const convIdRef = useRef<string | null>(conversationId);
  const loadedRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      historyRef.current = rebuildHistory(conv.messages);
    })();
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

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
          // Raw upstream reasoning is intentionally NOT surfaced in the UI — we
          // show polished tool/progress steps instead. (Thinking is still
          // captured server-side in controllog telemetry.) A lightweight
          // "reasoning" pulse is enough signal for the user.
          markReasoning(updateAsst, asstId);
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
          }));
        } else if (type === 'mviz_html') {
          insertMviz(updateAsst, asstId, evt.content as string, evt.id as string | undefined);
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
        onContextChanged();
        await stream({ history: [...historyRef.current], message: '', asstId, resolvedContext: resolved });
      }
    },
    [databases, thinkingLevel, updateAsst, onContextChanged],
  );

  const send = useCallback(async () => {
    const text = input.trim();
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
      updateAsst(asstId, (m) => ({ ...m, isStreaming: false }));
      // Persist after state settles.
      setMessages((prev) => {
        void persist(prev);
        return prev;
      });
    }
  }, [input, isStreaming, stream, onConversationChange, persist, updateAsst]);

  return (
    <div className="flex h-full flex-col flex-1 min-w-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl flex flex-col gap-6">
          {messages.length === 0 && (
            <div className="text-center text-[var(--muted)] mt-20">
              <p className="text-sm">Ask a question about <strong>{databases[0]}</strong>.</p>
              <p className="text-xs mt-2">Read-only — I can query, explore the schema, and chart results.</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
        </div>
      </div>

      <div className="border-t border-[var(--border)] bg-white px-6 py-4">
        <div className="mx-auto max-w-3xl flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={`Ask about ${databases[0]}…`}
            className="flex-1 resize-none rounded-md border border-[var(--border)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] max-h-40"
          />
          <button
            onClick={send}
            disabled={isStreaming || !input.trim()}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {isStreaming ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- message rendering -----------------------------------------------------

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-[var(--accent)] px-4 py-2 text-sm text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  const segments = message.segments ?? [];
  const hasContent = segments.length > 0 || (message.steps?.length ?? 0) > 0 || message.content;

  return (
    <div className="flex flex-col gap-2">
      {message.steps && message.steps.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.steps.map((s, i) => (
            <StepView key={i} step={s} />
          ))}
        </div>
      )}
      <div className="prose prose-sm max-w-none">
        {segments.map((seg, i) => (
          <SegmentView key={i} segment={seg} />
        ))}
      </div>
      {message.isStreaming && !hasContent && (
        <div className="text-sm text-[var(--muted)]">Thinking…</div>
      )}
      {message.error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
    return <div className="my-2 text-xs text-[var(--muted)]">Visualizing…</div>;
  }
  if (segment.type === 'mviz') {
    return (
      <div className="my-3 rounded-lg border border-[var(--border)] overflow-hidden not-prose">
        <MvizFrame html={segment.html} />
      </div>
    );
  }
  return null;
}

function StepView({ step }: { step: Step }) {
  if (step.type === 'thinking') {
    // Raw reasoning is deliberately not rendered — just a neutral marker.
    return <div className="text-xs text-[var(--muted)] italic">Reasoning…</div>;
  }
  if (step.type === 'tool') {
    const dot = step.status === 'running' ? '◷' : step.status === 'error' ? '✕' : '✓';
    const color =
      step.status === 'error' ? 'text-red-600' : step.status === 'complete' ? 'text-green-700' : 'text-[var(--muted)]';
    return (
      <details className="text-xs">
        <summary className={`cursor-pointer ${color}`}>
          <span className="mr-1">{dot}</span>
          <code>{step.name}</code>
          {step.args && Object.keys(step.args).length > 0 && (
            <span className="text-[var(--muted)]"> {summarizeArgs(step.args)}</span>
          )}
        </summary>
        {step.result && (
          <pre className="whitespace-pre-wrap mt-1 max-h-48 overflow-auto bg-[var(--panel)] p-2 rounded text-[var(--muted)]">
            {step.result}
          </pre>
        )}
      </details>
    );
  }
  return null;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const sql = args.sql;
  if (typeof sql === 'string') return sql.replace(/\s+/g, ' ').slice(0, 80);
  const parts = Object.entries(args)
    .filter(([k]) => k !== 'new_fragments')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' ').slice(0, 80);
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

/** Flag that the model reasoned, without storing/rendering the raw text. */
function markReasoning(
  update: (id: string, fn: (m: ChatMessage) => ChatMessage) => void,
  id: string,
) {
  update(id, (m) => {
    const steps = m.steps ?? [];
    if (steps.some((s) => s.type === 'thinking')) return m;
    return { ...m, steps: [...steps, { type: 'thinking', content: '' }] };
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

// --- history reconstruction ------------------------------------------------

/** Rebuild LLM-format history from stored display messages. */
function rebuildHistory(messages: ChatMessage[]): LlmTurn[] {
  const out: LlmTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.turnHistory && m.turnHistory.length > 0) {
        out.push(...m.turnHistory);
      } else if (m.content) {
        out.push({ role: 'assistant', content: m.content });
      }
    }
  }
  return out;
}

/** Replace placeholder context tool_results in history with resolved text. */
function patchHistoryPlaceholders(history: LlmTurn[], resolved: ResolvedContextTool[]) {
  const byId = new Map(resolved.map((r) => [r.callId, r]));
  for (const turn of history) {
    if (turn.role !== 'user' || !Array.isArray(turn.content)) continue;
    for (const block of turn.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.content === CONTEXT_PLACEHOLDER) {
        const r = byId.get(block.tool_use_id as string);
        if (r) {
          block.content = r.resultText;
          if (r.isError) block.is_error = true;
        }
      }
    }
  }
}
