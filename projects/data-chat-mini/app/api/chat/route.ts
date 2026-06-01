import { NextRequest } from 'next/server';
import { getModelProfile } from '@/lib/llm-client';
import { createMCPClient, getFilteredTools, mcpToolsToAnthropicFormat } from '@/lib/mcp-client';
import { runAgenticLoop } from '@/lib/agentic-loop';
import { sseDone, sseError } from '@/lib/sse-encoder';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let mcpClient: Client | null = null;
  try {
    const body = await request.json();
    const message = typeof body.message === 'string' ? body.message : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    if (!message.trim()) {
      return Response.json({ error: 'No message provided' }, { status: 400 });
    }
    if (!process.env.MOTHERDUCK_TOKEN) {
      return Response.json({ error: 'Server is missing MOTHERDUCK_TOKEN' }, { status: 500 });
    }
    if (!process.env.OPENROUTER_API_KEY) {
      return Response.json({ error: 'Server is missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    mcpClient = await createMCPClient(sessionId);
    const tools = mcpToolsToAnthropicFormat(await getFilteredTools(mcpClient));
    const profile = getModelProfile();

    const stream = new ReadableStream({
      async start(controller) {
        const emit = (chunk: Uint8Array) => controller.enqueue(chunk);
        try {
          await runAgenticLoop({
            messages: [{ role: 'user', content: message }],
            profile,
            thinkingLevel: 'none',
            client: mcpClient!,
            tools,
            systemPrompt: 'You are a read-only data assistant. Use tools when needed, then answer concisely.',
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
