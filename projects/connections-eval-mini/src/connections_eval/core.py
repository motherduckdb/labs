"""Eval engine for Connections puzzles.

Everything in one file: OpenRouter API adapter, JSONL logging,
response parsing, game logic, and evaluation orchestration.
"""

import json
import logging
import os
import random
import re
import tempfile
import time
import uuid
import yaml
import requests
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import controllog as cl
from eval_shared import locked_file


# ---------------------------------------------------------------------------
# OpenRouter API
# ---------------------------------------------------------------------------

_or_logger = logging.getLogger("openrouter")
_OPENROUTER_LOCK_PATH = Path(tempfile.gettempdir()) / "connections-eval-mini-openrouter.lock"
_OPENROUTER_LOCK_TIMEOUT_SEC = 900.0


def _get_api_key() -> str:
    key = os.getenv("OPENROUTER_API_KEY")
    if not key:
        raise ValueError("OPENROUTER_API_KEY not set. Get one at https://openrouter.ai/keys")
    return key


def _truncate_text(value: Optional[str], limit: int = 1000) -> Optional[str]:
    if value is None:
        return None
    collapsed = re.sub(r"\s+", " ", value).strip()
    if not collapsed:
        return None
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(0, limit - 3)] + "..."


def _exception_context(exc: Exception) -> dict[str, Any]:
    details: dict[str, Any] = {
        "error_type": type(exc).__name__,
        "error_message": str(exc) or repr(exc),
    }

    if isinstance(exc, requests.RequestException):
        response = exc.response
        if response is not None:
            details["status_code"] = response.status_code
            request_id = response.headers.get("x-request-id") or response.headers.get("request-id")
            if request_id:
                details["request_id"] = request_id
            body_excerpt = _truncate_text(response.text)
            if body_excerpt:
                details["response_body_excerpt"] = body_excerpt

    return details


@contextmanager
def _openrouter_request_slot():
    with locked_file(_OPENROUTER_LOCK_PATH, timeout_sec=_OPENROUTER_LOCK_TIMEOUT_SEC) as locked:
        yield locked.wait_ms


class EvalRunFailedError(RuntimeError):
    """Raised after a run writes a failure summary."""

    def __init__(self, summary: dict[str, Any]):
        self.summary = summary
        puzzle_id = summary.get("failed_puzzle_id")
        location = f" on puzzle {puzzle_id}" if puzzle_id is not None else ""
        error_type = summary.get("error_type", "Error")
        error_message = summary.get("error_message", "run failed")
        super().__init__(f"Run {summary.get('run_id', '<unknown>')}{location} failed: {error_type}: {error_message}")


def _openrouter_chat(messages: list[dict], model: str, is_thinking: bool = False) -> dict:
    """Call OpenRouter Chat Completions API with simple retry."""
    headers = {
        "Authorization": f"Bearer {_get_api_key()}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/matsonj/eval-connections-mini",
        "X-Title": "Eval Connections Mini",
    }
    payload: dict = {"model": model, "messages": messages, "usage": {"include": True}}
    timeout = 300

    if is_thinking:
        timeout = 600  # reasoning models need more time
        payload["reasoning"] = {"effort": "none"}
    else:
        payload["max_tokens"] = 25000
        payload["temperature"] = 0.0

    last_err: Exception | None = None
    for attempt in range(4):
        try:
            with _openrouter_request_slot() as wait_ms:
                if wait_ms >= 250:
                    _or_logger.info(f"Waited {wait_ms}ms for OpenRouter request slot")
                resp = requests.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    json=payload, headers=headers, timeout=timeout,
                )
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, TimeoutError) as e:
            last_err = e
            if attempt == 3:
                break
            delay = (2 ** attempt) + random.uniform(0, 0.5)
            error_context = _exception_context(e)
            detail_parts = [f"{error_context['error_type']}: {error_context['error_message']}"]
            if error_context.get("status_code") is not None:
                detail_parts.append(f"status={error_context['status_code']}")
            if error_context.get("request_id"):
                detail_parts.append(f"request_id={error_context['request_id']}")
            if error_context.get("response_body_excerpt"):
                detail_parts.append(f"body={error_context['response_body_excerpt']}")
            _or_logger.warning(f"Attempt {attempt + 1} failed: {', '.join(detail_parts)}. Retrying in {delay:.1f}s...")
            time.sleep(delay)
    raise last_err  # type: ignore[misc]


