import { getPool } from './pg';

export async function getChannelDatabases(channel: string): Promise<string[] | null> {
  const pool = getPool();
  const result = await pool.query<{ databases: string[] }>(
    'select databases from channel_settings where channel = $1',
    [channel]
  );
  const row = result.rows[0];
  return row ? row.databases : null;
}

export async function setChannelDatabases(channel: string, databases: string[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into channel_settings (channel, databases, updated_at)
     values ($1, $2, now())
     on conflict (channel)
     do update set databases = excluded.databases, updated_at = now()`,
    [channel, databases]
  );
}

/** Channel override if one exists, else QUACKBOT_DATABASES (comma-separated env), else []. */
export async function resolveDatabases(channel: string): Promise<string[]> {
  const override = await getChannelDatabases(channel);
  if (override) return override;

  const envValue = process.env.QUACKBOT_DATABASES ?? '';
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
