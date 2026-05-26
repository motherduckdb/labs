import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import duckdb
import requests

from analyze import build_eval_views
from connections_eval.core import ConnectionsGame, EvalRunFailedError, GameState, JsonLog, Puzzle, PuzzleGroup, _new_run_token


PROJECT_ROOT = Path(__file__).resolve().parents[1]
INPUTS = PROJECT_ROOT / "inputs"


def make_puzzle() -> Puzzle:
    groups = [
        PuzzleGroup(name="Group A", color="yellow", words=["A1", "A2", "A3", "A4"]),
        PuzzleGroup(name="Group B", color="green", words=["B1", "B2", "B3", "B4"]),
        PuzzleGroup(name="Group C", color="blue", words=["C1", "C2", "C3", "C4"]),
        PuzzleGroup(name="Group D", color="purple", words=["D1", "D2", "D3", "D4"]),
    ]
    words = [word for group in groups for word in group.words]
    return Puzzle(id=9999, date="2026-03-31", difficulty=1.0, words=words, groups=groups)


def guess_response(*words: str) -> dict:
    guess = ", ".join(words)
    content = f"<guess>{guess}</guess>"
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "cost": 0.01},
    }


class CoreInvariantTests(unittest.TestCase):
    def make_game(self, log_dir: Path) -> ConnectionsGame:
        game = ConnectionsGame(INPUTS, log_dir, seed=123)
        game.log = JsonLog(log_dir, log_id="test-log")
        game.run_id = "test-run"
        return game

    def run_puzzle(self, responses: list[dict]):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            game = self.make_game(log_dir)
            puzzle = make_puzzle()

            with (
                patch("connections_eval.core._openrouter_chat", side_effect=responses) as mock_chat,
                patch("connections_eval.core.cl.state_move"),
                patch("connections_eval.core.cl.model_prompt"),
                patch("connections_eval.core.cl.model_completion"),
            ):
                result = game._run_puzzle(puzzle, "haiku-4.5")

            rows = [json.loads(line) for line in game.log.path.read_text().splitlines()]
            return result, mock_chat.call_count, rows

    def test_run_evaluation_rejects_non_positive_puzzle_counts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            game = ConnectionsGame(INPUTS, Path(tmpdir), seed=1)

            for value in (0, -1):
                with self.subTest(value=value):
                    with self.assertRaisesRegex(ValueError, "max_puzzles must be positive"):
                        game.run_evaluation("haiku-4.5", max_puzzles=value)

    def test_run_tokens_are_unique_for_same_timestamp(self):
        fixed_now = datetime(2026, 3, 31, 12, 0, 0)
        first = _new_run_token(fixed_now)
        second = _new_run_token(fixed_now)
        self.assertNotEqual(first, second)

    def test_json_log_file_names_are_unique(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            first = JsonLog(log_dir)
            second = JsonLog(log_dir)
            self.assertNotEqual(first.path.name, second.path.name)

    def test_invalid_responses_still_hit_invalid_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            game = self.make_game(Path(tmpdir))
            state = GameState(puzzle=make_puzzle(), solved_groups=set())

            for _ in range(3):
                game._process_guess(state, "<guess>C1, C1, C2, C3</guess>")

            self.assertEqual(state.invalid_count, 3)
            self.assertTrue(state.finished)
            self.assertFalse(state.won)

    def test_puzzle_stops_after_six_total_turns(self):
        responses = [
            guess_response("A1", "A2", "A3", "A4"),
            guess_response("C1", "C1", "C2", "C3"),
            guess_response("B1", "B2", "B3", "B4"),
            guess_response("D1", "D1", "D2", "D3"),
            guess_response("C1", "C2", "D1", "D2"),
            guess_response("C1", "C3", "D1", "D3"),
            guess_response("C1", "C2", "C3", "C4"),
        ]

        result, call_count, rows = self.run_puzzle(responses)

        self.assertEqual(call_count, 6)
        self.assertFalse(result.won)
        self.assertEqual(result.guess_count, 4)
        self.assertEqual(result.invalid_count, 2)
        self.assertEqual(result.mistake_count, 2)
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[-1]["guess_index"], 6)
        self.assertEqual(rows[-1]["result"], "INCORRECT. OUT OF GUESSES.")

    def test_third_solved_group_auto_solves_the_puzzle_early(self):
        responses = [
            guess_response("A1", "A2", "A3", "A4"),
            guess_response("C1", "C1", "C2", "C3"),
            guess_response("B1", "B2", "B3", "B4"),
            guess_response("C1", "C2", "D1", "D2"),
            guess_response("C1", "C2", "C3", "C4"),
            guess_response("D1", "D2", "D3", "D4"),
            guess_response("A1", "B1", "C1", "D1"),
        ]

        result, call_count, rows = self.run_puzzle(responses)

        self.assertEqual(call_count, 5)
        self.assertTrue(result.won)
        self.assertEqual(result.guess_count, 4)
        self.assertEqual(result.invalid_count, 1)
        self.assertEqual(result.mistake_count, 1)
        self.assertEqual(len(result.solved_groups), 4)
        self.assertEqual(rows[-1]["guess_index"], 5)
        self.assertEqual(rows[-1]["result"], "CORRECT")

    def test_sixth_turn_auto_solves_last_group_by_elimination(self):
        responses = [
            guess_response("A1", "A2", "A3", "A4"),
            guess_response("B1", "B2", "B3", "B4"),
            guess_response("C1", "C2", "D1", "D2"),
            guess_response("C1", "C3", "D1", "D3"),
            guess_response("C1", "C4", "D1", "D4"),
            guess_response("C1", "C2", "C3", "C4"),
            guess_response("D1", "D2", "D3", "D4"),
        ]

        result, call_count, rows = self.run_puzzle(responses)

        self.assertEqual(call_count, 6)
        self.assertTrue(result.won)
        self.assertEqual(result.guess_count, 6)
        self.assertEqual(result.mistake_count, 3)
        self.assertEqual(len(result.solved_groups), 4)
        self.assertEqual(rows[-1]["guess_index"], 6)
        self.assertEqual(rows[-1]["result"], "CORRECT")

    def test_analysis_views_exclude_incomplete_runs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            log_path = log_dir / "connections_eval_test.jsonl"
            rows = [
                {
                    "timestamp": "2026-03-31T12:00:00Z",
                    "message": "exchange",
                    "run_id": "complete-run",
                    "model": "model-a",
                    "puzzle_id": 1,
                    "guess_index": 1,
                    "result": "CORRECT",
                    "latency_ms": 100,
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "cost": 0.01,
                },
                {
                    "timestamp": "2026-03-31T12:00:01Z",
                    "message": "summary",
                    "run_id": "complete-run",
                    "model": "model-a",
                    "puzzles_attempted": 1,
                    "puzzles_solved": 1,
                    "avg_time_sec": 1.0,
                    "total_cost": 0.01,
                },
                {
                    "timestamp": "2026-03-31T12:00:02Z",
                    "message": "exchange",
                    "run_id": "failed-run",
                    "model": "model-a",
                    "puzzle_id": 1,
                    "guess_index": 1,
                    "result": "INCORRECT",
                    "latency_ms": 200,
                    "prompt_tokens": 20,
                    "completion_tokens": 10,
                    "cost": 0.02,
                },
                {
                    "timestamp": "2026-03-31T12:00:03Z",
                    "message": "summary",
                    "run_id": "failed-run",
                    "model": "model-a",
                    "status": "failed",
                    "puzzles_attempted": 0,
                    "puzzles_solved": 0,
                    "avg_time_sec": 0.0,
                    "total_cost": 0.0,
                },
                {
                    "timestamp": "2026-03-31T12:00:04Z",
                    "message": "exchange",
                    "run_id": "partial-run",
                    "model": "model-a",
                    "puzzle_id": 1,
                    "guess_index": 1,
                    "result": "INCORRECT",
                    "latency_ms": 200,
                    "prompt_tokens": 20,
                    "completion_tokens": 10,
                    "cost": 0.02,
                },
            ]
            log_path.write_text("".join(json.dumps(row) + "\n" for row in rows))

            conn = duckdb.connect()
            build_eval_views(conn, log_dir=log_dir)

            total_runs = conn.execute("SELECT COUNT(DISTINCT run_id) FROM exchanges").fetchone()[0]
            completed_runs = conn.execute("SELECT COUNT(DISTINCT run_id) FROM completed_exchanges").fetchone()[0]
            completed_run_id = conn.execute("SELECT run_id FROM completed_exchanges").fetchone()[0]

            self.assertEqual(total_runs, 3)
            self.assertEqual(completed_runs, 1)
            self.assertEqual(completed_run_id, "complete-run")

    def test_failed_run_writes_error_rows_and_summary(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir)
            game = ConnectionsGame(INPUTS, log_dir, seed=1)
            game.puzzles = [make_puzzle()]

            response = requests.Response()
            response.status_code = 429
            response.encoding = "utf-8"
            response.headers["x-request-id"] = "req_test_123"
            response._content = b'{"error":"rate limit"}'
            response.url = "https://openrouter.ai/api/v1/chat/completions"
            response.request = requests.Request("POST", response.url).prepare()
            error = requests.HTTPError("429 Client Error: Too Many Requests", response=response)

            with (
                patch("connections_eval.core._openrouter_chat", side_effect=error),
                patch("connections_eval.core.cl.state_move") as mock_state_move,
                patch("connections_eval.core.cl.model_prompt"),
                patch("connections_eval.core.cl.model_completion"),
            ):
                with self.assertRaises(EvalRunFailedError) as ctx:
                    game.run_evaluation("haiku-4.5", max_puzzles=1)

            summary = ctx.exception.summary
            log_path = next(log_dir.glob("connections_eval_*.jsonl"))
            rows = [json.loads(line) for line in log_path.read_text().splitlines()]

            self.assertEqual(summary["status"], "failed")
            self.assertEqual(summary["puzzles_attempted"], 0)
            self.assertEqual(summary["puzzles_targeted"], 1)
            self.assertEqual(summary["failed_puzzle_id"], 9999)
            self.assertEqual(summary["status_code"], 429)
            self.assertEqual(summary["request_id"], "req_test_123")
            self.assertIn("rate limit", summary["response_body_excerpt"])
            self.assertEqual([row["message"] for row in rows], ["puzzle_error", "summary"])
            self.assertEqual(rows[0]["guess_index"], 1)
            self.assertEqual(rows[-1]["status"], "failed")
            self.assertEqual(mock_state_move.call_args_list[-1].kwargs["to"], "FAILED")


if __name__ == "__main__":
    unittest.main()
