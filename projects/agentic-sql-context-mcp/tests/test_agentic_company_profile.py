from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import AsyncMock, patch

import controllog
from click.testing import CliRunner

from src import guides_load
from src.agent import (
    RunState,
    _make_tools,
    _resolve_hit_limit,
    build_agentic_company_system_prompt,
    build_system_prompt,
)
from src.agentic_company_score import answers_match, format_answer, score
from src.mcp_client import MCPSession, _attach_trusted_share, _read_only_violation
from src.run import (
    AGENTIC_COMPANY_BENCHMARK,
    AGENTIC_COMPANY_DATABASE_BYTES,
    AGENTIC_COMPANY_DATABASE_SHA256,
    AGENTIC_COMPANY_GUIDE_TOPIC,
    AGENTIC_COMPANY_SHARE,
    AGENTIC_COMPANY_SKILL_PATH,
    AGENTIC_COMPANY_SNAPSHOT_CUTOFF,
    _build_run_provenance,
    _load_questions,
    _resolve_agentic_paths,
    _validate_agentic_manifest,
    cli,
)
from src.score import Correctness, ExecutionError

CANONICAL_QUESTIONS = _resolve_agentic_paths()[0]


def _fixture_question(
    task_id: str = "AC-001",
    *,
    criteria: dict | None = None,
    answer: str = "13",
) -> dict:
    return {
        "task_id": task_id,
        "topic_id": "T01",
        "topic": "Fixture topic",
        "level": "easy",
        "question": "How many fixture rows exist?",
        "guidelines": "Answer with a whole number.",
        "answer_criteria": criteria
        or {"type": "number", "decimals": 0, "tolerance": 0, "shape": "integer"},
        "answer": answer,
        "snapshot_cutoff": "2026-07-31",
        "source_tables": ["catalog.skus"],
    }


def _fixture_questions() -> list[dict]:
    questions: list[dict] = []
    for index in range(1, 41):
        topic_number = (index - 1) // 4 + 1
        question = _fixture_question(f"AC-{index:03d}")
        question["topic_id"] = f"T{topic_number:02d}"
        question["topic"] = f"Fixture topic {topic_number:02d}"
        question["level"] = "easy" if (index - 1) % 4 == 0 else "hard"
        questions.append(question)
    return questions


def _write_benchmark_fixture(directory: Path, questions: list[dict]) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    questions_path = directory / "questions.jsonl"
    manual_path = directory / "manual.md"
    questions_path.write_text("\n".join(json.dumps(question) for question in questions) + "\n")
    manual_path.write_text("# Agentic Company analyst field manual\n\nFixture manual.\n")
    distribution: dict[str, int] = {}
    for question in questions:
        level = question["level"]
        distribution[level] = distribution.get(level, 0) + 1
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "version": "0.3.0",
                "snapshot_cutoff": AGENTIC_COMPANY_SNAPSHOT_CUTOFF,
                "task_count": len(questions),
                "topic_count": len({question["topic_id"] for question in questions}),
                "difficulty_distribution": distribution,
                "excluded_schemas": ["ground_truth", "sim"],
                "source_database": {
                    "path": "data/company_for_analysis.duckdb",
                    "bytes": AGENTIC_COMPANY_DATABASE_BYTES,
                    "sha256": AGENTIC_COMPANY_DATABASE_SHA256,
                },
                "topics": [
                    {
                        "topic_id": topic_id,
                        "topic": next(
                            question["topic"]
                            for question in questions
                            if question["topic_id"] == topic_id
                        ),
                        "task_count": sum(
                            question["topic_id"] == topic_id for question in questions
                        ),
                        "easy_count": sum(
                            question["topic_id"] == topic_id and question["level"] == "easy"
                            for question in questions
                        ),
                        "hard_count": sum(
                            question["topic_id"] == topic_id and question["level"] == "hard"
                            for question in questions
                        ),
                    }
                    for topic_id in sorted({question["topic_id"] for question in questions})
                ],
            }
        )
    )
    return questions_path, manual_path


def _ids_hash(questions: list[dict]) -> str:
    ids = "\n".join(str(question["task_id"]) for question in questions)
    return hashlib.sha256(ids.encode()).hexdigest()


