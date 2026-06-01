import { NextRequest } from 'next/server';
import { getModelProfile } from '@/lib/llm-client';
import { createMCPClient, getFilteredTools, mcpToolsToAnthropicFormat } from '@/lib/mcp-client';
import { runAgenticLoop } from '@/lib/agentic-loop';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { CONTEXT_TOOLS, CONTEXT_PLACEHOLDER } from '@/lib/context-tools';
import { sseDone, sseError } from '@/lib/sse-encoder';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let mcpClient: Client | null = null;
  try {
    const body = await request.json();
    const message = typeof body.message === 'string' ? body.message : '';
    const history = Array.isArray(body.history) ? body.history as Array<{ role: string; content: unknown }> : [];
    const resolvedContext = Array.isArray(body.resolvedContext)
      ? body.resolvedContext as Array<{ callId: string; resultText: string; isError?: boolean }>
      : [];
    const isResume = resolvedContext.length > 0;
    const databases = Array.isArray(body.databases) ? body.databases.filter((db: unknown): db is string => typeof db === 'string') : ['nba_box_scores_v2'];
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (!message.trim() && !isResume) {
      return Response.json({ error: 'No message provided' }, { status: 400 });
    }
    if (!process.env.MOTHERDUCK_TOKEN) {
      return Response.json({ error: 'Server is missing MOTHERDUCK_TOKEN' }, { status: 500 });
    }
    if (!process.env.OPENROUTER_API_KEY) {
      return Response.json({ error: 'Server is missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    mcpClient = await createMCPClient(sessionId);
    const tools = [...mcpToolsToAnthropicFormat(await getFilteredTools(mcpClient)), ...CONTEXT_TOOLS];
    const profile = getModelProfile();

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (chunk: Uint8Array) => controller.enqueue(chunk);
        try {
          const messages = history.map(item => ({ role: item.role, content: item.content }));
          const turnStartIndex = messages.length;
          if (isResume) {
            const byId = new Map(resolvedContext.map(result => [result.callId, result]));
            for (const item of messages) {
              if (item.role !== 'user' || !Array.isArray(item.content)) continue;
              for (const block of item.content as Array<Record<string, unknown>>) {
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
          await runAgenticLoop({
            messages,
            turnStartIndex,
            profile,
            thinkingLevel: 'none',
            client: mcpClient!,
            tools,
            systemPrompt: buildSystemPrompt(databases),
            emit,
          });
          emit(sseDone());
        } catch (error) {
          console.error('[Chat] Stream error:', error);
          emit(sseError('An error occurred processing your request'));
        } finally {
          try { controller.close(); } catch { /* already closed */ }
          if (mcpClient) {
            try { await mcpClient.close(); } catch { /* ignore */ }
          }
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
    if (mcpClient) {
      try { await mcpClient.close(); } catch { /* ignore */ }
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
