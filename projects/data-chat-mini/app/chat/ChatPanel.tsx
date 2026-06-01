'use client';

import { useRef, useState } from 'react';
import { MvizFrame } from '@/app/components/MvizFrame';
import { getSessionId } from '@/lib/session-id';
import type { StreamEvent } from '@/types/chat';

type ToolStep = {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  args?: Record<string, unknown>;
  result?: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  segments?: Array<{ type: 'text'; text: string } | { type: 'mviz_pending'; id: string } | { type: 'mviz'; id?: string; html: string }>;
  steps?: ToolStep[];
  error?: string;
};

export function ChatPanel({ database }: { database: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('How many games are in the schedule table?');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const updateAssistant = (id: string, updater: (message: Message) => Message) => {
    setMessages((prev) => prev.map((message) => message.id === id ? updater(message) : message));
    queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  };

  const submit = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const user: Message = { id: crypto.randomUUID(), role: 'user', content: trimmed };
    const assistant: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', steps: [] };
    setMessages((prev) => [...prev, user, assistant]);
    setInput('');
    setIsStreaming(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          databases: [database],
          sessionId: getSessionId(),
        }),
      });
      if (!response.ok || !response.body) {
        updateAssistant(assistant.id, (message) => ({ ...message, error: `HTTP ${response.status}` }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (event: StreamEvent) => {
        if (event.type === 'text') {
          updateAssistant(assistant.id, (message) => ({
            ...message,
            content: message.content + (event.content || ''),
            segments: [...(message.segments || []), { type: 'text', text: event.content || '' }],
          }));
        } else if (event.type === 'tool_start' && event.toolCall) {
          const tool = event.toolCall;
          updateAssistant(assistant.id, (message) => ({
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
          updateAssistant(assistant.id, (message) => ({
            ...message,
            steps: (message.steps || []).map((step) => step.id === tool.id
              ? { ...step, status: tool.error ? 'error' : 'complete', result: tool.result }
              : step),
          }));
        } else if (event.type === 'error') {
          updateAssistant(assistant.id, (message) => ({ ...message, error: event.content }));
        } else if (event.type === 'mviz_pending' && event.id) {
          updateAssistant(assistant.id, (message) => ({
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
          updateAssistant(assistant.id, (message) => ({
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
    } finally {
      setIsStreaming(false);
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
