"""Splice an already-completed retry run's successful questions into the
ORIGINAL run's MotherDuck data (same run_label/run_id), skipping any that
still show a budget error. Companion to retry_and_splice.py for when the
`asm evaluate` subprocess already ran (e.g. a prior invocation was
interrupted after producing real results) — this only does the splice half.

Usage:
  uv run python scripts/splice_only.py \
      <original_run_label> <original_run_id> <retry_label> <database>
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
EVENTS_PATH = REPO_ROOT / "results" / "controllog" / "events.jsonl"
POSTINGS_PATH = REPO_ROOT / "results" / "controllog" / "postings.jsonl"


def main() -> None:
    orig_run_label, orig_run_id, retry_label, database = sys.argv[1:5]
    out_path = REPO_ROOT / "results" / f"{retry_label}.jsonl"

    rows = [json.loads(line) for line in out_path.read_text().splitlines() if line.strip()]
    succeeded, still_failed = [], []
    for r in rows:
        err = r.get("error") or ""
        if "in_flight_budget_exhausted" in err:
            still_failed.append(r["task_id"])
        else:
            succeeded.append(r["task_id"])
    print(f"from {out_path.name}: succeeded {len(succeeded)}  still budget-blocked {len(still_failed)}")
    if not succeeded:
        print("nothing to splice.")
        return
    succeeded_set = set(succeeded)

    staged_events_path = REPO_ROOT / "results" / f"{retry_label}_staged_events.jsonl"
    staged_postings_path = REPO_ROOT / "results" / f"{retry_label}_staged_postings.jsonl"

    retry_event_ids: set[str] = set()
    with open(EVENTS_PATH) as src, open(staged_events_path, "w") as dst:
        for line in src:
            if not line.strip():
                continue
            ev = json.loads(line)
            pj = ev.get("payload_json") or {}
            if pj.get("run_label") != retry_label:
                continue
            qid = pj.get("question_id")
            if qid not in succeeded_set:
                continue
            ev["run_id"] = orig_run_id
            pj["run_id"] = orig_run_id
            pj["run_label"] = orig_run_label
            ev["payload_json"] = pj
            retry_event_ids.add(ev["event_id"])
            dst.write(json.dumps(ev) + "\n")

    with open(POSTINGS_PATH) as src, open(staged_postings_path, "w") as dst:
        for line in src:
            if not line.strip():
                continue
            p = json.loads(line)
            if p.get("event_id") not in retry_event_ids:
                continue
            dj = p.get("dims_json") or {}
            dj["run_id"] = orig_run_id
            dj["run_label"] = orig_run_label
            p["dims_json"] = dj
            dst.write(json.dumps(p) + "\n")

    qid_list_sql = ", ".join(f"'{q}'" for q in succeeded)
    sql = f"""
    DELETE FROM {database}.main.postings WHERE event_id IN (
      SELECT event_id FROM {database}.main.events
      WHERE payload_json.run_label = '{orig_run_label}'
        AND payload_json.question_id IN ({qid_list_sql})
    );
    DELETE FROM {database}.main.events
    WHERE payload_json.run_label = '{orig_run_label}'
      AND payload_json.question_id IN ({qid_list_sql});

    CREATE OR REPLACE TEMP VIEW raw_events AS
    SELECT * FROM read_json(
      '{staged_events_path}', format='newline_delimited',
      columns={{
        event_id: 'VARCHAR', event_time: 'TIMESTAMPTZ', ingest_time: 'TIMESTAMPTZ',
        kind: 'VARCHAR', project_id: 'VARCHAR', source: 'VARCHAR',
        idempotency_key: 'VARCHAR', payload_json: 'JSON', run_id: 'VARCHAR',
        actor_agent_id: 'VARCHAR', actor_task_id: 'VARCHAR'
      }}
    );
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

    INSERT INTO {database}.main.events BY NAME SELECT * FROM new_events;

    CREATE OR REPLACE TEMP VIEW raw_postings AS
    SELECT * FROM read_json(
      '{staged_postings_path}', format='newline_delimited',
      columns={{
        posting_id: 'VARCHAR', event_id: 'VARCHAR', account_type: 'VARCHAR',
        account_id: 'VARCHAR', unit: 'VARCHAR', delta_numeric: 'DOUBLE', dims_json: 'JSON'
      }}
    );
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

    INSERT INTO {database}.main.postings BY NAME SELECT * FROM new_postings;

    SELECT count(*) AS n, sum(CASE WHEN payload_json.is_correct THEN 1 ELSE 0 END) AS correct,
      sum(CASE WHEN payload_json.error_description::VARCHAR LIKE '%in_flight_budget_exhausted%' THEN 1 ELSE 0 END) AS still_budget_errors
    FROM {database}.main.events
    WHERE kind='evaluation_result' AND payload_json.run_label = '{orig_run_label}';
    """
    result = subprocess.run(["duckdb", "md:", "-c", sql], capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)


if __name__ == "__main__":
    main()
