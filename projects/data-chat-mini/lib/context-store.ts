import { get, set, createStore } from 'idb-keyval';
import { uuid7 } from './uuid7';

export interface Fragment {
  id: string;
  content: string;
  createdAt: number;
}

const store = createStore('data-chat-mini', 'context-layer');
const FRAGMENTS_KEY = 'fragments';

export async function listFragments(): Promise<Fragment[]> {
  return (await get<Fragment[]>(FRAGMENTS_KEY, store)) || [];
}

export async function saveFragment(content: string): Promise<Fragment> {
  const fragment = { id: uuid7(), content, createdAt: Date.now() };
  const fragments = await listFragments();
  await set(FRAGMENTS_KEY, [...fragments, fragment], store);
  return fragment;
}

async function queryFragments(query: string): Promise<Fragment[]> {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const fragments = await listFragments();
  if (terms.length === 0) return fragments;
  return fragments.filter(fragment => {
    const content = fragment.content.toLowerCase();
    return terms.some(term => content.includes(term));
  });
}

export async function serviceContextTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ resultText: string; isError?: boolean }> {
  try {
    if (name === 'query_context_layer') {
      const query = typeof args.query === 'string' ? args.query : '';
      const fragments = await queryFragments(query);
      if (fragments.length === 0) {
        return { resultText: 'No saved context fragments matched.' };
      }
      return { resultText: fragments.map(fragment => `- ${fragment.content}`).join('\n') };
    }

    if (name === 'update_context_layer') {
      const content = typeof args.content === 'string'
        ? args.content
        : typeof args.value === 'string'
          ? args.value
          : '';
      if (!content.trim()) {
        return { resultText: 'No content provided.', isError: true };
      }
      const fragment = await saveFragment(content.trim());
      return { resultText: `Saved context fragment ${fragment.id}.` };
    }

    return { resultText: `Unknown context tool: ${name}`, isError: true };
  } catch (error) {
    return { resultText: error instanceof Error ? error.message : 'Context tool failed', isError: true };
  }
}
