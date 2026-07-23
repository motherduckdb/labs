create table if not exists conversations (
  channel text not null,
  thread_ts text not null,
  messages jsonb not null default '[]',
  databases text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (channel, thread_ts)
);
create table if not exists channel_settings (
  channel text primary key,
  databases text[] not null,
  updated_at timestamptz not null default now()
);
