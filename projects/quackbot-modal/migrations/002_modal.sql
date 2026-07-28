-- 002_modal.sql — state that used to live in the always-on process's memory.
--
-- On Fly, quackbot was exactly one Node process, so a `Map` was a correct
-- mutex, a `Set` was a correct dedupe table, and a module-level TTL cache was a
-- correct cache. On Modal there are zero-to-many short-lived containers, so
-- every one of those has to become a row somewhere both the worker and the
-- Python edge can see. That somewhere is here.
--
-- Additive only: this runs against a database that already has 001_init.sql
-- applied (`conversations`, `channel_settings`), and every statement is
-- `if not exists`, so re-running it is a no-op. Apply with:
--
--   psql $DATABASE_URL -f migrations/002_modal.sql

-- ---------------------------------------------------------------------------
-- slack_events — event dedupe
-- ---------------------------------------------------------------------------
-- Replaces the in-process `Set` in handlers.ts. Two distinct sources of
-- duplicates land here: Slack's own delivery retries (which the HTTP edge also
-- short-circuits on X-Slack-Retry-Num, but that header is not a guarantee), and
-- a DM @-mention firing both `message.im` and `app_mention` for one human
-- utterance. The worker inserts before doing any work; a conflict means some
-- other container already owns this turn.
--
-- The primary key IS the dedupe mechanism — `insert … on conflict do nothing`
-- and a zero rowCount is the "already seen" signal. No other index is needed
-- for the hot path.
create table if not exists slack_events (
  event_id text primary key,
  seen_at timestamptz not null default now()
);

-- This table grows forever unless something prunes it. Dedupe only has to hold
-- for as long as Slack might retry (~1 hour of backoff at the outside), so rows
-- older than a day are dead weight. `pruneOldEvents()` in src/store/events.ts
-- does the delete; this index is what keeps that delete from a full scan once
-- the table is large.
create index if not exists slack_events_seen_at_idx on slack_events (seen_at);

