"""Agentic Company benchmark policy and artifact contract.

The shared runner owns orchestration. This module owns everything specific to
the Agentic Company profile: canonical artifact selection and validation,
scoring, guide/share preflight, and result metadata.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from src import guides_load
from src.agentic_company_score import score as score_agentic_company
from src.mcp_client import create_mcp_session

REPO_ROOT = Path(__file__).resolve().parents[1]
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_CRITERIA_TYPES = frozenset(
    {"number", "string", "label:number", "label:label:number", "list[string]"}
)
_REQUIRED_FIELDS = (
    "task_id",
    "question",
    "guidelines",
    "answer",
    "answer_criteria",
    "level",
    "topic_id",
    "topic",
    "snapshot_cutoff",
    "source_tables",
)


@dataclass(frozen=True)
class AgenticCompanyArtifacts:
    """Validated canonical inputs carried through one evaluation run."""

    version: str
    snapshot_cutoff: str
    questions_path: Path
    questions_sha256: str
    manual_path: Path
    manual_sha256: str
    database_sha256: str
    share: str

    def provenance(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "snapshot_cutoff": self.snapshot_cutoff,
            "questions_path": str(self.questions_path.resolve()),
            "questions_sha256": self.questions_sha256,
            "manual_path": str(self.manual_path.resolve()),
            "manual_sha256": self.manual_sha256,
            "database_sha256": self.database_sha256,
            "share": self.share,
        }


@dataclass(frozen=True)
class AgenticCompanyProfile:
    """Complete configuration and behavior for the Agentic Company profile."""

    name: str = "agentic-company"
    default_split: str = "all"
    default_database: str = "agentic_company_snapshot"
    database_env: str = "AGENTIC_COMPANY_MD_DATABASE"
    guide_topic: str = "agentic-company/manual"
    project_id: str = "agentic-company-dabstep"
    manifest_version: str = "0.3.1"
    snapshot_cutoff: str = "2026-07-31"
    task_count: int = 40
    topic_count: int = 10
    database_bytes: int = 705_441_792
    database_sha256: str = "0a3c0bd92591093ad936d4eeb3cecf60958916dbbfd75ea4210b88619f0d9aa2"
    questions_sha256: str = "e459ae964e08318e2abd0b1ccb035d6d74c62e17f86efe1a996088c27da2ada4"
    manual_sha256: str = "7d76d5025880bb47e7ed3c16946e1701d4558d779339b6fcf0f277c516bb7544"
    share: str = "md:_share/agentic_company_snapshot_share/6b172abb-d377-4f0f-9a8a-d0ac199e074d"
    excluded_schemas: tuple[str, ...] = ("ground_truth", "sim")
    public_schemas: tuple[str, ...] = (
        "catalog",
        "comms",
        "cx",
        "dtc",
        "finance",
        "hr",
        "marketing",
        "ops",
        "wholesale",
        "workflow",
    )
    public_relation_count: int = 68
    public_snapshot_fingerprint: str = (
        "70360cfc468d329485b436935a6f3d4177156de893625aa72854c99ca424a531"
    )

    @property
    def skill_path(self) -> Path:
        return REPO_ROOT / "skill" / "AGENTIC_COMPANY.md"

    def database_name(self, explicit: str | None) -> str:
        return explicit or os.environ.get(self.database_env) or self.default_database

    def task_key(self, value: Any) -> str:
        return str(value).casefold()

    def benchmark_dir(self) -> Path:
        configured = os.environ.get("AGENTIC_COMPANY_REPO")
        root = (
            Path(configured).expanduser()
            if configured
            else REPO_ROOT.parents[2] / "the-agentic-company"
        )
        return root / "benchmarks" / "dabstep_agentic_company"

    def resolve_paths(
        self,
        questions_jsonl: Path | None = None,
        manual: Path | None = None,
    ) -> tuple[Path, Path, Path]:
        benchmark_dir = self.benchmark_dir()
        return (
            questions_jsonl or benchmark_dir / "questions.jsonl",
            manual or benchmark_dir / "manual.md",
            benchmark_dir / "manifest.json",
        )

    @staticmethod
    def sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def load_questions(self, path: Path, *, split: str = "all") -> list[dict]:
        if split != self.default_split:
            raise ValueError(f"Agentic Company supports only split={self.default_split!r}.")
        if not path.is_file():
            raise FileNotFoundError(f"Agentic Company questions not found: {path}")

        questions: list[dict] = []
        seen: set[str] = set()
        for line_number, line in enumerate(path.read_text().splitlines(), start=1):
            if not line.strip():
                continue
            location = f"{path}:{line_number}"
            try:
                question = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{location}: invalid JSON: {exc}") from exc
            if not isinstance(question, dict):
                raise TypeError(f"{location}: question record must be an object")
            missing = [field for field in _REQUIRED_FIELDS if field not in question]
            if missing:
                raise ValueError(f"{location}: missing fields {missing}")
            task_id = question["task_id"]
            if not isinstance(task_id, str) or not task_id:
                raise ValueError(f"{location}: task_id must be a string")
            if task_id in seen:
                raise ValueError(f"{location}: duplicate task_id {task_id!r}")
            self.validate_criteria(question["answer_criteria"], location)
            if not all(
                isinstance(question[field], str)
                for field in (
                    "question",
                    "guidelines",
                    "answer",
                    "level",
                    "topic_id",
                    "topic",
                    "snapshot_cutoff",
                )
            ):
                raise ValueError(
                    f"{location}: question, guidelines, answer, level, topic_id, topic, "
                    "and snapshot_cutoff must be strings"
                )
            if question["level"] not in {"easy", "hard"}:
                raise ValueError(f"{location}: level must be 'easy' or 'hard'")
            seen.add(task_id)
            question["question_index"] = len(questions)
            questions.append(question)
        return questions

    @staticmethod
    def _validate_numeric_criteria(criteria: dict, location: str) -> None:
        decimals = criteria.get("decimals")
        if isinstance(decimals, bool) or not isinstance(decimals, int) or decimals < 0:
            raise ValueError(f"{location}: decimals must be a non-negative integer")
        tolerance = criteria.get("tolerance")
        try:
            parsed_tolerance = Decimal(str(tolerance))
        except (InvalidOperation, ValueError, TypeError) as exc:
            raise ValueError(f"{location}: tolerance must be a finite non-negative number") from exc
        if not parsed_tolerance.is_finite() or parsed_tolerance < 0:
            raise ValueError(f"{location}: tolerance must be a finite non-negative number")

    def validate_criteria(self, criteria: object, location: str) -> None:
        if not isinstance(criteria, dict):
            raise TypeError(f"{location}: answer_criteria must be an object")
        answer_type = criteria.get("type")
        if answer_type not in _CRITERIA_TYPES:
            raise ValueError(f"{location}: unsupported answer criteria type {answer_type!r}")
        if answer_type in {"number", "label:number", "label:label:number"}:
            self._validate_numeric_criteria(criteria, location)
        if answer_type in {"label:number", "label:label:number", "list[string]"}:
            delimiter = criteria.get("delimiter")
            if not isinstance(delimiter, str) or not delimiter:
                raise ValueError(f"{location}: delimiter must be a non-empty string")
        if answer_type == "list[string]":
            if not isinstance(criteria.get("order_sensitive"), bool):
                raise ValueError(f"{location}: order_sensitive must be a boolean")
            if not isinstance(criteria.get("empty_answer", ""), str):
                raise ValueError(f"{location}: empty_answer must be a string")
            element_type = criteria.get("element_type", "string")
            if element_type not in {"string", "label:number"}:
                raise ValueError(f"{location}: unsupported list element_type {element_type!r}")
            if element_type == "label:number":
                self._validate_numeric_criteria(criteria, location)

    def validate_manifest(self, questions: list[dict], manifest: dict) -> None:
        if manifest.get("version") != self.manifest_version:
            raise ValueError(
                "Agentic Company manifest version does not match this harness: "
                f"expected {self.manifest_version!r}, received {manifest.get('version')!r}."
            )
        cutoff = manifest.get("snapshot_cutoff")
        if cutoff != self.snapshot_cutoff:
            raise ValueError(
                "Agentic Company manifest snapshot_cutoff does not match this harness: "
                f"expected {self.snapshot_cutoff!r}, received {cutoff!r}."
            )
        if manifest.get("excluded_schemas") != list(self.excluded_schemas):
            raise ValueError(
                "Agentic Company manifest excluded_schemas does not match the enforced "
                f"boundary: expected {list(self.excluded_schemas)!r}, "
                f"received {manifest.get('excluded_schemas')!r}."
            )
        if manifest.get("context_files") != ["benchmarks/dabstep_agentic_company/manual.md"]:
            raise ValueError("Agentic Company manifest must expose only the analyst manual.")

        source_database = manifest.get("source_database")
        if not isinstance(source_database, dict):
            raise TypeError("Agentic Company manifest source_database must be an object.")
        if source_database.get("path") != "data/company_for_analysis.duckdb":
            raise ValueError("Agentic Company manifest source_database.path is not canonical.")
        if source_database.get("bytes") != self.database_bytes:
            raise ValueError(
                "Agentic Company manifest database byte size does not match the pinned snapshot."
            )
        if source_database.get("sha256") != self.database_sha256:
            raise ValueError(
                "Agentic Company manifest database SHA does not match the pinned snapshot."
            )

        expected_count = manifest.get("task_count")
        if isinstance(expected_count, bool) or not isinstance(expected_count, int):
            raise TypeError("Agentic Company manifest task_count must be an integer.")
        if expected_count != self.task_count:
            raise ValueError(f"Agentic Company manifest task_count must be {self.task_count}.")
        if len(questions) != expected_count:
            raise ValueError(
                "Agentic Company questions.jsonl does not match manifest task_count: "
                f"expected {expected_count}, loaded {len(questions)}."
            )

        expected_distribution = manifest.get("difficulty_distribution")
        pinned_distribution = {"easy": 10, "hard": 30}
        if expected_distribution != pinned_distribution:
            raise ValueError(
                "Agentic Company manifest difficulty_distribution does not match the "
                f"pinned benchmark: {pinned_distribution}."
            )
        actual_distribution: dict[str, int] = {}
        for question in questions:
            level = str(question.get("level") or "")
            actual_distribution[level] = actual_distribution.get(level, 0) + 1
        if actual_distribution != expected_distribution:
            raise ValueError(
                "Agentic Company question difficulty distribution does not match manifest: "
                f"expected {expected_distribution}, loaded {actual_distribution}."
            )

        expected_topics = manifest.get("topic_count")
        actual_topics = len({str(question.get("topic_id")) for question in questions})
        if isinstance(expected_topics, bool) or not isinstance(expected_topics, int):
            raise TypeError("Agentic Company manifest topic_count must be an integer.")
        if expected_topics != self.topic_count:
            raise ValueError(f"Agentic Company manifest topic_count must be {self.topic_count}.")
        if actual_topics != expected_topics:
            raise ValueError(
                "Agentic Company question topic count does not match manifest: "
                f"expected {expected_topics}, loaded {actual_topics}."
            )
        self._validate_topics(questions, manifest, cutoff)

    def _validate_topics(self, questions: list[dict], manifest: dict, cutoff: str) -> None:
        topics = manifest.get("topics")
        if not isinstance(topics, list) or len(topics) != self.topic_count:
            raise ValueError("Agentic Company manifest topics must list every topic exactly once.")
        expected_by_id: dict[str, dict] = {}
        for topic in topics:
            if not isinstance(topic, dict) or not isinstance(topic.get("topic_id"), str):
                raise TypeError(
                    "Every Agentic Company manifest topic must be an object with topic_id."
                )
            topic_id = topic["topic_id"]
            if topic_id in expected_by_id:
                raise ValueError(f"Duplicate Agentic Company manifest topic_id {topic_id!r}.")
            expected_by_id[topic_id] = topic
        canonical_topic_ids = {f"T{index:02d}" for index in range(1, 11)}
        if set(expected_by_id) != canonical_topic_ids:
            raise ValueError("Agentic Company manifest must contain topic IDs T01 through T10.")

        actual_by_id: dict[str, dict[str, object]] = {}
        public_schemas = set(self.public_schemas)
        for question in questions:
            task_id = question["task_id"]
            topic_id = question["topic_id"]
            topic_name = question["topic"]
            if question["snapshot_cutoff"] != cutoff:
                raise ValueError(f"{task_id}: snapshot_cutoff does not match manifest.")
            source_tables = question["source_tables"]
            if (
                not isinstance(source_tables, list)
                or not source_tables
                or not all(isinstance(table, str) and table for table in source_tables)
            ):
                raise TypeError(f"{task_id}: source_tables must be non-empty strings.")
            if any(table.split(".", 1)[0] not in public_schemas for table in source_tables):
                raise ValueError(f"{task_id}: source_tables includes a non-public schema.")
            actual = actual_by_id.setdefault(
                topic_id,
                {"topic": topic_name, "task_count": 0, "easy_count": 0, "hard_count": 0},
            )
            if actual["topic"] != topic_name:
                raise ValueError(f"{topic_id}: question topic labels are inconsistent.")
            actual["task_count"] = int(actual["task_count"]) + 1
            level_key = f"{question['level']}_count"
            actual[level_key] = int(actual[level_key]) + 1

        if set(actual_by_id) != set(expected_by_id):
            raise ValueError("Agentic Company manifest topic IDs do not match questions.jsonl.")
        for topic_id, expected in expected_by_id.items():
            actual = actual_by_id[topic_id]
            for field in ("topic", "task_count", "easy_count", "hard_count"):
                if expected.get(field) != actual[field]:
                    raise ValueError(
                        f"Agentic Company topic {topic_id} {field} does not match manifest: "
                        f"expected {expected.get(field)!r}, loaded {actual[field]!r}."
                    )

    def load_bundle(
        self,
        questions_path: Path,
        manual_path: Path,
        manifest_path: Path,
    ) -> tuple[list[dict], AgenticCompanyArtifacts]:
        for label, path in (
            ("questions", questions_path),
            ("manual", manual_path),
            ("manifest", manifest_path),
        ):
            if not path.is_file():
                raise FileNotFoundError(f"Agentic Company {label} not found: {path}")
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Agentic Company manifest is not valid JSON: {manifest_path}: {exc}"
            ) from exc
        if not isinstance(manifest, dict):
            raise TypeError(f"Agentic Company manifest must be a JSON object: {manifest_path}")

        questions = self.load_questions(questions_path)
        self.validate_manifest(questions, manifest)
        questions_sha256 = self.sha256(questions_path)
        manual_sha256 = self.sha256(manual_path)
        if questions_sha256 != self.questions_sha256:
            raise ValueError(
                "Agentic Company questions.jsonl does not match the pinned "
                f"v{self.manifest_version} artifact."
            )
        if manual_sha256 != self.manual_sha256:
            raise ValueError(
                "Agentic Company manual.md does not match the pinned "
                f"v{self.manifest_version} artifact."
            )
        return questions, AgenticCompanyArtifacts(
            version=manifest["version"],
            snapshot_cutoff=manifest["snapshot_cutoff"],
            questions_path=questions_path,
            questions_sha256=questions_sha256,
            manual_path=manual_path,
            manual_sha256=manual_sha256,
            database_sha256=manifest["source_database"]["sha256"],
            share=self.share,
        )

    def score(
        self,
        *,
        execution_result: Any,
        question: dict,
        predicted_sql: str | None,
        hit_limit: bool = False,
    ):
        return score_agentic_company(
            execution_result=execution_result,
            gold_answer=question.get("answer", ""),
            criteria=question.get("answer_criteria") or {},
            predicted_sql=predicted_sql,
            hit_limit=hit_limit,
        )

    def result_metadata(
        self,
        question: dict,
        artifacts: AgenticCompanyArtifacts,
    ) -> dict[str, Any]:
        return {
            "benchmark": self.name,
            "question_index": question.get("question_index"),
            "topic_id": question.get("topic_id"),
            "topic": question.get("topic"),
            "answer_criteria": question.get("answer_criteria"),
            "snapshot_cutoff": question.get("snapshot_cutoff"),
            "source_tables": question.get("source_tables"),
            "questions_sha256": artifacts.questions_sha256,
            "manual_sha256": artifacts.manual_sha256,
            "database_sha256": artifacts.database_sha256,
            "public_snapshot_fingerprint": self.public_snapshot_fingerprint,
        }

    @staticmethod
    def snapshot_fingerprint(rows: list[list] | list[tuple]) -> str:
        normalized: list[tuple[str, int, str]] = []
        for row in rows:
            if len(row) != 3:
                raise ValueError("Snapshot fingerprint rows must have exactly three columns.")
            relation, raw_count, raw_hash = row
            relation = str(relation)
            try:
                row_count = int(raw_count)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Invalid row count for {relation!r}.") from exc
            row_hash = str(raw_hash)
            if row_count < 0 or not row_hash.isdigit():
                raise ValueError(f"Invalid content fingerprint for {relation!r}.")
            normalized.append((relation, row_count, row_hash))
        payload = "\n".join(
            f"{relation}\t{row_count}\t{row_hash}"
            for relation, row_count, row_hash in sorted(normalized)
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    async def _verify_public_snapshot(self, mcp) -> None:
        listing = await mcp.call_tool("list_tables", {})
        if listing.is_error or listing.rows is None:
            raise RuntimeError(
                f"Agentic Company share preflight could not list public relations: {listing.text}"
            )
        public_schemas = set(self.public_schemas)
        relations: list[tuple[str, str]] = []
        for item in listing.rows:
            if not isinstance(item, dict):
                raise TypeError("Agentic Company table listing contained a malformed row.")
            schema = str(item.get("schema") or "")
            table = str(item.get("name") or "")
            if schema not in public_schemas or not _IDENTIFIER.fullmatch(table):
                raise RuntimeError(
                    f"Agentic Company table listing exposed unexpected relation {schema}.{table}."
                )
            relations.append((schema, table))
        relations = sorted(set(relations))
        if len(relations) != self.public_relation_count:
            raise RuntimeError(
                "Agentic Company public relation count does not match the pinned snapshot: "
                f"expected {self.public_relation_count}, received {len(relations)}."
            )

        pieces = []
        for schema, table in relations:
            relation = f"{schema}.{table}"
            pieces.append(
                f"SELECT '{relation}' AS relation, count(*)::BIGINT AS row_count, "
                "coalesce(bit_xor(md5_number(to_json(t))), 0)::VARCHAR AS content_hash "
                f'FROM "{schema}"."{table}" AS t'
            )
        fingerprint_result = await mcp.call_tool(
            "query",
            {"sql": " UNION ALL ".join(pieces) + " ORDER BY relation"},
        )
        if fingerprint_result.is_error or fingerprint_result.rows is None:
            raise RuntimeError(
                "Agentic Company public snapshot fingerprint query failed: "
                f"{fingerprint_result.text}"
            )
        fingerprint = self.snapshot_fingerprint(fingerprint_result.rows)
        if fingerprint != self.public_snapshot_fingerprint:
            raise RuntimeError(
                "Agentic Company share content does not match the pinned public snapshot: "
                f"expected {self.public_snapshot_fingerprint}, received {fingerprint}."
            )

    async def preflight(
        self,
        *,
        database: str,
        artifacts: AgenticCompanyArtifacts,
        verify_guide: bool,
    ) -> None:
        """Fail before model spend unless the share and selected guide are exact."""
        async with create_mcp_session(
            session_hint="agentic-company-preflight",
            database=database,
            attach_share=self.share,
            excluded_schemas=self.excluded_schemas,
            guide_topic=self.guide_topic,
        ) as mcp:
            cutoff = await mcp.call_tool(
                "query",
                {"sql": "SELECT max(sim_date)::VARCHAR FROM finance.pnl_daily"},
            )
            if cutoff.is_error or cutoff.rows != [[artifacts.snapshot_cutoff]]:
                raise RuntimeError(
                    "Agentic Company share preflight failed: expected finance.pnl_daily "
                    f"through {artifacts.snapshot_cutoff}, received {cutoff.text}"
                )
            await self._verify_public_snapshot(mcp)
            if not verify_guide:
                return

            listing = await mcp.call_tool("list_guides", {"topic": self.guide_topic})
            guide_uuid = guides_load.select_agentic_manual(
                guides_load._guide_listing_payload(listing)
            )
            if guide_uuid is None:
                raise RuntimeError(
                    "Expected exactly one guide under agentic-company/manual; run "
                    "`asm guides-load --benchmark agentic-company` before evaluation."
                )
            guide = await mcp.call_tool("get_guide", {"uuid": guide_uuid})
            try:
                remote_text = json.loads(guide.text).get("text", "")
                local_text = artifacts.manual_path.read_text().rstrip()
            except (OSError, AttributeError, json.JSONDecodeError) as exc:
                raise RuntimeError("Could not verify the Agentic Company manual guide.") from exc
            marker = f"\n\n{guides_load.AGENTIC_COMPANY_MANUAL_DESCRIPTION}\n\n"
            remote_body = remote_text.split(marker, 1)[1] if marker in remote_text else None
            if guide.is_error or remote_body != local_text:
                raise RuntimeError(
                    "The published Agentic Company manual does not match the selected manual.md. "
                    "Run `asm guides-load --benchmark agentic-company` to update it."
                )


AGENTIC_COMPANY_PROFILE = AgenticCompanyProfile()
