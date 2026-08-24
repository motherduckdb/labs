#!/bin/zsh
# Append a one-line progress snapshot for the running full-test eval.
# Usage: scripts/progress_snapshot.sh          (writes to results/progress_history.log)
cd /Users/alex/Documents/labs/projects/agentic-sql-context-mcp
HIST=results/progress_history.log
/usr/bin/python3 - <<'PY' >> $HIST
import glob, json, os, subprocess, time
from datetime import datetime, timedelta, timezone

files = sorted(glob.glob('results/test_*.jsonl'), key=os.path.getmtime)
now = datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S')
alive = bool(subprocess.run(['pgrep', '-f', 'asm evaluate --local .* --split test'],
                            capture_output=True).stdout.strip())
if not files:
    print(f"{now} | alive={'yes' if alive else 'NO'} | no results file yet")
    raise SystemExit

f = files[-1]
rows = []
with open(f) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass          # last line may be mid-write
n = len(rows)
ok = sum(1 for r in rows if r.get('is_correct'))
pct = (ok / n * 100) if n else 0.0
by = {}
for r in rows:
    by[r.get('correctness', '?')] = by.get(r.get('correctness', '?'), 0) + 1
cats = ' '.join(f"{k}={v}" for k, v in sorted(by.items()))
idle_min = (time.time() - os.path.getmtime(f)) / 60
secs = [r.get('elapsed_s', 0) for r in rows]
avg = sum(secs) / n if n else 0
eta_h = (419 - n) * avg / 3600 if n else 0
now_dt = datetime.now().astimezone()
finish_dt = now_dt + timedelta(hours=eta_h)
finish_str = finish_dt.strftime('%Y-%m-%d %H:%M %a') if n < 419 else 'done'
stall = '  <-- STALLED?' if (alive and idle_min > 45) else ''
print(f"{now} | alive={'yes' if alive else 'NO'} | {n}/419 done | {ok} correct "
      f"({pct:.1f}%) | {cats} | avg {avg:.0f}s/q | last write {idle_min:.0f}m ago "
      f"| eta {eta_h:.1f}h | now {now_dt:%H:%M} | eta-complete {finish_str} "
      f"| {os.path.basename(f)}{stall}")
PY
