import { NextRequest, after } from 'next/server';
import { getModelProfile } from '@/lib/llm-client';
import { createMCPClient, getFilteredTools, mcpToolsToAnthropicFormat } from '@/lib/mcp-client';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { CONTEXT_TOOLS, CONTEXT_PLACEHOLDER } from '@/lib/context-tools';
import { runAgenticLoop } from '@/lib/agentic-loop';
import * as cl from '@/lib/controllog';
import { sseDone, sseError } from '@/lib/sse-encoder';
import { parseChatRequest } from '@/lib/api-helpers';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const maxDuration = 300;

const logDir = process.env.VERCEL ? '/tmp' : 'logs';
try { cl.init('data-chat-mini', logDir); } catch { /* already initialized */ }

export async function POST(request: NextRequest) {
  let mcpClient: Client | null = null;

  try {
    const parsed = await parseChatRequest(request);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const { message, history, databases, thinkingLevel, sessionId, resolvedContext } = parsed.body;

    const isResume = Array.isArray(resolvedContext) && resolvedContext.length > 0;
    if (!message && !isResume) {
      return Response.json({ error: 'No message provided' }, { status: 400 });
    }

    if (!process.env.MOTHERDUCK_TOKEN) {
      return Response.json({ error: 'Server is missing MOTHERDUCK_TOKEN' }, { status: 500 });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return Response.json({ error: 'Server is missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    // Read scaling: thread the browser session id into the MCP connection as a
    // session hint so concurrent users fan out across read replicas.
    mcpClient = await createMCPClient(sessionId);
    const mcpTools = await getFilteredTools(mcpClient);
    // Context-layer tools are advertised with MotherDuck names but handled
    // locally via the client round-trip — not dispatched to MCP.
    const tools = [...mcpToolsToAnthropicFormat(mcpTools), ...CONTEXT_TOOLS];

    const profile = getModelProfile();
    const systemPrompt = buildSystemPrompt(databases);

    const logSession = cl.createSession(sessionId);
    let markStreamFinished: () => void = () => {};
    const streamFinished = new Promise<void>((resolve) => { markStreamFinished = resolve; });

    after(async () => {
      await streamFinished;
      try {
        await cl.flushSession(logSession);
      } catch (err) {
        console.warn(
          `[Controllog] Flush failed (${logSession.events.length} events, ${logSession.postings.length} postings):`,
          err,
        );
      }
    });

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeEnqueue = (data: Uint8Array) => {
          if (closed) return;
          try { controller.enqueue(data); } catch { closed = true; }
        };
        const safeClose = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        const runStream = async () => {
          const runId = `chat_${Date.now()}`;
          const taskId = `chat:${runId}`;
          try {
            const messages: Array<{ role: string; content: unknown }> =
              history.map(m => ({ role: m.role, content: m.content }));

            if (isResume) {
              // Patch the placeholder tool_result(s) left by the context pause
              // with the results the client computed locally against IndexedDB.
              const byId = new Map(resolvedContext!.map(r => [r.callId, r]));
              for (const m of messages) {
                if (m.role !== 'user' || !Array.isArray(m.content)) continue;
                for (const block of m.content as Array<Record<string, unknown>>) {
                  if (block.type === 'tool_result' && block.content === CONTEXT_PLACEHOLDER) {
                    const resolved = byId.get(block.tool_use_id as string);
                    if (resolved) {
                      block.content = resolved.resultText;
                      if (resolved.isError) block.is_error = true;
                    }
                  }
                }
              }
            } else {
              messages.push({ role: 'user', content: message });
            }

            const turnStartIndex = messages.length;
            await runAgenticLoop({
              messages,
              turnStartIndex,
              profile,
              thinkingLevel,
              client: mcpClient!,
              tools,
              systemPrompt,
              emit: safeEnqueue,
              taskId,
              runId,
              requestText: message,
              historyLength: history.length,
            });

            safeEnqueue(sseDone());
            safeClose();
          } catch (error) {
            console.error('[Chat] Stream error:', error);
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            safeEnqueue(sseError('An error occurred processing your request'));
            try {
              cl.streamError({ taskId, runId, errorKind: 'unhandled', message: errMsg, model: profile.id });
            } catch (logErr) { console.error('[Controllog] streamError error:', logErr); }
            safeClose();
          } finally {
            markStreamFinished();
            if (mcpClient) {
              try { await mcpClient.close(); } catch { /* ignore */ }
            }
          }
        };

        try {
          await cl.runInSession(logSession, runStream);
        } finally {
          markStreamFinished();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[Chat] Error:', error);
    if (mcpClient) {
      try { await mcpClient.close(); } catch { /* ignore */ }
    }
    return Response.json({ error: 'Failed to process request' }, { status: 500 });
  }
}
