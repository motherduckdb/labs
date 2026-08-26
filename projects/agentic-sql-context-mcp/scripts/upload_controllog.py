"""Upload local controllog JSONL (results/controllog/{events,postings}.jsonl)
into dabstep_logs_alex's `main` schema — matching the schema this project's
MotherDuck Dive actually reads (`"dabstep_logs"."main"."events"`).

Three gotchas this works around (each cost real debugging time; keep this
comment so nobody re-derives them from scratch):

1. controllog.motherduck.upload() from the installed `controllog` package
   writes into a hardcoded `controllog` schema (payload_json typed as generic
   JSON). The Dive reads `main` (payload_json typed as a concrete STRUCT,
   inferred from the original historical upload) — a different, incompatible
   schema. This script targets `main` directly.

2. Extracting a field via JSON dot-notation (`payload_json.foo`) and casting
   it to VARCHAR keeps the JSON quoting (`CAST(payload_json.foo AS VARCHAR)`
   on a JSON string yields `"foo"`, quotes included) — comparisons like
   `run_label LIKE 'test_luna_max%'` then silently match nothing. Use the
   `->>'foo'` extraction operator instead, which returns the unquoted text.

3. `main.events`' physical column order is NOT what you'd guess from reading
   the CREATE-TABLE-shaped mental model (event_id, event_time, ingest_time,
   kind, project_id, source, idempotency_key, payload_json, run_id, ...). The
   real order (confirmed via `information_schema.columns ORDER BY
   ordinal_position`) interleaves actor_agent_id/actor_task_id/run_id well
   before source/idempotency_key/payload_json. A positional `INSERT INTO ...
   SELECT ...` (or `SELECT *`) silently shifts every column after the first
   mismatch — in practice this put the payload_json struct value into the
   run_id column, producing an opaque "Unimplemented type for cast
   (STRUCT(...) -> UUID)" error that has nothing to do with any actual value.
   Always use `INSERT INTO ... BY NAME`, which matches by column name and is
   immune to this.

Usage: uv run python scripts/upload_controllog.py [database]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    database = sys.argv[1] if len(sys.argv) > 1 else "dabstep_logs_alex"
    events_path = REPO_ROOT / "results" / "controllog" / "events.jsonl"
    postings_path = REPO_ROOT / "results" / "controllog" / "postings.jsonl"

    sql = f"""
    CREATE OR REPLACE TEMP VIEW raw_events AS
    SELECT * FROM read_json(
      '{events_path}',
      format='newline_delimited',
      columns={{
        event_id: 'VARCHAR', event_time: 'TIMESTAMPTZ', ingest_time: 'TIMESTAMPTZ',
        kind: 'VARCHAR', project_id: 'VARCHAR', source: 'VARCHAR',
        idempotency_key: 'VARCHAR', payload_json: 'JSON', run_id: 'VARCHAR',
        actor_agent_id: 'VARCHAR', actor_task_id: 'VARCHAR'
      }}
    );
    -- Field-by-field via ->>'field' (see gotcha 2), and raw_response is deliberately
    -- OMITTED (not even as a typed NULL — see the git history of this file for why
    -- an explicit NULL::<struct type> literal alongside 33 other fields reliably broke
    -- the cast). INSERT ... BY NAME NULL-fills the missing key from the target's type,
    -- so raw_response lands NULL for every event inserted here — the outliers tab's
    -- trace-detail view has nothing to show for these rows, but nothing else reads it.
    CREATE OR REPLACE TEMP VIEW new_events AS
    SELECT
      CAST(event_id AS UUID) AS event_id, event_time, ingest_time, kind, project_id,
      source, idempotency_key,
      {{
        split: payload_json->>'split', model: payload_json->>'model',
        database: payload_json->>'database', run_id: CAST(payload_json->>'run_id' AS UUID),
        run_label: payload_json->>'run_label', question_id: payload_json->>'question_id',
        level: payload_json->>'level', correctness: payload_json->>'correctness',
        hit_limit: CAST(payload_json->>'hit_limit' AS BOOLEAN),
        n_tool_calls: CAST(payload_json->>'n_tool_calls' AS BIGINT),
        cached_tokens: CAST(payload_json->>'cached_tokens' AS BIGINT), error: payload_json->'error',
        question_text: payload_json->>'question_text', evidence: payload_json->>'evidence',
        db_id: payload_json->>'db_id', config_type: payload_json->>'config_type',
        predicted_sql: payload_json->>'predicted_sql', gold_sql: payload_json->'gold_sql',
        gold_result: payload_json->>'gold_result', predicted_result: payload_json->>'predicted_result',
        is_correct: CAST(payload_json->>'is_correct' AS BOOLEAN),
        correctness_level: payload_json->>'correctness_level', match_source: payload_json->>'match_source',
        partial_reason: payload_json->>'partial_reason',
        hit_iteration_limit: CAST(payload_json->>'hit_iteration_limit' AS BOOLEAN),
        tool_calls: CAST(payload_json->>'tool_calls' AS BIGINT),
        sql_errors: CAST(payload_json->>'sql_errors' AS BIGINT),
        query_count: CAST(payload_json->>'query_count' AS BIGINT),
        duration_ms: CAST(payload_json->>'duration_ms' AS BIGINT),
        cost_usd: CAST(payload_json->>'cost_usd' AS DOUBLE),
        input_tokens: CAST(payload_json->>'input_tokens' AS BIGINT),
        output_tokens: CAST(payload_json->>'output_tokens' AS BIGINT),
        answer_source: payload_json->>'answer_source', error_description: payload_json->'error_description'
      }} AS payload_json,
      CAST(run_id AS UUID) AS run_id, actor_agent_id, actor_task_id
    FROM raw_events
    QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingest_time DESC) = 1;

    INSERT INTO {database}.main.events BY NAME
    SELECT * FROM new_events
    WHERE CAST(event_id AS VARCHAR) NOT IN (
      SELECT CAST(event_id AS VARCHAR) FROM {database}.main.events
    );

    CREATE OR REPLACE TEMP VIEW raw_postings AS
    SELECT * FROM read_json(
      '{postings_path}',
      format='newline_delimited',
      columns={{
        posting_id: 'VARCHAR', event_id: 'VARCHAR', account_type: 'VARCHAR',
        account_id: 'VARCHAR', unit: 'VARCHAR', delta_numeric: 'DOUBLE', dims_json: 'JSON'
      }}
    );
    -- Field-by-field, same reason as new_events: a plain CAST of the whole dims_json
    -- blob fails if a run's default_dims picked up an extra key (e.g. "benchmark")
    -- the target's fixed struct type doesn't have room for.
    CREATE OR REPLACE TEMP VIEW new_postings AS
    SELECT
      account_type, account_id, unit, delta_numeric,
      {{
        split: dims_json->>'split', model: dims_json->>'model',
        database: dims_json->>'database', run_id: CAST(dims_json->>'run_id' AS UUID),
        run_label: dims_json->>'run_label', "from": dims_json->>'from',
        "to": dims_json->>'to', kind: dims_json->>'kind', metric: dims_json->>'metric'
      }} AS dims_json,
      CAST(event_id AS UUID) AS event_id, CAST(posting_id AS UUID) AS posting_id
    FROM raw_postings
    QUALIFY ROW_NUMBER() OVER (PARTITION BY posting_id) = 1;

    INSERT INTO {database}.main.postings BY NAME
    SELECT * FROM new_postings
    WHERE CAST(posting_id AS VARCHAR) NOT IN (
      SELECT CAST(posting_id AS VARCHAR) FROM {database}.main.postings
    );

    SELECT 'events' AS tbl, count(*) AS n FROM {database}.main.events
    UNION ALL
    SELECT 'postings', count(*) FROM {database}.main.postings;
    """
    result = subprocess.run(["duckdb", "md:", "-c", sql], capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)


if __name__ == "__main__":
    main()
