'use client';

import { useEffect, useRef, useState } from 'react';
import { MvizFrame } from '@/app/components/MvizFrame';
import { getSessionId } from '@/lib/session-id';
import { serviceContextTool } from '@/lib/context-store';
import { deriveTitle, loadConversation, saveConversation } from '@/lib/chat-storage';
import type { ChatMessage, ResolvedContextTool, StreamEvent } from '@/types/chat';

export function ChatPanel({
  database,
  conversationId,
  onConversationChange,
  onSaved,
}: {
  database: string;
  conversationId: string | null;
  onConversationChange: (id: string) => void;
  onSaved: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('How many games are in the schedule table?');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<Array<{ role: string; content: unknown }>>([]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      historyRef.current = [];
      return;
    }
    loadConversation(conversationId).then((conversation) => setMessages(conversation?.messages || []));
    historyRef.current = [];
  }, [conversationId]);

  const persist = async (id: string, nextMessages: ChatMessage[]) => {
    const now = Date.now();
    await saveConversation({
      id,
      title: deriveTitle(nextMessages),
      createdAt: now,
      updatedAt: now,
      databases: [database],
      messages: nextMessages,
    });
    onSaved();
  };

  const updateAssistant = (id: string, updater: (message: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((message) => message.id === id ? updater(message) : message));
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  };

  const stream = async (params: {
    message: string;
    assistantId: string;
    resolvedContext?: ResolvedContextTool[];
  }) => {
    const contextCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: params.message,
        history: historyRef.current,
        databases: [database],
        sessionId: getSessionId(),
        ...(params.resolvedContext && { resolvedContext: params.resolvedContext }),
      }),
    });
    if (!response.ok || !response.body) {
      updateAssistant(params.assistantId, (message) => ({ ...message, error: `HTTP ${response.status}` }));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handle = (event: StreamEvent) => {
      if (event.type === 'text') {
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          content: message.content + (event.content || ''),
          segments: [...(message.segments || []), { type: 'text', text: event.content || '' }],
        }));
      } else if (event.type === 'tool_start' && event.toolCall) {
        const tool = event.toolCall;
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          steps: [...(message.steps || []), {
            id: tool.id,
            name: tool.name,
            status: 'running',
            args: tool.args,
          }],
        }));
      } else if (event.type === 'tool_end' && event.toolCall) {
        const tool = event.toolCall;
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          steps: (message.steps || []).map((step) => step.id === tool.id
            ? { ...step, status: tool.error ? 'error' : 'complete', result: tool.result }
            : step),
        }));
      } else if (event.type === 'context_tool' && event.contextCall) {
        contextCalls.push(event.contextCall);
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          steps: [...(message.steps || []), {
            id: event.contextCall!.callId,
            name: `${event.contextCall!.name} (local)`,
            status: 'running',
            args: event.contextCall!.args,
          }],
        }));
      } else if (event.type === 'turn_complete' && event.turnHistory) {
        historyRef.current.push(...event.turnHistory);
      } else if (event.type === 'error') {
        updateAssistant(params.assistantId, (message) => ({ ...message, error: event.content }));
      } else if (event.type === 'mviz_pending' && event.id) {
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          segments: [...(message.segments || []), { type: 'mviz_pending', id: event.id! }],
          steps: [...(message.steps || []), {
            id: `mviz:${event.id}`,
            name: 'mviz_render',
            status: 'running',
            args: { output: 'inline visualization' },
          }],
        }));
      } else if (event.type === 'mviz_html') {
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          segments: (message.segments || []).map((segment) =>
            segment.type === 'mviz_pending' && (!event.id || segment.id === event.id)
              ? { type: 'mviz', id: event.id, html: event.content || '' }
              : segment,
          ),
          steps: (message.steps || []).map((step) =>
            step.id === `mviz:${event.id}`
              ? { ...step, status: 'complete', result: 'Rendered inline visualization.' }
              : step,
          ),
        }));
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
        try { handle(JSON.parse(data)); } catch { /* ignore malformed chunks */ }
      }
    }

    if (contextCalls.length > 0) {
      const resolved: ResolvedContextTool[] = [];
      for (const call of contextCalls) {
        const result = await serviceContextTool(call.name, call.args);
        resolved.push({ callId: call.callId, resultText: result.resultText, isError: result.isError });
        updateAssistant(params.assistantId, (message) => ({
          ...message,
          steps: (message.steps || []).map((step) => step.id === call.callId
            ? { ...step, status: result.isError ? 'error' : 'complete', result: result.resultText }
            : step),
        }));
      }
      await stream({ message: '', assistantId: params.assistantId, resolvedContext: resolved });
    }
  };

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const activeId = conversationId || crypto.randomUUID();
    if (!conversationId) onConversationChange(activeId);

    const user: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed, timestamp: Date.now() };
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', steps: [], timestamp: Date.now() };
    const startingMessages = [...messages, user, assistant];
    setMessages(startingMessages);
    setInput('');
    setIsStreaming(true);

    try {
      await stream({ message: trimmed, assistantId: assistant.id });
    } finally {
      setIsStreaming(false);
      setMessages((latest) => {
        persist(activeId, latest).catch((error) => console.error('[history] save failed', error));
        return latest;
      });
    }
  };

  return (
    <section className="chat-panel">
      <div className="messages" ref={scrollRef}>
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="role">{message.role}</div>
            {message.steps && message.steps.length > 0 && (
              <div className="steps">
                {message.steps.map((step) => (
                  <details key={step.id} open={step.status === 'running'}>
                    <summary>{step.status} · {step.name}</summary>
                    {step.args && <pre>{JSON.stringify(step.args, null, 2)}</pre>}
                    {step.result && <pre>{step.result}</pre>}
                  </details>
                ))}
              </div>
            )}
            {message.segments && message.segments.length > 0 ? (
              <div className="segments">
                {message.segments.map((segment, index) => {
                  if (segment.type === 'text') return <p key={index}>{segment.text}</p>;
                  if (segment.type === 'mviz_pending') return <p key={segment.id}>Rendering chart...</p>;
                  return <MvizFrame html={segment.html} key={segment.id || index} />;
                })}
              </div>
            ) : (
              <p>{message.content}</p>
            )}
            {message.error && <p className="error">{message.error}</p>}
          </article>
        ))}
      </div>
      <div className="composer">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} />
        <button onClick={submit} disabled={isStreaming}>{isStreaming ? 'Running...' : 'Send'}</button>
      </div>
    </section>
  );
}
