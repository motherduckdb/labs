import { get, set, del, createStore } from 'idb-keyval';
import type { ChatMessage, ConversationSummary, StoredConversation } from '@/types/chat';

const store = createStore('data-chat-mini', 'chat-history');
const INDEX_KEY = 'conv_index';
const CONV_PREFIX = 'conv:';

function convKey(id: string): string {
  return `${CONV_PREFIX}${id}`;
}

export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find(message => message.role === 'user' && message.content.trim());
  const raw = firstUser?.content.trim() || 'New conversation';
  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const list = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversation(id: string): Promise<StoredConversation | null> {
  return (await get<StoredConversation>(convKey(id), store)) || null;
}

export async function saveConversation(conversation: StoredConversation): Promise<void> {
  await set(convKey(conversation.id), conversation, store);
  const index = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  const next = index.filter(item => item.id !== conversation.id);
  next.push({
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    databases: conversation.databases,
  });
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  await set(INDEX_KEY, next, store);
}

export async function deleteConversation(id: string): Promise<void> {
  await del(convKey(id), store);
  const index = (await get<ConversationSummary[]>(INDEX_KEY, store)) || [];
  await set(INDEX_KEY, index.filter(item => item.id !== id), store);
}
