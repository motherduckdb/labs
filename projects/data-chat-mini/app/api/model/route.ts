import { getModelProfile, streamChatCompletion } from '@/lib/llm-client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const message = typeof body.message === 'string' ? body.message : 'Say hello in one sentence.';
    if (!process.env.OPENROUTER_API_KEY) {
      return Response.json({ error: 'Server is missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    const profile = getModelProfile();
    const stream = await streamChatCompletion({
      model: profile.id,
      messages: [{ role: 'user', content: message }],
      systemPrompt: 'You are a concise workshop assistant. Answer plainly.',
      maxTokens: 512,
      temperature: 0.2,
      thinkingLevel: 'none',
      provider: profile.provider,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          content += chunk.choices?.[0]?.delta?.content || '';
        } catch {
          // Ignore malformed provider chunks in this tiny hand-check route.
        }
      }
    }

    return Response.json({ model: profile.id, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
