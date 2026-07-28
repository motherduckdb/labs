import { getPool } from './pg';

export interface StoredConversation {
  messages: unknown[];
  databases: string[];
}

export async function getConversation(channel: string, threadTs: string): Promise<StoredConversation | null> {
  const pool = getPool();
  const result = await pool.query<{ messages: unknown[]; databases: string[] }>(
    'select messages, databases from conversations where channel = $1 and thread_ts = $2',
    [channel, threadTs]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { messages: row.messages, databases: row.databases };
}

export async function saveConversation(
  channel: string,
  threadTs: string,
  messages: unknown[],
  databases: string[]
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into conversations (channel, thread_ts, messages, databases, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (channel, thread_ts)
     do update set messages = excluded.messages, databases = excluded.databases, updated_at = now()`,
    [channel, threadTs, JSON.stringify(messages), databases]
  );
}
