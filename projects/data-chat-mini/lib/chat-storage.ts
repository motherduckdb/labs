import { get, set, del, createStore } from 'idb-keyval';
import type {
  ChatMessage,
  ConversationSummary,
  StoredConversation,
} from '@/types/chat';

const STORE_DB = 'data-chat-mini';
const STORE_NAME = 'chat-history';
const INDEX_KEY = 'conv_index';
const CONV_PREFIX = 'conv:';

// Lazily resolve the store so importing this module from a server component
// (e.g. via the type-only reference) doesn't throw at import time. idb-keyval
// touches `indexedDB` synchronously inside `createStore`.
let storePromise: ReturnType<typeof createStore> | null = null;
function getStore() {
  if (!storePromise) {
    storePromise = createStore(STORE_DB, STORE_NAME);
  }
  return storePromise;
}

function convKey(id: string): string {
  return `${CONV_PREFIX}${id}`;
}

/**
 * Ephemeral per-session fields we don't want restored from disk: a reopened
 * conversation should never show a spinning "Thinking..." state, nor a
 * context-tool call that was mid-round-trip when the tab closed.
 */
function scrubMessage(m: ChatMessage): ChatMessage {
  const copy: ChatMessage = { ...m, isStreaming: false };
  delete copy.pendingContext;
  return copy;
}

/** First user message trimmed to a reasonable title length. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content.trim());
  const raw = firstUser?.content.trim() || 'New conversation';
  const oneLine = raw.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? oneLine.slice(0, 57) + '...' : oneLine;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const list = (await get<ConversationSummary[]>(INDEX_KEY, await getStore())) || [];
  // Defensive copy + sort; callers should not rely on in-place ordering.
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversation(id: string): Promise<StoredConversation | null> {
  const conv = await get<StoredConversation>(convKey(id), await getStore());
  return conv || null;
}

export async function saveConversation(conv: StoredConversation): Promise<void> {
  const store = await getStore();
  const existing = await get<StoredConversation>(convKey(conv.id), store);
  const scrubbed: StoredConversation = {
    ...conv,
    // Preserve the original createdAt across re-saves so the caller can pass Date.now()
    // without having to remember the first-save timestamp.
    createdAt: existing?.createdAt ?? conv.createdAt,
    // Preserve an existing title so a user rename isn't overwritten by the auto-derived
    // title on the next save. `renameConversation` is the only path that updates title.
    title: existing?.title ?? conv.title,
    messages: conv.messages.map(scrubMessage),
  };
  await set(convKey(scrubbed.id), scrubbed, store);

  const index = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  const summary: ConversationSummary = {
    id: scrubbed.id,
    title: scrubbed.title,
    updatedAt: scrubbed.updatedAt,
    databases: scrubbed.databases,
  };
  const next = index.filter(c => c.id !== scrubbed.id);
  next.push(summary);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  await set(INDEX_KEY, next, store);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const store = await getStore();
  const existing = await get<StoredConversation>(convKey(id), store);
  if (!existing) return;
  const trimmed = title.trim() || existing.title;
  const updated: StoredConversation = { ...existing, title: trimmed };
  await set(convKey(id), updated, store);
  const index = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  const next = index.map(c => (c.id === id ? { ...c, title: trimmed } : c));
  await set(INDEX_KEY, next, store);
}

export async function deleteConversation(id: string): Promise<void> {
  const store = await getStore();
  await del(convKey(id), store);
  const existing = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  const next = existing.filter(c => c.id !== id);
  await set(INDEX_KEY, next, store);
}

export async function clearConversations(): Promise<void> {
  const store = await getStore();
  const existing = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  await Promise.all(existing.map((c) => del(convKey(c.id), store)));
  await set(INDEX_KEY, [], store);
}
