"""Render a saved trace (tool_calls) for a single task_id from a JSONL file."""
import json, sys

def load_trace(path, tid):
    for line in open(path):
        r = json.loads(line)
        if str(r['task_id']) == tid:
            return r
    return None

def render(r, arm):
    print('=' * 90)
    print(f'  {arm}  ·  task {r["task_id"]}  ·  turns={r["n_tool_calls"]}  ·  cost=${r["cost_usd"]:.4f}  ·  elapsed={r["elapsed_s"]:.1f}s')
    print(f'  Q: {r["question"]}')
    mark = '✓' if r["is_correct"] else '✗'
    print(f'  gold: {r["gold_answer"]}    pred: {r["predicted_answer"]}    {mark}')
    print('=' * 90)
    for i, tc in enumerate(r['tool_calls'], 1):
        tool = tc['tool']
        if tool == 'list_tables':
            print(f'  [{i:>2}] list_tables -> {tc.get("result_rows", 0)} tables')
        elif tool == 'describe_table':
            err = tc.get('error')
            tag = f' ERR: {err}' if err else f' ({tc.get("cols", "?")} cols)'
            print(f'  [{i:>2}] describe_table  {tc.get("table")}{tag}')
        elif tool in ('query', 'submit_answer'):
            err = tc.get('error')
            sql = (tc.get('sql') or '').strip()
            tag = f'ERR: {err}' if err else f'{tc.get("rows", "?")} rows'
            print(f'  [{i:>2}] {tool:14s} ({tag})')
            for ln in sql.split('\n'):
                print(f'         {ln}')
    print(f'  FINAL: {(r.get("predicted_sql") or "").strip()}')
    print()

if __name__ == '__main__':
    tid = sys.argv[1] if len(sys.argv) > 1 else '5'
    b = load_trace('results/baseline_train_20260504T211551Z.jsonl', tid)
    e = load_trace('results/explicit_train_20260504T211552Z.jsonl', tid)
    if b: render(b, 'BASELINE  (no prose, raw schema)')
    if e: render(e, 'EXPLICIT  (no prose, named schema)')
