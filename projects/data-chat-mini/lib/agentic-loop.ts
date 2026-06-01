import { streamChatCompletion } from '@/lib/llm-client';
import type { ModelProfile } from '@/lib/llm-client';
import { dispatchTool } from '@/lib/tool-dispatch';
import { sseError, sseText, sseToolEnd, sseToolStart, sseUsage } from '@/lib/sse-encoder';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ThinkingLevel } from '@/types/chat';

export interface RunAgenticLoopOpts {
  messages: Array<{ role: string; content: unknown }>;
  profile: ModelProfile;
  thinkingLevel: ThinkingLevel;
  client: Client;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  systemPrompt: string;
  emit: (chunk: Uint8Array) => void;
}

const MAX_ITERATIONS = 8;

export async function runAgenticLoop(opts: RunAgenticLoopOpts) {
  const messages = opts.messages;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const llmStream = await streamChatCompletion({
      model: opts.profile.id,
      messages,
      tools: opts.tools,
      systemPrompt: opts.systemPrompt,
      temperature: 0.2,
      maxTokens: opts.profile.maxTokens,
      thinkingLevel: opts.thinkingLevel,
      provider: opts.profile.provider,
    });

    const assistantBlocks: Array<Record<string, unknown>> = [];
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let fullResponseText = '';
    const usage = { promptTokens: 0, completionTokens: 0 };

    const reader = llmStream.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        if (chunk.usage) {
          usage.promptTokens = chunk.usage.prompt_tokens || 0;
          usage.completionTokens = chunk.usage.completion_tokens || 0;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (delta.content) {
          fullResponseText += delta.content;
          opts.emit(sseText(delta.content));
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, { id: tc.id || `tool_${idx}`, name: tc.function?.name || '', args: '' });
            }
            const pending = pendingToolCalls.get(idx)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }
      }
    }

    if (fullResponseText) {
      assistantBlocks.push({ type: 'text', text: fullResponseText });
    }
    for (const [, tc] of pendingToolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { /* keep empty */ }
      assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedArgs });
    }

    opts.emit(sseUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      model: opts.profile.id,
      contextWindow: opts.profile.contextWindow,
    }));

    if (pendingToolCalls.size === 0) {
      if (assistantBlocks.length > 0) {
        messages.push({ role: 'assistant', content: assistantBlocks });
      }
      return { messages };
    }

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
    for (const tc of pendingToolCalls.values()) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { /* keep empty */ }

      opts.emit(sseToolStart({ id: tc.id, name: tc.name, args: parsedArgs }));
      try {
        const result = await dispatchTool({ client: opts.client, name: tc.name, args: parsedArgs });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: result.content,
          ...(result.isError && { is_error: true }),
        });
        opts.emit(sseToolEnd({
          id: tc.id,
          name: tc.name,
          result: result.content.slice(0, 500),
          ...(result.isError && { error: true }),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: `Error: ${message}`, is_error: true });
        opts.emit(sseToolEnd({ id: tc.id, name: tc.name, result: `Error: ${message}`, error: true }));
      }
    }

    messages.push({ role: 'assistant', content: assistantBlocks });
    messages.push({ role: 'user', content: toolResults });
  }

  opts.emit(sseError(`Iteration limit reached (${MAX_ITERATIONS}).`));
  return { messages };
}
