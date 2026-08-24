#!/usr/bin/env python3
"""Design-of-experiments sweep over LM Studio decode-speed settings.

Full factorial over engine-specific settings, each combo run against the same
2 hard training questions (task_id 1417, 2587) through the real agent +
MotherDuck MCP session (not a stub) so results are comparable to the actual
eval and reflect genuine tool-calling behavior.

GGUF (qwen3.8-27b):
  - kv_cache_quant: f16 (off), q8_0, q4_0   [3 levels]
  - context_length: 16000, 65536            [2 levels]
  - reasoning_effort: medium, off           [2 levels — "low" skipped per user request]
  -> 12 combos, speculative_mtp forced OFF for all (isolates the other factors).
     Combos are ordered with reasoning_effort as the OUTERMOST loop: every
     "medium" combo runs before any "off" combo (explicit user request — the
     two effort levels are not interleaved with kv_quant/context_length).

MLX (qwen3.8-27b-mlx):
  - speculative_mtp: off, on (uses the already-downloaded qwen3.8-27b-mtp
    draft head, zero extra download)          [2 levels]
  -> 2 combos, run after all GGUF combos. reasoning_effort is NOT included
     for MLX — see finding #3 below.

No time budget cap is enforced (MAX_WALL_SECONDS is a 48h backstop against a
genuine hang, not a target) — the user explicitly asked for a complete run
regardless of how long it takes, overriding an earlier "8 hours or less" ask.

reasoning_effort deserves its own note. Qwen3's chat template supports a
`reasoning_effort` Jinja variable ('low'/'medium'/'xhigh') and an
`enable_thinking` boolean, but on THIS LM Studio server neither is
controllable through any request-time mechanism tried: `chat_template_kwargs`
(nested), top-level `enable_thinking`, top-level `reasoning_effort`, and a
nested `reasoning: {"effort": ...}` block (the OpenRouter-style convention)
all produced byte-identical output (same token counts, same reasoning length,
same wall time) across repeated real API calls — meaning none of them reached
the template. The one mechanism that DID work: GGUF's persisted per-model
config has `llm.prediction.reasoning.budgetTokens` (a checked/value pair —
checked=False is unlimited/default reasoning, checked=True caps it at
`value` tokens). Verified with a real call: capping it at 1 token dropped a
question from 185 reasoning chars / 138 completion tokens / 17.7s to 0
reasoning chars / 7 completion tokens / 1.8s — a genuine, large effect, not a
no-op. So `reasoning_effort` here means this token-budget cap, not the
template's native semantic levels, and it is GGUF-only: the same key does not
exist anywhere in MLX's or its MTP draft's persisted config (checked
exhaustively — only temperature/promptTemplate under `operation`,
contextLength/numParallelSessions/kvCacheQuantization under `load`). Levels:
  - off:    checked=True,  value=1    (near-zero reasoning)
  - low:    checked=True,  value=256  (a real but small cap)
  - medium: checked=False             (unlimited — the model's own default)

Pre-flight testing (done by hand before writing this final version) found
two things worth recording here so a future reader doesn't repeat the work:

1. context_length is NOT controllable for the MLX backend on this machine.
   LM Studio's "VLM prompt cache" subsystem runs a resource-guardrail
   auto-fit (log category `context_fit`) that silently overrides ANY
   requested `-c` value to the same auto-computed "fitted" context
   (observed: requests of 8000 and 20000 both landed on 36608, confirmed via
   the server log's `configured=X fitted=Y effective=Y` line). So
   context_length is dropped as an MLX factor entirely — including it would
   have wasted combos on a no-op. GGUF's `-c` flag, by contrast, was
   confirmed to work correctly (a request of 16000 produced n_ctx_slot=16128,
   the expected 256-token-aligned rounding) — no auto-fit override exists
   for the GGUF/llama.cpp path in the server log.

2. kv_cache_quant is applied by editing LM Studio's persisted per-model
   default config JSON (undocumented; discovered at
   ~/.lmstudio/.internal/user-concrete-model-default-config/.../*.json)
   since `lms load` has no CLI flag for it. The edit round-trips correctly
   (verified), but no llama.cpp log line naming the applied K/V cache type
   was found to confirm it takes effect at actual load time — treat this
   factor's results as best-effort. If all three levels come back with
   near-identical timing, that is itself the signal that the setting either
   doesn't matter much here or isn't being honored — say so plainly rather
   than assume the edit worked.

context_length and speculative_mtp use documented, verified `lms load` CLI
flags. The GGUF config file is backed up before any edits and restored on
exit regardless of outcome (success, failure, or interruption).

Run fully detached: nohup + caffeinate, output to a log file, minimal stdout.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.agent import LLMProvider, run_agent  # noqa: E402
from src.mcp_client import create_mcp_session  # noqa: E402
from src.score import ExecutionError, score as score_dabstep  # noqa: E402

LMS = str(Path.home() / ".lmstudio" / "bin" / "lms")
GGUF_CONFIG_PATH = (
    Path.home() / ".lmstudio" / ".internal" / "user-concrete-model-default-config"
    / "unsloth" / "Qwen3.8-27B-GGUF" / "Qwen3.8-27B-UD-Q4_K_M.gguf.json"
)
GGUF_MODEL_KEY = "qwen3.8-27b"
MLX_MODEL_KEY = "qwen3.8-27b-mlx"
DATABASE = "agentic_sql_claude"
QUESTION_IDS = ["1417", "2587"]
TASKS_PATH = REPO_ROOT / "data" / "dabstep" / "tasks" / "all.jsonl"
SKILL_PATH = REPO_ROOT / "skill" / "SKILL.md"
OUT_DIR = REPO_ROOT / "results" / "doe_decode_speed"
OUT_DIR.mkdir(parents=True, exist_ok=True)
RUN_TS = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
JSONL_PATH = OUT_DIR / f"doe_{RUN_TS}.jsonl"
SUMMARY_PATH = OUT_DIR / f"doe_{RUN_TS}_summary.txt"
LOG_PATH = OUT_DIR / f"doe_{RUN_TS}.log"

MAX_WALL_SECONDS = 48 * 3600  # backstop only, not a target — user explicitly asked
                               # for a complete run, no early cutoff
LOAD_TIMEOUT_S = 240
POLL_INTERVAL_S = 3
POLL_TIMEOUT_S = 90

KV_QUANT_LEVELS = ["f16", "q8_0", "q4_0"]
CONTEXT_LEVELS = [16000, 65536]  # GGUF only — confirmed reliable via `-c`
SPECULATIVE_LEVELS = [False, True]  # MLX only — context_length is a no-op there (see module docstring)
REASONING_LEVELS = ["medium", "off"]  # GGUF only — see module docstring. "low" skipped per user request;
                                       # ORDER MATTERS: all "medium" combos run before any "off" combo.
REASONING_BUDGET_TOKENS = {"off": 1, "low": 256}  # "medium" -> checked=False (unlimited)

LMS_LOG_DIR = Path.home() / ".lmstudio" / "server-logs"


def newest_server_log() -> Path | None:
    logs = sorted(LMS_LOG_DIR.glob("*/*.log"), key=lambda p: p.stat().st_mtime)
    return logs[-1] if logs else None


def tail_log_since(path: Path, since_pos: int, max_bytes: int = 200_000) -> str:
    """Read whatever was appended to the server log since `since_pos`."""
    try:
        with path.open("r", errors="ignore") as f:
            f.seek(since_pos)
            return f.read(max_bytes)
    except OSError:
        return ""


def log(msg: str) -> None:
    line = f"[{datetime.now():%H:%M:%S}] {msg}"
    print(line, flush=True)


def run_cli(args: list[str], timeout: int = LOAD_TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run([LMS, *args], capture_output=True, text=True, timeout=timeout)


def unload_all() -> None:
    run_cli(["unload", "--all"], timeout=60)


def set_gguf_kv_quant(level: str) -> None:
    """Edit the persisted per-model config to set K/V cache quant type.

    level: "f16" disables the quant toggle (llama.cpp default, uncompressed).
    "q8_0"/"q4_0" enables it with that value for both K and V caches.
    """
    data = json.loads(GGUF_CONFIG_PATH.read_text())
    fields = data["load"]["fields"]
    for f in fields:
        if f["key"] in ("llm.load.llama.kCacheQuantizationType", "llm.load.llama.vCacheQuantizationType"):
            if level == "f16":
                f["value"] = {"checked": False, "value": f["value"].get("value", "q8_0")}
            else:
                f["value"] = {"checked": True, "value": level}
    GGUF_CONFIG_PATH.write_text(json.dumps(data, indent=2))


def set_gguf_reasoning_effort(level: str) -> None:
    """Edit the persisted per-model config's reasoning token-budget cap.

    "off"/"low" enable the cap at a small token count (near-zero / small
    reasoning); "medium" disables the cap (unlimited/default reasoning).
    """
    data = json.loads(GGUF_CONFIG_PATH.read_text())
    fields = data["operation"]["fields"]
    for f in fields:
        if f["key"] == "llm.prediction.reasoning.budgetTokens":
            if level == "medium":
                f["value"] = {"checked": False, "value": f["value"].get("value", 1024)}
            else:
                f["value"] = {"checked": True, "value": REASONING_BUDGET_TOKENS[level]}
    GGUF_CONFIG_PATH.write_text(json.dumps(data, indent=2))


def wait_for_loaded(model_key: str, timeout: int = POLL_TIMEOUT_S) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = run_cli(["ps", "--json"], timeout=20)
        try:
            models = json.loads(r.stdout)
        except (ValueError, TypeError):
            models = []
        for m in models:
            if m.get("identifier") == model_key or m.get("modelKey") == model_key:
                return True
        time.sleep(POLL_INTERVAL_S)
    return False


def gpu_allocated_mib() -> float | None:
    """Best-effort diagnostic: GPU allocated system memory via ioreg, no sudo."""
    try:
        out = subprocess.run(
            ["ioreg", "-r", "-d", "1", "-c", "IOAccelerator"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        import re
        m = re.search(r'"In use system memory"=(\d+)', out)
        return int(m.group(1)) / (1024 * 1024) if m else None
    except Exception:
        return None


def load_gguf(context_length: int, kv_quant: str, reasoning_effort: str) -> bool:
    set_gguf_kv_quant(kv_quant)
    set_gguf_reasoning_effort(reasoning_effort)
    # Force speculative decoding off so it can't silently confound the
    # kv_cache_quant/context_length comparison (a stray log line during
    # pre-flight testing suggested MTP speculative init can fire even
    # without an explicit flag on some loads — force-disable to be sure).
    r = run_cli(["load", GGUF_MODEL_KEY, "-c", str(context_length), "-y", "--no-speculative-draft-mtp"])
    if r.returncode != 0:
        log(f"  load FAILED: {r.stderr[:300]}")
        return False
    return wait_for_loaded(GGUF_MODEL_KEY)


def load_mlx(speculative: bool) -> bool:
    # No -c flag: confirmed during pre-flight that MLX's resource-guardrail
    # auto-fit silently overrides any requested context_length to the same
    # value regardless, so it is not a controllable factor here.
    args = ["load", MLX_MODEL_KEY, "-y"]
    args.append("--speculative-draft-mtp" if speculative else "--no-speculative-draft-mtp")
    r = run_cli(args)
    if r.returncode != 0:
        log(f"  load FAILED: {r.stderr[:300]}")
        return False
    return wait_for_loaded(MLX_MODEL_KEY)


def load_questions() -> dict[str, dict]:
    out = {}
    for line in TASKS_PATH.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if str(r.get("task_id")) in QUESTION_IDS:
            out[str(r["task_id"])] = r
    missing = set(QUESTION_IDS) - set(out)
    if missing:
        raise RuntimeError(f"questions not found in {TASKS_PATH}: {missing}")
    return out


async def run_one_question(model: str, question: dict) -> dict:
    provider = LLMProvider(local=True, reasoning_effort="none")
    md_token = os.environ.get("MOTHERDUCK_TOKEN")
    if not md_token:
        raise RuntimeError("MOTHERDUCK_TOKEN not set in the DOE script's environment")
    skill_text = SKILL_PATH.read_text() if SKILL_PATH.exists() else None
    t0 = time.time()
    err = None
    run = None
    try:
        async with create_mcp_session(session_hint=f"doe-{question['task_id']}", database=DATABASE) as mcp:
            run = await run_agent(
                mcp=mcp, database=DATABASE,
                question=question["question"], guidelines=question.get("guidelines"),
                model=model, provider=provider, skill_text=skill_text,
                max_turns=40,
            )
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"
    elapsed = time.time() - t0
    await provider.aclose()

    if run is None:
        result = score_dabstep(
            execution_result=ExecutionError("RunFailure", err or ""),
            gold_answer=question.get("answer", ""), guidelines=question.get("guidelines"),
            predicted_sql=None,
        )
        n_turns = 0
        prompt_tok = completion_tok = 0
    else:
        exec_result = run.final_rows if run.final_rows is not None else ExecutionError(
            "NoSubmission", "agent did not submit"
        )
        result = score_dabstep(
            execution_result=exec_result, gold_answer=question.get("answer", ""),
            guidelines=question.get("guidelines"), predicted_sql=run.final_sql,
            hit_limit=run.hit_limit,
        )
        n_turns = len(run.tool_calls)
        prompt_tok = run.prompt_tokens
        completion_tok = run.completion_tokens

    return {
        "task_id": question["task_id"], "elapsed_s": round(elapsed, 2),
        "n_turns": n_turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok,
        "decode_proxy_tok_s": round(completion_tok / elapsed, 3) if elapsed > 0 else 0.0,
        "is_correct": result.is_correct, "correctness": result.correctness.value,
        "predicted_answer": str(result.predicted_answer), "error": err,
    }


async def main() -> None:
    t_start = time.time()
    questions = load_questions()
    backup = GGUF_CONFIG_PATH.read_text() if GGUF_CONFIG_PATH.exists() else None

    # effort is the OUTERMOST loop: run the entire experiment on "medium"
    # before starting any "off" combo, per explicit user request — not
    # interleaved.
    combos = []
    for effort in REASONING_LEVELS:
        for kv in KV_QUANT_LEVELS:
            for ctx in CONTEXT_LEVELS:
                combos.append({"engine": "gguf", "model": GGUF_MODEL_KEY,
                                "kv_cache_quant": kv, "context_length": ctx,
                                "reasoning_effort": effort})
    for spec in SPECULATIVE_LEVELS:
        combos.append({"engine": "mlx", "model": MLX_MODEL_KEY, "speculative_mtp": spec,
                        "reasoning_effort": "not_controllable_on_mlx"})

    log(f"DOE start: {len(combos)} combos x {len(questions)} questions -> "
        f"{len(combos) * len(questions)} runs. Budget cap {MAX_WALL_SECONDS/3600:.1f}h. "
        f"Output: {JSONL_PATH.name}")

    jf = JSONL_PATH.open("w")
    try:
        for i, combo in enumerate(combos):
            if time.time() - t_start > MAX_WALL_SECONDS:
                log(f"SAFETY STOP: {MAX_WALL_SECONDS/3600:.1f}h budget reached before combo {i+1}/{len(combos)}")
                break

            log(f"combo {i+1}/{len(combos)}: {combo}")
            unload_all()
            time.sleep(2)

            log_path = newest_server_log()
            log_pos = log_path.stat().st_size if log_path else 0

            if combo["engine"] == "gguf":
                ok = load_gguf(combo["context_length"], combo["kv_cache_quant"], combo["reasoning_effort"])
            else:
                ok = load_mlx(combo["speculative_mtp"])

            if not ok:
                log("  load did not confirm 'loaded' state within timeout — skipping combo")
                jf.write(json.dumps({"combo": combo, "load_failed": True,
                                      "ts": datetime.now(timezone.utc).isoformat()}) + "\n")
                jf.flush()
                continue

            # Best-effort verification snippet: whatever the server logged
            # during this specific load (context_fit / speculative-init /
            # n_ctx_slot lines), so results can be audited against what
            # actually happened, not just what was requested.
            load_log_snippet = ""
            if log_path is not None:
                new_log_path = newest_server_log()  # may have rotated during load
                snippet = tail_log_since(new_log_path, log_pos if new_log_path == log_path else 0)
                keep = [ln for ln in snippet.splitlines()
                        if any(k in ln for k in ("context_fit", "n_ctx_slot", "speculative", "draft"))]
                load_log_snippet = "\n".join(keep[:10])

            gpu_mib = gpu_allocated_mib()
            for qid in QUESTION_IDS:
                q = questions[qid]
                try:
                    result = await run_one_question(combo["model"], q)
                except Exception as e:  # noqa: BLE001
                    result = {"task_id": qid, "error": f"{type(e).__name__}: {e}"}
                row = {"combo": combo, "gpu_allocated_mib_at_load": gpu_mib,
                       "load_log_snippet": load_log_snippet, **result,
                       "ts": datetime.now(timezone.utc).isoformat()}
                jf.write(json.dumps(row) + "\n")
                jf.flush()
                log(f"  {qid}: elapsed={result.get('elapsed_s')}s "
                    f"turns={result.get('n_turns')} correct={result.get('is_correct')} "
                    f"decode_proxy={result.get('decode_proxy_tok_s')}")
    finally:
        jf.close()
        unload_all()
        if backup is not None:
            GGUF_CONFIG_PATH.write_text(backup)
            log("restored original GGUF config file")

    write_summary()
    log(f"DOE done in {(time.time()-t_start)/3600:.2f}h. Summary: {SUMMARY_PATH.name}")


def write_summary() -> None:
    rows = []
    for line in JSONL_PATH.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if not r.get("load_failed") and "elapsed_s" in r:
            rows.append(r)

    by_combo: dict[str, list[dict]] = {}
    for r in rows:
        key = json.dumps(r["combo"], sort_keys=True)
        by_combo.setdefault(key, []).append(r)

    lines = [f"DOE summary — {len(rows)} scored runs across {len(by_combo)} combos", ""]
    for key, group in sorted(by_combo.items()):
        combo = json.loads(key)
        n = len(group)
        avg_elapsed = sum(g["elapsed_s"] for g in group) / n
        avg_decode = sum(g["decode_proxy_tok_s"] for g in group) / n
        n_correct = sum(1 for g in group if g.get("is_correct"))
        lines.append(
            f"{combo} -> n={n} avg_elapsed={avg_elapsed:.1f}s "
            f"avg_decode_proxy={avg_decode:.2f}tok/s correct={n_correct}/{n}"
        )
    SUMMARY_PATH.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