-- ---------------------------------------------------------------------------
-- confirmations — the Approve/Deny handshake
-- ---------------------------------------------------------------------------
-- The biggest shape change in the migration. Today the same process that posts
-- the Block Kit buttons is the one awaiting the click, so a `Map<confirmId,
-- {resolve}>` suffices. With an ephemeral worker the click lands on the Python
-- `web` endpoint in a different container entirely, so the decision has to be
-- handed over through the database:
--
--   1. worker inserts a row as 'pending' and posts the buttons
--   2. worker polls this row every second, up to the existing 120s timeout
--   3. the click hits /slack/interactive; Python UPDATEs status + decided_by
--   4. the worker's next poll sees it and proceeds
--   5. timeout still fails CLOSED (treated as a denial), matching Fly behaviour
--
-- The timeout is enforced by the worker, not by the row — a 'pending' row that
-- nobody is polling any more is simply abandoned, which is why `created_at`
-- exists to prune on.
--
-- `payload` carries whatever the worker needs to render/audit the prompt (tool
-- name, arguments, resolved guide target). It is deliberately untyped: the
-- Python edge only ever touches `status` / `decided_by` / `decided_at`, so
-- keeping the schema knowledge that crosses the language boundary as small as
-- possible is the point.
--
-- `check (status in (...))` is load-bearing for that boundary: it is the one
-- thing stopping a typo in the Python UPDATE from writing a state the
-- TypeScript poller does not understand.
create table if not exists confirmations (
  confirm_id text primary key,
  channel text not null,
  thread_ts text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  payload jsonb,
  decided_by text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- Prune support (abandoned 'pending' rows outlive their worker) and the
-- occasional "what got approved in this thread" audit read.
create index if not exists confirmations_created_at_idx on confirmations (created_at);
create index if not exists confirmations_thread_idx on confirmations (channel, thread_ts);

-- ---------------------------------------------------------------------------
-- kv_cache — TTL key/value
-- ---------------------------------------------------------------------------
-- Backs the query-guide cache (query-guide.ts's 15-minute module-level TTL).
-- Worth noting this is an upgrade rather than a like-for-like port: the old
-- cache was per-process, so every restart and every parallel process paid the
-- fetch again. Shared in Postgres, one container's fetch warms every other
-- container's turn — which matters far more now that containers are per-turn.
--
-- Expiry is enforced on READ (`expires_at > now()` in the select), not by a
-- background job. `pruneExpiredKv()` reclaims space; it is never required for
-- correctness, so a container that exits without running it is harmless.
create table if not exists kv_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null
);

create index if not exists kv_cache_expires_at_idx on kv_cache (expires_at);

-- ---------------------------------------------------------------------------
-- controllog_events / controllog_postings
-- ---------------------------------------------------------------------------
-- src/core/controllog.ts buffers rows in an AsyncLocalStorage session and, at
-- the end of a turn, appends them to logs/controllog/{events,postings}.jsonl.
-- That cannot survive the move: Modal Volumes resolve concurrent writes to the
-- same file last-write-wins, so two turns finishing at once would silently drop
-- one turn's log. Appends become inserts.
--
-- The columns below mirror the JSONL record shapes in controllog.ts
-- (`EventRow` / `PostingRow`, flushed around line 219) field-for-field, and
-- those in turn mirror the DuckDB DDL in the labs `controllog` package
-- (src/controllog/motherduck.py::_ensure_schema). Keeping all three aligned is
-- deliberate: it means the existing Python uploader and controllog-viz keep
-- working against a straight `select` from these tables, with no translation
-- layer to drift. Do not "tidy" these column names.
--
-- Two columns have no JSONL equivalent and are additions for Postgres:
--
--   session_id — the `Session.id` (uuid7) that controllog.ts already generates
--                per turn but never wrote to disk, because on disk a turn's
--                rows were merely adjacent lines. Here rows from concurrent
--                turns interleave, so the grouping has to be explicit.
--   ordinal    — position within the flush, preserving the within-session
--                ordering that line order used to carry implicitly. event_id is
--                a uuid7 and therefore roughly time-sortable already, but
--                "roughly" is doing real work in that sentence: postings share
--                a single event's timestamp, and two events emitted in the same
--                millisecond have no guaranteed uuid7 order.
--
-- `delta_numeric` is `double precision`, not `numeric`, to match the DOUBLE in
-- the controllog DuckDB schema and the JS `number` it comes from. That is the
-- wrong type for money in general, but these are observability postings whose
-- own balance check tolerates a 1e-4 epsilon — introducing a more precise type
-- on only one of the three schemas would create a conversion seam for no gain.
create table if not exists controllog_events (
  event_id text primary key,
  session_id text not null,
  ordinal integer not null,
  event_time timestamptz not null,
  ingest_time timestamptz not null,
  kind text not null,
  actor_agent_id text,
  actor_task_id text,
  project_id text not null,
  run_id text,
  source text not null,
  idempotency_key text not null,
  payload_json jsonb not null default '{}'
);

-- The natural read pattern ("replay one turn in order") and the ordering
-- guarantee in one index.
create unique index if not exists controllog_events_session_ordinal_idx
  on controllog_events (session_id, ordinal);
create index if not exists controllog_events_event_time_idx on controllog_events (event_time);

create table if not exists controllog_postings (
  posting_id text primary key,
  event_id text not null,
  session_id text not null,
  ordinal integer not null,
  account_type text not null,
  account_id text not null,
  unit text not null,
  delta_numeric double precision not null,
  dims_json jsonb not null default '{}'
);

-- No foreign key to controllog_events on purpose. The two lists are flushed as
-- separate statements, and a posting that outlives a failed event insert is a
-- logging artefact worth keeping, not a constraint violation worth failing a
-- user's turn over. Logging must never be able to take down a turn.
create index if not exists controllog_postings_event_id_idx on controllog_postings (event_id);
create unique index if not exists controllog_postings_session_ordinal_idx
  on controllog_postings (session_id, ordinal);