class QuestionLoaderTests(unittest.TestCase):
    def test_dabstep_splits_are_unchanged(self) -> None:
        expected = {
            "templates": (26, "e92b2dc5f55f9cdec2c3374c2de5b57904aa3f93832868ce4966f4c1073ced96"),
            "test": (419, "8fa71c50ed2bdc89859366f22187e501e2bd08bbd132f95aa66125a891c2d280"),
            "all": (445, "31c3e4836b98098c085069947cc957a738999538a85adb7d5f1d435cb0816d04"),
        }
        for split, (count, digest) in expected.items():
            questions = _load_questions(split)
            self.assertEqual(len(questions), count)
            self.assertEqual(_ids_hash(questions), digest)

    @unittest.skipUnless(CANONICAL_QUESTIONS.is_file(), "external benchmark checkout not present")
    def test_agentic_company_loads_canonical_40_in_order(self) -> None:
        questions = _load_questions(
            "all",
            benchmark=AGENTIC_COMPANY_BENCHMARK,
            questions_path=CANONICAL_QUESTIONS,
        )
        self.assertEqual([question["task_id"] for question in questions], [
            f"AC-{index:03d}" for index in range(1, 41)
        ])
        self.assertEqual(sum(question["level"] == "easy" for question in questions), 10)
        self.assertEqual(sum(question["level"] == "hard" for question in questions), 30)
        self.assertEqual(len({question["topic_id"] for question in questions}), 10)

    def test_duplicate_external_ids_fail_with_line_number(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "questions.jsonl"
            record = json.dumps(_fixture_question())
            fixture.write_text(record + "\n" + record + "\n")
            with self.assertRaisesRegex(ValueError, r":2: duplicate task_id"):
                _load_questions(
                    "all",
                    benchmark=AGENTIC_COMPANY_BENCHMARK,
                    questions_path=fixture,
                )

    def test_malformed_numeric_criteria_fails_before_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "questions.jsonl"
            question = _fixture_question()
            question["answer_criteria"]["decimals"] = "bad"
            fixture.write_text(json.dumps(question) + "\n")
            with self.assertRaisesRegex(ValueError, "decimals must be"):
                _load_questions(
                    "all",
                    benchmark=AGENTIC_COMPANY_BENCHMARK,
                    questions_path=fixture,
                )

    def test_manifest_pins_snapshot_and_per_topic_contract(self) -> None:
        questions = _fixture_questions()
        with tempfile.TemporaryDirectory() as tmpdir:
            _write_benchmark_fixture(Path(tmpdir), questions)
            manifest = json.loads((Path(tmpdir) / "manifest.json").read_text())
            _validate_agentic_manifest(questions, manifest)
            for path, value, message in (
                (("snapshot_cutoff",), "2026-07-30", "snapshot_cutoff"),
                (("source_database", "sha256"), "0" * 64, "database SHA"),
                (("topics", 0, "task_count"), 2, "task_count"),
            ):
                with self.subTest(path=path):
                    mutated = json.loads(json.dumps(manifest))
                    target = mutated
                    for key in path[:-1]:
                        target = target[key]
                    target[path[-1]] = value
                    with self.assertRaisesRegex(ValueError, message):
                        _validate_agentic_manifest(questions, mutated)


class AgenticScoringTests(unittest.TestCase):
    NUMBER: ClassVar[dict] = {"type": "number", "decimals": 0, "tolerance": 0}
    PAIR: ClassVar[dict] = {
        "type": "label:number",
        "delimiter": ":",
        "decimals": 2,
        "tolerance": 0.01,
    }

    def test_wrong_sign_and_missing_component_fail(self) -> None:
        self.assertFalse(answers_match("-13", "13", self.NUMBER))
        self.assertFalse(
            answers_match(
                "Foldflat Camp Kitchen",
                "Foldflat Camp Kitchen:2922657.73",
                self.PAIR,
            )
        )

    def test_tolerance_is_absolute_and_sign_sensitive(self) -> None:
        self.assertTrue(answers_match("x:1.009", "x:1.00", self.PAIR))
        self.assertFalse(answers_match("x:1.011", "x:1.00", self.PAIR))
        self.assertFalse(answers_match("x:1.00", "x:-1.00", self.PAIR))

    def test_string_normalization_ignores_punctuation(self) -> None:
        self.assertTrue(
            answers_match(
                "organic search",
                "organic_search",
                {"type": "string"},
            )
        )

    def test_ordered_list_reversal_fails(self) -> None:
        criteria = {
            "type": "list[string]",
            "delimiter": ",",
            "order_sensitive": True,
        }
        gold = "Cedarpoint Outfitters:406.67, ParcelPeak Marketplace:45.69"
        reversed_answer = "ParcelPeak Marketplace:45.69, Cedarpoint Outfitters:406.67"
        self.assertTrue(answers_match(gold, gold, criteria))
        self.assertTrue(
            answers_match(
                "Cedarpoint Outfitters:406.666, ParcelPeak Marketplace:45.694",
                gold,
                criteria,
            )
        )
        self.assertFalse(answers_match(reversed_answer, gold, criteria))

    def test_compound_row_formatting(self) -> None:
        triple = {
            "type": "label:label:number",
            "delimiter": ":",
            "decimals": 2,
            "tolerance": 0.01,
        }
        self.assertEqual(
            format_answer([("2026-02", "cash_out_ap", -2952349.09)], triple),
            "2026-02:cash_out_ap:-2952349.09",
        )
        ordered_list = {"type": "list[string]", "delimiter": ",", "order_sensitive": True}
        self.assertEqual(
            format_answer([("A", "1.00"), ("B", "2.00")], ordered_list),
            "A:1.00, B:2.00",
        )

    def test_execution_error_is_never_correct(self) -> None:
        result = score(
            ExecutionError("Failure", "boom"),
            "Not Applicable",
            {"type": "string"},
            predicted_sql=None,
        )
        self.assertFalse(result.is_correct)
        self.assertEqual(result.correctness, Correctness.ERROR)

    def test_fractional_count_does_not_round_into_correct_integer(self) -> None:
        result = score(
            [(13.49,)],
            "13",
            self.NUMBER,
            predicted_sql="SELECT 13.49",
        )
        self.assertFalse(result.is_correct)
        self.assertEqual(result.predicted_answer, "13.49")

    def test_latched_rows_are_scored_even_if_hit_limit_was_reported(self) -> None:
        result = score(
            [(13,)],
            "13",
            self.NUMBER,
            predicted_sql="SELECT 13",
            hit_limit=True,
        )
        self.assertTrue(result.is_correct)

    @unittest.skipUnless(CANONICAL_QUESTIONS.is_file(), "external benchmark checkout not present")
    def test_every_canonical_gold_self_scores_with_realistic_rows(self) -> None:
        questions = _load_questions(
            "all",
            benchmark=AGENTIC_COMPANY_BENCHMARK,
            questions_path=CANONICAL_QUESTIONS,
        )
        for question in questions:
            answer_type = question["answer_criteria"]["type"]
            answer = question["answer"]
            if answer_type == "number":
                rows = [(float(answer),)]
            elif answer_type == "string":
                rows = [(answer,)]
            elif answer_type == "label:number":
                label, number = answer.rsplit(":", 1)
                rows = [(label, float(number))]
            elif answer_type == "label:label:number":
                first, second, number = answer.split(":")
                rows = [(first, second, float(number))]
            else:
                rows = [tuple(item.strip().rsplit(":", 1)) for item in answer.split(",")]
            result = score(
                rows,
                answer,
                question["answer_criteria"],
                predicted_sql="SELECT answer",
            )
            self.assertTrue(result.is_correct, question["task_id"])


class PromptAndGuideTests(unittest.TestCase):
    class FakeManualSession:
        def __init__(
            self,
            *,
            body: str,
            guides: list[dict] | None = None,
            create_mode: str = "normal",
            returned_body: str | None = None,
        ) -> None:
            self.body = body
            self.guides = list(guides or [])
            self.create_mode = create_mode
            self.returned_body = body if returned_body is None else returned_body
            self.calls: list[tuple[str, dict, bool]] = []

        async def call_tool(self, name: str, args: dict, allow_write: bool = False):
            self.calls.append((name, args, allow_write))
            if name == "list_guides":
                payload = {"success": True, "guides": list(self.guides)}
                return SimpleNamespace(is_error=False, text=json.dumps(payload))
            if name == "create_guide":
                if self.create_mode != "empty_after_error":
                    self.guides = [self._canonical_guide("created-uuid")]
                if self.create_mode == "raise":
                    raise ConnectionError("ambiguous transport failure")
                if self.create_mode == "empty_after_error":
                    return SimpleNamespace(is_error=True, text="permission denied")
                payload = (
                    {"success": True}
                    if self.create_mode == "missing_uuid"
                    else {"guide": {"id": "created-uuid"}}
                )
                return SimpleNamespace(is_error=False, text=json.dumps(payload))
            if name in {"update_guide", "update_guide_metadata"}:
                return SimpleNamespace(is_error=False, text=json.dumps({"success": True}))
            if name == "get_guide":
                text = (
                    f"fixture\n\n{guides_load.AGENTIC_COMPANY_MANUAL_DESCRIPTION}\n\n"
                    f"{self.returned_body.rstrip()}"
                )
                return SimpleNamespace(
                    is_error=False,
                    text=json.dumps({"success": True, "text": text}),
                )
            raise AssertionError(name)

        @staticmethod
        def _canonical_guide(uuid: str) -> dict:
            return {
                "uuid": uuid,
                "topic": AGENTIC_COMPANY_GUIDE_TOPIC,
                "title": "analyst-field-manual",
                "access": "user",
            }

    class FakeManualContext:
        def __init__(self, session) -> None:
            self.session = session

        async def __aenter__(self):
            return self.session

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    def test_agentic_prompt_is_isolated_and_uses_one_manual_topic(self) -> None:
        skill = AGENTIC_COMPANY_SKILL_PATH.read_text()
        prompt = build_agentic_company_system_prompt("agentic_company_snapshot", skill)
        lowered = prompt.casefold()
        self.assertIn(AGENTIC_COMPANY_GUIDE_TOPIC, prompt)
        self.assertNotIn("payments database", lowered)
        self.assertNotIn("dabstep/", lowered)
        self.assertNotIn("aci", lowered)
        self.assertNotIn("mcc", lowered)
        tools = _make_tools(
            RunState(mcp=SimpleNamespace(), database="agentic_company_snapshot"),
            guide_topic=AGENTIC_COMPANY_GUIDE_TOPIC,
        )
        self.assertEqual([tool.name for tool in tools], [
            "list_guides", "get_guide", "list_tables", "list_columns", "query", "submit_answer"
        ])

    def test_dabstep_default_prompt_still_uses_existing_template(self) -> None:
        prompt = build_system_prompt("example", "skill")
        self.assertIn("payments database", prompt)
        self.assertIn("dabstep/fees", prompt)

    def test_manual_dry_run_publishes_exactly_one_guide(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manual = Path(tmpdir) / "manual.md"
            manual.write_text("# Fixture manual\n")
            results = guides_load.publish_manual_sync(manual, dry_run=True)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["id"], "analyst-field-manual")
        self.assertEqual(results[0]["topic"], AGENTIC_COMPANY_GUIDE_TOPIC)

    def test_manual_prefix_and_access_cannot_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            directory = Path(tmpdir)
            manual = directory / "manual.md"
            manual.write_text("# Fixture manual\n")
            with self.assertRaisesRegex(ValueError, "prefix is fixed"):
                guides_load.publish_manual_sync(manual, prefix="other", dry_run=True)
            with self.assertRaisesRegex(ValueError, "access is fixed"):
                guides_load.publish_manual_sync(manual, access="organization", dry_run=True)

    def test_manual_selector_is_principal_portable_and_fails_closed(self) -> None:
        canonical = {
            "success": True,
            "guides": [{
                "uuid": "principal-specific-uuid",
                "topic": AGENTIC_COMPANY_GUIDE_TOPIC,
                "title": "analyst-field-manual",
                "access": "user",
            }],
        }
        self.assertEqual(
            guides_load.select_agentic_manual(canonical),
            "principal-specific-uuid",
        )
        self.assertIsNone(
            guides_load.select_agentic_manual({"success": True, "guides": []})
        )
        for mutation in (
            {"title": "unrelated"},
            {"access": "organization"},
            {"topic": "other/manual"},
        ):
            payload = json.loads(json.dumps(canonical))
            payload["guides"][0].update(mutation)
            with self.assertRaisesRegex(RuntimeError, "canonical personal"):
                guides_load.select_agentic_manual(payload)
        duplicate = json.loads(json.dumps(canonical))
        duplicate["guides"].append(dict(duplicate["guides"][0], uuid="second"))
        with self.assertRaisesRegex(RuntimeError, "Remove duplicates"):
            guides_load.select_agentic_manual(duplicate)

    def test_failed_first_dabstep_create_does_not_write_empty_lock(self) -> None:
        class FakeSession:
            async def call_tool(self, name: str, args: dict, allow_write: bool = False):
                return SimpleNamespace(is_error=True, text="transient failure")

        class FakeContext:
            async def __aenter__(self):
                return FakeSession()

            async def __aexit__(self, exc_type, exc, traceback):
                return False

        async def exercise(lock: Path) -> None:
            item = guides_load.ContextItem(
                id="fixture",
                domain="manual",
                summary="fixture",
                body="fixture",
            )
            with patch.object(guides_load, "create_mcp_session", return_value=FakeContext()):
                results = await guides_load._publish_items(
                    [item],
                    prefix="fixture",
                    access="user",
                    dry_run=False,
                    lockfile_path=lock,
                )
            self.assertEqual(results[0]["action"], "failed")
            self.assertFalse(lock.exists())

        with tempfile.TemporaryDirectory() as tmpdir:
            asyncio.run(exercise(Path(tmpdir) / "guides.lock.json"))

    def test_manual_live_create_and_update_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manual = Path(tmpdir) / "manual.md"
            manual.write_text("# Fixture manual\n")
            for existing, expected_action in ((False, "created"), (True, "updated")):
                with self.subTest(existing=existing):
                    guides = (
                        [self.FakeManualSession._canonical_guide("existing-uuid")]
                        if existing
                        else []
                    )
                    session = self.FakeManualSession(body=manual.read_text(), guides=guides)
                    context = self.FakeManualContext(session)
                    with patch.object(
                        guides_load,
                        "create_mcp_session",
                        return_value=context,
                    ):
                        results = guides_load.publish_manual_sync(manual)
                    names = [name for name, _, _ in session.calls]
                    self.assertEqual(results[0]["action"], expected_action)
                    self.assertEqual(names.count("create_guide"), 0 if existing else 1)
                    self.assertEqual(names.count("update_guide"), 1 if existing else 0)
                    self.assertEqual(
                        names.count("update_guide_metadata"), 1 if existing else 0
                    )
                    self.assertEqual(names.count("list_guides"), 2)
                    self.assertEqual(names.count("get_guide"), 1)

    def test_manual_ambiguous_create_is_adopted_without_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manual = Path(tmpdir) / "manual.md"
            manual.write_text("# Fixture manual\n")
            for create_mode in ("missing_uuid", "raise"):
                with self.subTest(create_mode=create_mode):
                    session = self.FakeManualSession(
                        body=manual.read_text(),
                        create_mode=create_mode,
                    )
                    with patch.object(
                        guides_load,
                        "create_mcp_session",
                        return_value=self.FakeManualContext(session),
                    ):
                        results = guides_load.publish_manual_sync(manual)
                    names = [name for name, _, _ in session.calls]
                    self.assertEqual(results[0]["action"], "created")
                    self.assertEqual(names.count("create_guide"), 1)
                    self.assertEqual(names.count("list_guides"), 3)

    def test_manual_publish_fails_closed_without_a_second_create(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            manual = Path(tmpdir) / "manual.md"
            manual.write_text("# Fixture manual\n")
            cases = (
                self.FakeManualSession(
                    body=manual.read_text(),
                    create_mode="empty_after_error",
                ),
                self.FakeManualSession(
                    body=manual.read_text(),
                    guides=[
                        self.FakeManualSession._canonical_guide("first"),
                        self.FakeManualSession._canonical_guide("second"),
                    ],
                ),
                self.FakeManualSession(
                    body=manual.read_text(),
                    guides=[self.FakeManualSession._canonical_guide("existing")],
                    returned_body="wrong body",
                ),
            )
            for session in cases:
                with self.subTest(mode=session.create_mode, guides=len(session.guides)):
                    with (
                        patch.object(
                            guides_load,
                            "create_mcp_session",
                            return_value=self.FakeManualContext(session),
                        ),
                        self.assertRaises(RuntimeError),
                    ):
                        guides_load.publish_manual_sync(manual)
                    names = [name for name, _, _ in session.calls]
                    self.assertLessEqual(names.count("create_guide"), 1)
                    if len(session.guides) > 1:
                        self.assertFalse(
                            {"create_guide", "update_guide", "update_guide_metadata"}
                            .intersection(names)
                        )


class SubmissionTests(unittest.TestCase):
    def test_hit_limit_fix_is_scoped_to_agentic_company(self) -> None:
        self.assertTrue(
            _resolve_hit_limit(
                prompt_profile="dabstep",
                submitted=True,
                hit_limit=True,
            )
        )
        self.assertFalse(
            _resolve_hit_limit(
                prompt_profile=AGENTIC_COMPANY_BENCHMARK,
                submitted=True,
                hit_limit=True,
            )
        )

    def test_parallel_submissions_latch_first_success_exactly_once(self) -> None:
        class BlockingMCP:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()
                self.calls: list[str] = []

            async def call_tool(self, name: str, args: dict):
                self.calls.append(args["sql"])
                self.started.set()
                await self.release.wait()
                return SimpleNamespace(is_error=False, rows=[[1]], text="ok")

        async def exercise() -> None:
            mcp = BlockingMCP()
            state = RunState(mcp=mcp, database="fixture")
            submit = _make_tools(state)[-1]
            invoke = submit.on_invoke_tool._invoke_tool_impl
            context = SimpleNamespace(tool_name="submit_answer")
            first = asyncio.create_task(
                invoke(context, json.dumps({"sql": "SELECT 1"}))
            )
            await mcp.started.wait()
            second = asyncio.create_task(
                invoke(context, json.dumps({"sql": "SELECT 2"}))
            )
            await asyncio.sleep(0)
            self.assertEqual(mcp.calls, ["SELECT 1"])
            mcp.release.set()
            first_result, second_result = await asyncio.gather(first, second)
            self.assertIn("Submitted", first_result)
            self.assertEqual(second_result, "ERROR: answer already submitted")
            self.assertEqual(mcp.calls, ["SELECT 1"])
            self.assertEqual(state.final_sql, "SELECT 1")
            self.assertEqual(state.final_rows, [(1,)])

        asyncio.run(exercise())


class CLIProfileTests(unittest.TestCase):
    def test_agentic_provenance_matches_installed_controllog_schema(self) -> None:
        artifacts = {
            "version": "0.3.0",
            "questions_sha256": "q-sha",
            "manual_sha256": "m-sha",
            "database_sha256": "db-sha",
        }
        provenance = _build_run_provenance(
            benchmark=AGENTIC_COMPANY_BENCHMARK,
            split="all",
            database="agentic_company_snapshot",
            model="fixture-model",
            reasoning="low",
            max_turns=40,
            concurrency=1,
            out=Path("fixture.jsonl"),
            question_count=40,
            artifacts=artifacts,
        )
        inspect.signature(controllog.run_metadata).bind(run_id="fixture-run", **provenance)
        self.assertNotIn("benchmark_artifacts", provenance)
        self.assertEqual(
            provenance["resolved_config"]["benchmark_artifacts"],
            artifacts,
        )

    def test_agentic_task_selection_reaches_shared_loop(self) -> None:
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            fixture_dir = repo_root / "benchmarks" / "dabstep_agentic_company"
            _write_benchmark_fixture(
                fixture_dir,
                _fixture_questions(),
            )
            out = fixture_dir / "result.jsonl"
            loop = AsyncMock()
            with (
                patch("src.run._evaluate_loop", loop),
                patch(
                    "src.run.AGENTIC_COMPANY_QUESTIONS_SHA256",
                    hashlib.sha256((fixture_dir / "questions.jsonl").read_bytes()).hexdigest(),
                ),
                patch(
                    "src.run.AGENTIC_COMPANY_MANUAL_SHA256",
                    hashlib.sha256((fixture_dir / "manual.md").read_bytes()).hexdigest(),
                ),
            ):
                result = runner.invoke(
                    cli,
                    [
                        "evaluate",
                        "--benchmark",
                        AGENTIC_COMPANY_BENCHMARK,
                        "--task-id",
                        "ac-030",
                        "--out",
                        str(out),
                    ],
                    env={"AGENTIC_COMPANY_REPO": str(repo_root)},
                )
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = loop.await_args.kwargs
        self.assertEqual(kwargs["benchmark"], AGENTIC_COMPANY_BENCHMARK)
        self.assertEqual(kwargs["split"], "all")
        self.assertEqual([question["task_id"] for question in kwargs["questions"]], ["AC-030"])
        self.assertEqual(kwargs["guide_topic"], AGENTIC_COMPANY_GUIDE_TOPIC)

    def test_invalid_limit_and_duplicate_ids_fail_before_loop(self) -> None:
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            fixture_dir = repo_root / "benchmarks" / "dabstep_agentic_company"
            _write_benchmark_fixture(
                fixture_dir,
                _fixture_questions(),
            )
            common = [
                "evaluate",
                "--benchmark",
                AGENTIC_COMPANY_BENCHMARK,
            ]
            env = {"AGENTIC_COMPANY_REPO": str(repo_root)}
            with (
                patch(
                    "src.run.AGENTIC_COMPANY_QUESTIONS_SHA256",
                    hashlib.sha256((fixture_dir / "questions.jsonl").read_bytes()).hexdigest(),
                ),
                patch(
                    "src.run.AGENTIC_COMPANY_MANUAL_SHA256",
                    hashlib.sha256((fixture_dir / "manual.md").read_bytes()).hexdigest(),
                ),
            ):
                invalid_limit = runner.invoke(cli, [*common, "--limit", "0"], env=env)
                duplicate_ids = runner.invoke(
                    cli,
                    [*common, "--task-ids", "AC-001,AC-001"],
                    env=env,
                )
        self.assertNotEqual(invalid_limit.exit_code, 0)
        self.assertIn("range x>=1", invalid_limit.output)
        self.assertNotEqual(duplicate_ids.exit_code, 0)
        self.assertIn("must not contain duplicate", duplicate_ids.output)

    def test_file_overrides_do_not_relocate_other_benchmark_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir) / "repo"
            canonical = repo_root / "benchmarks" / "dabstep_agentic_company"
            canonical.mkdir(parents=True)
            questions_override = Path(tmpdir) / "questions.jsonl"
            manual_override = Path(tmpdir) / "manual.md"
            with patch.dict("os.environ", {"AGENTIC_COMPANY_REPO": str(repo_root)}):
                questions, manual, manifest = _resolve_agentic_paths(manual=manual_override)
                self.assertEqual(questions, canonical / "questions.jsonl")
                self.assertEqual(manual, manual_override)
                self.assertEqual(manifest, canonical / "manifest.json")
                questions, manual, manifest = _resolve_agentic_paths(
                    questions_jsonl=questions_override
                )
                self.assertEqual(questions, questions_override)
                self.assertEqual(manual, canonical / "manual.md")
                self.assertEqual(manifest, canonical / "manifest.json")

    def test_manifest_rejects_truncated_question_set_before_loop(self) -> None:
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            fixture_dir = repo_root / "benchmarks" / "dabstep_agentic_company"
            questions_path, _ = _write_benchmark_fixture(
                fixture_dir,
                _fixture_questions(),
            )
            lines = questions_path.read_text().splitlines()
            questions_path.write_text("\n".join(lines[:-1]) + "\n")
            loop = AsyncMock()
            with patch("src.run._evaluate_loop", loop):
                result = runner.invoke(
                    cli,
                    ["evaluate", "--benchmark", AGENTIC_COMPANY_BENCHMARK],
                    env={"AGENTIC_COMPANY_REPO": str(repo_root)},
                )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("expected 40, loaded 39", result.output)
        loop.assert_not_awaited()

    def test_default_cli_profile_remains_dabstep_templates(self) -> None:
        runner = CliRunner()
        with tempfile.TemporaryDirectory() as tmpdir:
            loop = AsyncMock()
            with patch("src.run._evaluate_loop", loop):
                result = runner.invoke(
                    cli,
                    ["evaluate", "--out", str(Path(tmpdir) / "result.jsonl")],
                )
        self.assertEqual(result.exit_code, 0, result.output)
        kwargs = loop.await_args.kwargs
        self.assertEqual(kwargs["benchmark"], "dabstep")
        self.assertEqual(kwargs["split"], "templates")
        self.assertEqual(len(kwargs["questions"]), 26)


class MCPBoundaryTests(unittest.TestCase):
    def test_list_columns_splits_qualified_names_and_reports_column_rows(self) -> None:
        class FakeSession:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            async def call_tool(self, name: str, args: dict):
                self.calls.append((name, args))
                if name == "list_tables":
                    payload = {
                        "success": True,
                        "tables": [{"schema": "catalog", "name": "products"}],
                        "views": [],
                    }
                elif name == "list_columns":
                    payload = {
                        "success": True,
                        "database": args["database"],
                        "schema": args.get("schema", "main"),
                        "table": args["table"],
                        "columns": [
                            {"name": "product_id", "type": "VARCHAR"},
                            {"name": "name", "type": "VARCHAR"},
                        ],
                        "columnCount": 2,
                    }
                else:
                    raise AssertionError(name)
                return SimpleNamespace(
                    isError=False,
                    structuredContent=payload,
                    content=[],
                )

        async def exercise() -> None:
            raw = FakeSession()
            session = MCPSession(raw, database="agentic_company_snapshot")
            qualified = await session.call_tool(
                "list_columns",
                {"table": "catalog.products"},
            )
            self.assertFalse(qualified.is_error)
            self.assertEqual(len(qualified.rows or []), 2)
            self.assertEqual(
                raw.calls[-1],
                (
                    "list_columns",
                    {
                        "table": "products",
                        "database": "agentic_company_snapshot",
                        "schema": "catalog",
                    },
                ),
            )

            unqualified = await session.call_tool("list_columns", {"table": "products"})
            self.assertFalse(unqualified.is_error)
            self.assertEqual(len(unqualified.rows or []), 2)
            self.assertEqual(raw.calls[-2][0], "list_tables")
            self.assertEqual(raw.calls[-1][1]["schema"], "catalog")

            fully_qualified = await session.call_tool(
                "list_columns",
                {"table": "agentic_company_snapshot.catalog.products"},
            )
            self.assertFalse(fully_qualified.is_error)
            self.assertEqual(raw.calls[-1][1]["table"], "products")

        asyncio.run(exercise())

    def test_share_attach_is_read_only_and_alias_verified(self) -> None:
        class FakeAttachSession:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict]] = []

            async def call_tool(self, name: str, args: dict):
                self.calls.append((name, args))
                if len(self.calls) == 1:
                    payload = {"success": False, "error": "alias already attached"}
                    return SimpleNamespace(
                        isError=True,
                        structuredContent=payload,
                        content=[],
                    )
                payload = {
                    "success": True,
                    "rows": [[
                        "agentic_company_snapshot",
                        (
                            "_share/agentic_company_snapshot_share/"
                            "6b172abb-d377-4f0f-9a8a-d0ac199e074d"
                        ),
                        "motherduck",
                        True,
                    ]],
                }
                return SimpleNamespace(
                    isError=False,
                    structuredContent=payload,
                    content=[],
                )

        async def exercise() -> None:
            session = FakeAttachSession()
            await _attach_trusted_share(
                session,
                share_url=AGENTIC_COMPANY_SHARE,
                alias="agentic_company_snapshot",
                bootstrap_database="sample_data",
            )
            self.assertIn("(READ_ONLY)", session.calls[0][1]["sql"])
            self.assertIn("duckdb_databases()", session.calls[1][1]["sql"])

        asyncio.run(exercise())

    def test_restricted_schema_is_hidden_and_rejected(self) -> None:
        payload = {
            "success": True,
            "tableCount": 2,
            "viewCount": 0,
            "count": 2,
            "totalCount": 2,
            "tables": [
                {"schema": "catalog", "name": "skus"},
                {"schema": "sim", "name": "private"},
            ],
        }

        class FakeSession:
            async def call_tool(self, name: str, args: dict):
                return SimpleNamespace(
                    isError=False,
                    structuredContent=payload,
                    content=[],
                )

        async def exercise() -> None:
            session = MCPSession(
                FakeSession(),
                database="agentic_company_snapshot",
                excluded_schemas=("ground_truth", "sim"),
            )
            listing = await session.call_tool("list_tables", {})
            parsed = json.loads(listing.text)
            self.assertEqual(parsed["tableCount"], 1)
            self.assertEqual(parsed["count"], 1)
            self.assertEqual(parsed["totalCount"], 1)
            self.assertEqual(parsed["tables"][0]["schema"], "catalog")
            blocked = await session.call_tool("query", {"sql": "SELECT * FROM sim.private"})
            self.assertTrue(blocked.is_error)
            self.assertIn("outside this benchmark", blocked.text)
            dynamic = await session.call_tool(
                "query",
                {"sql": "SELECT * FROM query_table('s' || 'im.private')"},
            )
            self.assertTrue(dynamic.is_error)
            metadata = await session.call_tool(
                "query",
                {"sql": "SELECT * FROM duckdb_tables()"},
            )
            self.assertTrue(metadata.is_error)
            for sql in (
                "SELECT * FROM pg_catalog.pg_tables",
                "SELECT * FROM \"query_table\"('s' || 'im.private')",
                "SELECT * FROM \"query\"('FROM ' || 's' || 'im.private')",
                "SHOW ALL TABLES",
            ):
                quoted_bypass = await session.call_tool("query", {"sql": sql})
                self.assertTrue(quoted_bypass.is_error, sql)
            for sql in (
                "SELECT '--' AS marker, * FROM sim.private",
                "SELECT '/*' AS marker FROM ground_truth.answers WHERE '*/'='*/'",
                "SELECT $$--$$ AS marker, * FROM sim.private",
                "SELECT $tag$/*$tag$ AS marker FROM ground_truth.answers",
                r"SELECT E'foo\'--bar' AS marker, * FROM sim.private",
            ):
                hidden_after_literal = await session.call_tool("query", {"sql": sql})
                self.assertTrue(hidden_after_literal.is_error, sql)
            for sql in (
                "SELECT 'sim' AS label",
                "SELECT $$sim.private$$ AS label",
                "SELECT 1 AS sim",
                "SELECT 1 -- do not use sim",
            ):
                allowed = await session.call_tool("query", {"sql": sql})
                self.assertFalse(allowed.is_error, sql)

        asyncio.run(exercise())

    def test_comment_markers_in_strings_cannot_hide_mutation(self) -> None:
        violation = _read_only_violation("SELECT '--'; DROP TABLE public_data")
        self.assertIsNotNone(violation)
        self.assertIn("DROP", violation or "")
        dollar_violation = _read_only_violation("SELECT $$--$$; DROP TABLE public_data")
        self.assertIsNotNone(dollar_violation)
        self.assertIn("DROP", dollar_violation or "")

    def test_explain_analyze_cannot_execute_a_mutation(self) -> None:
        for sql in (
            "EXPLAIN ANALYZE DELETE FROM public_data",
            "EXPLAIN (ANALYZE) DELETE FROM public_data",
            "EXPLAIN (ANALYZE TRUE) DELETE FROM public_data",
            "EXPLAIN ANALYSE DELETE FROM public_data",
            "EXPLAIN ANALYZE INSERT INTO public_data VALUES (1)",
            "EXPLAIN ANALYZE CREATE TABLE leaked AS SELECT 1",
            "SELECT 1; EXPLAIN ANALYZE DROP TABLE public_data",
        ):
            violation = _read_only_violation(sql)
            self.assertIsNotNone(violation, sql)
            self.assertIn("EXPLAIN ANALYZE", violation or "")
        self.assertIsNone(_read_only_violation("EXPLAIN SELECT 1"))

    def test_single_guide_topic_and_discovered_uuid_are_enforced(self) -> None:
        class FakeGuideSession:
            async def call_tool(self, name: str, args: dict):
                if name == "list_guides":
                    payload = {"success": True, "guides": [{"uuid": "manual-uuid"}]}
                else:
                    payload = {"success": True, "text": "manual"}
                return SimpleNamespace(
                    isError=False,
                    structuredContent=payload,
                    content=[],
                )

        async def exercise() -> None:
            session = MCPSession(
                FakeGuideSession(),
                database="agentic_company_snapshot",
                guide_topic=AGENTIC_COMPANY_GUIDE_TOPIC,
            )
            wrong_topic = await session.call_tool("list_guides", {"topic": "dabstep/fees"})
            self.assertTrue(wrong_topic.is_error)
            undiscovered = await session.call_tool("get_guide", {"uuid": "manual-uuid"})
            self.assertTrue(undiscovered.is_error)
            listed = await session.call_tool(
                "list_guides",
                {"topic": AGENTIC_COMPANY_GUIDE_TOPIC},
            )
            self.assertFalse(listed.is_error)
            guide = await session.call_tool("get_guide", {"uuid": "manual-uuid"})
            self.assertFalse(guide.is_error)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