# ---------------------------------------------------------------------------
# JSONL logging & response parsing
# ---------------------------------------------------------------------------

class JsonLog:
    """Append-only JSONL log file."""

    def __init__(self, log_dir: Path, log_id: Optional[str] = None):
        log_dir.mkdir(parents=True, exist_ok=True)
        log_id = log_id or _new_run_token()
        self.path = log_dir / f"connections_eval_{log_id}.jsonl"

    def write(self, kind: str, data: dict) -> None:
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        row = {"timestamp": timestamp, "message": kind, **data}
        with open(self.path, "a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _extract_tokens(response: dict) -> tuple[Optional[int], Optional[int]]:
    """Extract (prompt_tokens, completion_tokens) from API response."""
    usage = response.get("usage", {})
    return usage.get("prompt_tokens"), usage.get("completion_tokens")


def _extract_cost(response: dict) -> Optional[float]:
    """Extract cost (USD). For BYOK, falls back to upstream_inference_cost."""
    usage = response.get("usage", {})
    cost = usage.get("cost")
    if cost and cost > 0:
        return cost
    upstream = usage.get("cost_details", {}).get("upstream_inference_cost")
    if upstream and upstream > 0:
        return upstream
    return cost


def _new_run_token(now: Optional[datetime] = None) -> str:
    """Build a readable token that stays unique for rapid repeated runs."""
    now = now or datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S-%f")
    suffix = uuid.uuid4().hex[:6]
    return f"{stamp}-{suffix}"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class PuzzleGroup:
    name: str
    color: str
    words: list[str]


@dataclass
class Puzzle:
    id: int
    date: str
    difficulty: float
    words: list[str]
    groups: list[PuzzleGroup]


@dataclass
class PuzzleResult:
    won: bool
    guess_count: int
    mistake_count: int
    invalid_count: int
    solved_groups: list[str]
    time_sec: float
    total_tokens: int
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_cost: float = 0.0


@dataclass
class GameState:
    puzzle: Puzzle
    solved_groups: set[str]
    turn_count: int = 0
    guess_count: int = 0
    mistake_count: int = 0
    invalid_count: int = 0
    finished: bool = False
    won: bool = False


# ---------------------------------------------------------------------------
# Game engine
# ---------------------------------------------------------------------------

class ConnectionsGame:
    MAX_GUESSES = 6
    MAX_MISTAKES = 4
    MAX_INVALID = 3
    PROJECT_ID = "connections_eval_mini"

    def __init__(self, inputs_path: Path, log_path: Path, seed: Optional[int] = None):
        self.inputs_path = inputs_path
        self.log_path = log_path
        self.seed = seed or int(time.time())
        self.rng = random.Random(self.seed)

        self.puzzles = self._load_puzzles()
        self.prompt_template = (inputs_path / "prompt_template.xml").read_text()
        self.model_config, self.thinking_models = self._load_model_config()

        self.log = None
        self.run_id = None

    def _load_puzzles(self) -> list[Puzzle]:
        with open(self.inputs_path / "puzzles.yml") as f:
            data = yaml.safe_load(f)
        return [
            Puzzle(
                id=p["id"], date=p["date"], difficulty=p["difficulty"],
                words=p["words"],
                groups=[PuzzleGroup(**g) for g in p["groups"]],
            )
            for p in data["puzzles"]
        ]

    def _load_model_config(self) -> tuple[dict[str, str], set[str]]:
        with open(self.inputs_path / "models.yml") as f:
            data = yaml.safe_load(f)
        models: dict[str, str] = {}
        thinking_ids: set[str] = set()
        for name, model_id in data["models"].get("thinking", {}).items():
            models[name] = model_id
            thinking_ids.add(model_id)
        for name, model_id in data["models"].get("non_thinking", {}).items():
            models[name] = model_id
        for name, model_id in data["models"].get("free", {}).items():
            models[name] = model_id
        return models, thinking_ids

    # ------------------------------------------------------------------
    # Run evaluation
    # ------------------------------------------------------------------

    def run_evaluation(self, model_name: str, max_puzzles: Optional[int] = None) -> dict[str, Any]:
        """Run puzzles sequentially against a model. Returns summary dict."""
        if max_puzzles is not None and max_puzzles <= 0:
            raise ValueError("max_puzzles must be positive")

        run_token = _new_run_token()
        self.run_id = f"{run_token}_{model_name}"
        self.log = JsonLog(self.log_path, log_id=run_token)
        cl.init(project_id=self.PROJECT_ID, log_dir=self.log_path)

        puzzles_to_run = self.puzzles.copy()
        self.rng.shuffle(puzzles_to_run)
        if max_puzzles is not None:
            puzzles_to_run = puzzles_to_run[:max_puzzles]

        results: list[PuzzleResult] = []
        failed_exc: Exception | None = None
        failed_puzzle_id: Optional[int] = None
        failure_context: dict[str, Any] = {}

        for puzzle in puzzles_to_run:
            try:
                results.append(self._run_puzzle(puzzle, model_name))
            except Exception as exc:
                failed_exc = exc
                failed_puzzle_id = puzzle.id
                failure_context = _exception_context(exc)
                break

        summary = {
            "run_id": self.run_id,
            "model": model_name,
            "status": "failed" if failed_exc else "completed",
            "seed": self.seed,
            "puzzles_attempted": len(results),
            "puzzles_targeted": len(puzzles_to_run),
            "puzzles_solved": sum(r.won for r in results),
            "total_guesses": sum(r.guess_count for r in results),
            "correct_guesses": sum(r.guess_count - r.mistake_count for r in results),
            "incorrect_guesses": sum(r.mistake_count for r in results),
            "invalid_responses": sum(r.invalid_count for r in results),
            "total_time_sec": round(sum(r.time_sec for r in results), 1),
            "avg_time_sec": round(sum(r.time_sec for r in results) / len(results), 1) if results else 0,
            "total_tokens": sum(r.total_tokens for r in results),
            "total_prompt_tokens": sum(r.total_prompt_tokens for r in results),
            "total_completion_tokens": sum(r.total_completion_tokens for r in results),
            "total_cost": sum(r.total_cost for r in results),
        }

        if failed_exc is not None:
            summary.update({
                "failed_puzzle_id": failed_puzzle_id,
                **failure_context,
            })

        self.log.write("summary", summary)
        if failed_exc is not None:
            raise EvalRunFailedError(summary) from failed_exc
        return summary

    # ------------------------------------------------------------------
    # Single puzzle
    # ------------------------------------------------------------------

    def _run_puzzle(self, puzzle: Puzzle, model_name: str) -> PuzzleResult:
        model_id = self.model_config[model_name]
        is_thinking = model_id in self.thinking_models
        task_id = f"T{puzzle.id}:{self.run_id}"
        state = GameState(puzzle=puzzle, solved_groups=set())

        messages = self._build_messages(puzzle)
        total_tokens = total_prompt = total_completion = 0
        total_cost = 0.0

        start_time = time.time()
        cl.state_move(
            task_id=task_id, from_="NEW", to="WIP",
            project_id=self.PROJECT_ID, agent_id="agent:connections_eval",
            run_id=self.run_id, payload={"puzzle_id": puzzle.id},
        )

        try:
            while not state.finished:
                call_start = time.time()
                response = _openrouter_chat(messages, model_id, is_thinking=is_thinking)
                elapsed_ms = int((time.time() - call_start) * 1000)

                if "choices" not in response or not response["choices"]:
                    _or_logger.warning(f"No choices in response: {response.get('error', response)}")
                    content = ""
                else:
                    msg = response["choices"][0]["message"]
                    content = (msg.get("content") or msg.get("reasoning") or "").strip()
                structured = self._parse_structured(content)

                prompt_tokens, completion_tokens = _extract_tokens(response)
                total_prompt += prompt_tokens or 0
                total_completion += completion_tokens or 0
                total_tokens += (prompt_tokens or 0) + (completion_tokens or 0)
                cost = _extract_cost(response)
                if cost:
                    total_cost += cost

                result = self._process_guess(state, content)

                self.log.write("exchange", {
                    "run_id": self.run_id, "model": model_name,
                    "puzzle_id": puzzle.id, "guess_index": state.turn_count,
                    "request": messages[-1]["content"], "response": content,
                    "thinking": structured["thinking"],
                    "guess": structured["guess"],
                    "confidence": structured["confidence"],
                    "latency_ms": elapsed_ms,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "cost": cost, "result": result,
                })

                # Controllog: balanced double-entry telemetry
                exchange_id = cl.new_id()
                cl.model_prompt(
                    task_id=task_id, agent_id="agent:connections_eval",
                    run_id=self.run_id, project_id=self.PROJECT_ID,
                    provider="openrouter", model=model_id,
                    prompt_tokens=prompt_tokens or 0,
                    request_text=messages[-1]["content"],
                    payload={"puzzle_id": puzzle.id, "guess_index": state.turn_count},
                    exchange_id=exchange_id,
                )
                cl.model_completion(
                    task_id=task_id, agent_id="agent:connections_eval",
                    run_id=self.run_id, project_id=self.PROJECT_ID,
                    provider="openrouter", model=model_id,
                    completion_tokens=completion_tokens or 0, wall_ms=elapsed_ms,
                    response_text=content, cost_money=cost,
                    payload={"puzzle_id": puzzle.id, "guess_index": state.turn_count, "result": result},
                    exchange_id=exchange_id,
                )

                # Multi-turn: append response and feedback
                messages.append({"role": "assistant", "content": content})
                if not state.finished:
                    messages.append({"role": "user", "content": result})
        except Exception as exc:
            error_context = _exception_context(exc)
            self.log.write("puzzle_error", {
                "run_id": self.run_id,
                "model": model_name,
                "puzzle_id": puzzle.id,
                "guess_index": state.turn_count + 1,
                "request": messages[-1]["content"],
                **error_context,
            })
            cl.state_move(
                task_id=task_id, from_="WIP", to="FAILED",
                project_id=self.PROJECT_ID, agent_id="agent:connections_eval",
                run_id=self.run_id,
                payload={"puzzle_id": puzzle.id, **{
                    key: value for key, value in error_context.items()
                    if key in {"error_type", "error_message", "status_code", "request_id"}
                }},
            )
            raise

        time_sec = time.time() - start_time

        cl.state_move(
            task_id=task_id, from_="WIP", to="DONE" if state.won else "FAILED",
            project_id=self.PROJECT_ID, agent_id="agent:connections_eval",
            run_id=self.run_id, payload={"puzzle_id": puzzle.id},
        )

        return PuzzleResult(
            won=state.won, guess_count=state.guess_count,
            mistake_count=state.mistake_count, invalid_count=state.invalid_count,
            solved_groups=list(state.solved_groups), time_sec=time_sec,
            total_tokens=total_tokens, total_prompt_tokens=total_prompt,
            total_completion_tokens=total_completion, total_cost=total_cost,
        )

    # ------------------------------------------------------------------
    # Prompt construction
    # ------------------------------------------------------------------

    def _build_messages(self, puzzle: Puzzle) -> list[dict]:
        shuffled = puzzle.words.copy()
        self.rng.shuffle(shuffled)
        rendered = (
            self.prompt_template
            .replace("{{WORDS}}", ", ".join(shuffled))
            .replace("{{PUZZLE_ID}}", str(puzzle.id))
            .replace("{{DIFFICULTY}}", str(puzzle.difficulty))
        )
        system = re.search(r"<system>(.*?)</system>", rendered, re.DOTALL).group(1).strip()
        user = re.search(r"<user>(.*?)</user>", rendered, re.DOTALL).group(1).strip()
        words = re.search(r"<puzzle>(.*?)</puzzle>", rendered, re.DOTALL).group(1).strip()

        return [
            {"role": "system", "content": system},
            {"role": "user", "content": f"{user}\n\nAvailable words: {words}"},
        ]

    # ------------------------------------------------------------------
    # Guess processing
    # ------------------------------------------------------------------

    def _process_guess(self, state: GameState, response: str) -> str:
        words = self._parse_guess_words(response)
        state.turn_count += 1
        out_of_turns = state.turn_count >= self.MAX_GUESSES

        error = self._validate_guess(state, words)
        if error:
            state.invalid_count += 1
            remaining = self._remaining_words(state)
            msg = f"INVALID_RESPONSE: {error}. Available words: {', '.join(sorted(remaining))}."
            if state.invalid_count >= self.MAX_INVALID or out_of_turns:
                state.finished = True
            return msg

        state.guess_count += 1

        for group in state.puzzle.groups:
            if set(words) == set(group.words):
                state.solved_groups.add(group.color)
                if len(state.solved_groups) >= len(state.puzzle.groups):
                    state.finished = True
                    state.won = True
                    return "CORRECT"
                if self._maybe_auto_solve_last_group(state):
                    return "CORRECT"
                if out_of_turns:
                    state.finished = True
                    return "CORRECT. OUT OF GUESSES."
                return "CORRECT. NEXT GUESS?"

        # Incorrect — check one-away
        one_away = any(
            len(set(words) & {w.upper() for w in g.words}) == 3
            for g in state.puzzle.groups if g.color not in state.solved_groups
        )
        state.mistake_count += 1
        if state.mistake_count >= self.MAX_MISTAKES or out_of_turns:
            state.finished = True

        if out_of_turns:
            if one_away:
                return "INCORRECT - ONE AWAY. OUT OF GUESSES."
            return "INCORRECT. OUT OF GUESSES."

        remaining = self.MAX_MISTAKES - state.mistake_count
        if one_away:
            return f"INCORRECT - ONE AWAY. {remaining} INCORRECT GUESSES REMAINING."
        return f"INCORRECT. {remaining} INCORRECT GUESSES REMAINING."

    def _parse_guess_words(self, response: str) -> list[str]:
        """Extract 4 guessed words from model response."""
        cleaned = re.sub(r"<thinking>.*?</thinking>", "", response, flags=re.IGNORECASE | re.DOTALL)
        cleaned = re.sub(r"<thinking>.*", "", cleaned, flags=re.IGNORECASE | re.DOTALL)

        match = re.search(r"<guess>(.*?)</guess>", cleaned, re.IGNORECASE | re.DOTALL)
        if match:
            return [w.strip().upper() for w in match.group(1).split(",") if w.strip()]

        caps = re.search(r"\b[A-Z][A-Z\s]*\b(?:\s*,\s*[A-Z][A-Z\s]*\b){3}", cleaned)
        if caps:
            return [w.strip().upper() for w in caps.group().split(",") if w.strip()]

        return [w.strip().upper() for w in cleaned.split(",") if w.strip()]

    def _parse_structured(self, response: str) -> dict[str, str]:
        result = {"thinking": "", "guess": "", "confidence": ""}
        for tag in result:
            m = re.search(rf"<{tag}>(.*?)</{tag}>", response, re.IGNORECASE | re.DOTALL)
            if m:
                result[tag] = m.group(1).strip()
        return result

    def _validate_guess(self, state: GameState, words: list[str]) -> Optional[str]:
        if len(words) != 4:
            return f"Expected 4 words, got {len(words)}"
        if len(set(words)) != 4:
            return "Duplicate words"
        puzzle_words = {w.upper() for w in state.puzzle.words}
        for w in words:
            if w not in puzzle_words:
                return f"'{w}' not in puzzle"
        solved = {w.upper() for g in state.puzzle.groups if g.color in state.solved_groups for w in g.words}
        for w in words:
            if w in solved:
                return f"'{w}' already solved"
        return None

    def _remaining_words(self, state: GameState) -> list[str]:
        solved = {w.upper() for g in state.puzzle.groups if g.color in state.solved_groups for w in g.words}
        return [w.upper() for w in state.puzzle.words if w.upper() not in solved]

    def _maybe_auto_solve_last_group(self, state: GameState) -> bool:
        """Solve the last group by elimination once only one remains."""
        remaining_groups = [g for g in state.puzzle.groups if g.color not in state.solved_groups]
        if len(remaining_groups) != 1:
            return False

        state.solved_groups.add(remaining_groups[0].color)
        state.finished = True
        state.won = True
        return True
