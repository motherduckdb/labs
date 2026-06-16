"""Persistent stdio scoring sidecar.

The Node harness spawns this once per `evaluate` run and sends one JSON request
per line on stdin; we reply one JSON line per request on stdout. Scoring reuses
the vendored ``score.py`` verbatim (official ``dabstep_benchmark`` scorer when
installed, its self-contained fallback otherwise) so verdicts match the baseline.

Request:  {"id": 7, "rows": [[v0, v1], ...] | null, "error": "msg" | null,
           "gold": "...", "guidelines": "..." | null,
           "predicted_sql": "..." | null, "hit_limit": false}
Response: {"id": 7, "is_correct": bool, "correctness": "correct|incorrect|error|hit_limit",
           "score": 0.0|1.0, "match_source": "...", "reason": "...|null",
           "predicted_answer": "...|null", "gold_answer": "..."}
"""

import json
import sys

from score import ExecutionError, score


def handle(req: dict) -> dict:
    rid = req.get("id")
    rows = req.get("rows")
    err = req.get("error")
    if err is not None or rows is None:
        execution_result = ExecutionError("RunFailure", err or "no rows")
    else:
        # score.py is positional (row[0], len(row)); rows arrive as arrays.
        execution_result = [tuple(r) for r in rows]
    result = score(
        execution_result=execution_result,
        gold_answer=req.get("gold", ""),
        guidelines=req.get("guidelines"),
        predicted_sql=req.get("predicted_sql"),
        hit_limit=bool(req.get("hit_limit", False)),
    )
    return {
        "id": rid,
        "is_correct": result.is_correct,
        "correctness": result.correctness.value,
        "score": result.score,
        "match_source": result.match_source,
        "reason": result.reason,
        "predicted_answer": result.predicted_answer,
        "gold_answer": result.gold_answer,
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")  # capture id first so an error still resolves the caller
            resp = handle(req)
        except Exception as e:  # never die on one bad request; keep rid so score() fails the task instead of hanging it
            resp = {"id": rid, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
