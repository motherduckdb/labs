#!/bin/bash
# Sequential 419-question OpenRouter comparison across 4 models.
# Sequential on purpose: all runs append to the SAME local
# results/controllog/{events,postings}.jsonl, and concurrent processes writing
# large per-question payloads to one file risks interleaved/corrupted lines.
# Within each run, --concurrency 15 still parallelizes across questions.
set -uo pipefail
cd "$(dirname "$0")/.."

export MOTHERDUCK_TOKEN="${MOTHERDUCK_TOKEN:-$motherduck_token}"
if [ -z "${MOTHERDUCK_TOKEN:-}" ]; then
  echo "MOTHERDUCK_TOKEN / motherduck_token not set" >&2
  exit 1
fi

LOG=results/openrouter_comparison_run.log
: > "$LOG"

run_one() {
  local label="$1"; shift
  local out="results/test_${label}_$(date -u +%Y%m%dT%H%M%SZ).jsonl"
  date -u "+=== ${label} start %Y-%m-%d %H:%M:%S" | tee -a "$LOG"
  if uv run asm evaluate --split test --concurrency 15 --out "$out" "$@" >> "$LOG" 2>&1; then
    date -u "+=== ${label} evaluate done %Y-%m-%d %H:%M:%S" | tee -a "$LOG"
  else
    date -u "+=== ${label} evaluate FAILED %Y-%m-%d %H:%M:%S" | tee -a "$LOG"
  fi
  uv run python scripts/upload_controllog.py dabstep_logs_alex >> "$LOG" 2>&1
  date -u "+=== ${label} uploaded to dabstep_logs_alex %Y-%m-%d %H:%M:%S" | tee -a "$LOG"
}

run_one luna_max          --model luna                          --reasoning max
run_one gemini3flash_low  --model gemini                        --reasoning low
run_one kimik3_default    --model moonshotai/kimi-k3             --reasoning default
run_one sonnet5_low       --model anthropic/claude-sonnet-5      --reasoning low

date -u "+=== all 4 OpenRouter comparison runs complete %Y-%m-%d %H:%M:%S" | tee -a "$LOG"
