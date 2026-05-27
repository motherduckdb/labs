"""
Phase runner for BIRD-Bench evaluation.

Orchestrates the multi-phase evaluation:
1. Train phase: Run 150 questions on all configs/models
2. History integration: Enrich bird_bench_c with query patterns
3. Test phase: Run 350 questions on all configs/models
"""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from eval.config import (
    DATABASE_CONFIGS,
    ConfigType,
    DatabaseConfig,
    DEFAULT_PROVIDER,
    EvalConfig,
    MODELS,
    ModelConfig,
    RESULTS_DIR,
    SQLITE_DB_DIR,
)
from eval.sampler import DatasetSplit, load_split
from eval.scoring import (
    ScoredResult,
    AccuracyStats,
    score_result,
    calculate_accuracy_stats,
)

# Import from existing evaluation infrastructure
from src.providers import create_provider, ModelConfig as ProviderModelConfig, EvalResult
from src.comparison import CorrectnessLevel
from src.mcp_client import MotherDuckMCPClient
import controllog
# Schema helper imports removed - models now discover schema via tools
from src.schema_linker import link_tables
from src.sql_executor import execute_sql_returning_error_string
from src.sql_utils import sqlite_to_duckdb


@dataclass
class PhaseResult:
    """Results from a single phase (train or test)."""
    phase: str  # "train" or "test"
    model: str
    config_type: ConfigType
    database: str
    results: list[EvalResult]
    scored_results: list[ScoredResult]
    stats: AccuracyStats
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> dict:
        return {
            "phase": self.phase,
            "model": self.model,
            "config_type": self.config_type.value,
            "database": self.database,
            "stats": {
                "total": self.stats.total,
                "correct": self.stats.correct,
                "correct_gold": self.stats.correct_gold,
                "correct_platinum": self.stats.correct_platinum,
                "correct_judge": self.stats.correct_judge,
                "partial_accepted": self.stats.partial_accepted,
                "partial_unaccepted": self.stats.partial_unaccepted,
                "incorrect": self.stats.incorrect,
                "error": self.stats.error,
                "accuracy": self.stats.accuracy,
                "accuracy_pct": self.stats.accuracy_pct,
            },
            "timestamp": self.timestamp,
        }


@dataclass
class EvalRun:
    """Complete evaluation run results."""
    train_results: list[PhaseResult]
    test_results: list[PhaseResult]
    config: EvalConfig
    start_time: str
    end_time: str | None = None

    def to_dict(self) -> dict:
        return {
            "start_time": self.start_time,
            "end_time": self.end_time,
            "config": {
                "train_seed": self.config.train_seed,
                "test_seed": self.config.test_seed,
                "train_ratio": self.config.train_ratio,
            },
            "train_results": [r.to_dict() for r in self.train_results],
            "test_results": [r.to_dict() for r in self.test_results],
        }


class PhaseRunner:
    """
    Orchestrates multi-phase evaluation across models and database configs.
    """

    def __init__(
        self,
        eval_config: EvalConfig | None = None,
        motherduck_token: str | None = None,
        log_dir: Path | None = None,
        introspect: bool = False,
        judge: bool = False,
        run_id: str | None = None,
    ):
        """
        Initialize the phase runner.

        Args:
            eval_config: Evaluation configuration
            motherduck_token: MotherDuck authentication token
            log_dir: Directory for logs (used by error investigator)
            introspect: Whether to run error investigation on incorrect answers
            judge: Whether to use LLM judge for non-exact matches
            run_id: Unique identifier for this eval run. Threaded into every
                controllog idempotency key so retries within the run dedupe
                but separate runs don't collide on deterministic event_ids.
        """
        self.config = eval_config or EvalConfig()
        self.motherduck_token = motherduck_token
        self.log_dir = log_dir
        self.introspect = introspect
        self.judge = judge
        self.run_id = run_id

        import os
        if not self.motherduck_token:
            self.motherduck_token = os.environ.get("MOTHERDUCK_TOKEN")

        if not self.motherduck_token:
            raise ValueError("MOTHERDUCK_TOKEN required")

        # SQLite database path for gold SQL execution
        self.sqlite_dir = SQLITE_DB_DIR

        # Shared MCP client - created lazily, used across all evaluations
        self._mcp_client: MotherDuckMCPClient | None = None

        # Error investigator - initialized if introspect is enabled
        self._investigator = None
        if self.introspect and self.log_dir:
            from src.error_investigator import ErrorInvestigator
            self._investigator = ErrorInvestigator(self.log_dir)
            print("Error investigation enabled")

        # LLM judge - initialized if judge is enabled
        self._truth_seeker = None
        self._judge_results: list = []  # Collect (result, model, config) tuples for report
        if self.judge:
            from src.truth_seeker import TruthSeekingInspector
            self._truth_seeker = TruthSeekingInspector()
            print("LLM judge enabled (gemini-3-flash)")

        # Load platinum answers for fallback matching
        from src.platinum import load_platinum
        self._platinum_answers = load_platinum()
        if self._platinum_answers:
            print(f"Loaded {len(self._platinum_answers)} platinum answers")

    @property
    def mcp_client(self) -> MotherDuckMCPClient:
        """Get shared MCP client (lazy initialization)."""
        if self._mcp_client is None:
            self._mcp_client = MotherDuckMCPClient(self.motherduck_token)
            self._mcp_client.initialize()
            print("Initialized shared MCP client")
        return self._mcp_client

    def close(self):
        """Close shared resources."""
        if self._mcp_client is not None:
            self._mcp_client.close()
            self._mcp_client = None
            print("Closed shared MCP client")
        if self._investigator is not None:
            self._investigator.close()
            self._investigator = None

    def _should_judge(
        self,
        correctness_level: CorrectnessLevel,
        partial_reason: str | None,
        match_source: str | None,
    ) -> bool:
        """
        Determine if we should invoke the LLM judge.

        Returns True only when gold/platinum/partial+ all failed.
        """
        # Already correct (gold or platinum)
        if correctness_level == CorrectnessLevel.CORRECT:
            return False

        # Already matched via gold or platinum
        if match_source in ("gold", "platinum"):
            return False

        # Hit iteration limit - not a correctness issue
        if correctness_level == CorrectnessLevel.HIT_LIMIT:
            return False

        # Error - can't judge without results
        if correctness_level == CorrectnessLevel.ERROR:
            return False

        # Check for accepted partial reasons (these already get credit)
        if correctness_level == CorrectnessLevel.PARTIAL and partial_reason:
            accepted_prefixes = (
                "extra_columns",
                "extra_duplicates",
                "implicit_distinct",
                "aggregated_equivalent",
            )
            if any(partial_reason.startswith(p) for p in accepted_prefixes):
                return False

        # All other cases should be judged
        return True

    def get_judge_results(self) -> tuple[list, dict]:
        """
        Get collected judge results for reporting.

        Returns:
            Tuple of (results list, model_config_map dict)
            model_config_map maps question_id to (model, config) tuple
        """
        results = []
        model_config_map = {}
        for item in self._judge_results:
            result, model, config = item
            results.append(result)
            model_config_map[result.question_id] = (model, config)
        return results, model_config_map

    def _execute_gold_sql_sqlite(self, sql: str, db_id: str) -> list | str:
        """Execute gold SQL against local SQLite database."""
        import sqlite3

        db_path = self.sqlite_dir / db_id / f"{db_id}.sqlite"
        if not db_path.exists():
            # Try alternate paths
            alt_path = self.sqlite_dir / db_id / "sqlite" / f"{db_id}.sqlite"
            if alt_path.exists():
                db_path = alt_path
            else:
                # Find any sqlite file
                sqlite_files = list((self.sqlite_dir / db_id).glob("*.sqlite"))
                if sqlite_files:
                    db_path = sqlite_files[0]
                else:
                    return f"ERROR: SQLite database not found for {db_id}"

        try:
            conn = sqlite3.connect(str(db_path))
            cursor = conn.cursor()
            cursor.execute(sql)
            rows = cursor.fetchall()
            conn.close()
            return [tuple(row) for row in rows]
        except Exception as e:
            return f"ERROR: {e}"

    async def _evaluate_question(
        self,
        question: dict,
        provider_config: ProviderModelConfig,
        provider,
        db_config: DatabaseConfig,
        mcp_client: MotherDuckMCPClient,
    ) -> EvalResult:
        """Evaluate a single question."""
        from src.comparison import compare_with_platinum_fallback

        db_id = question["db_id"]
        question_text = question["question"]

        # Generate SQL using the model (model discovers schema via tools)
        predicted_sql, meta = await provider.run_query(
            question_text,
            question.get("evidence", ""),
            db_id,
            motherduck_db=db_config.database_name,
        )

        # Execute gold SQL against SQLite
        gold_result = self._execute_gold_sql_sqlite(question["SQL"], db_id)

        # Execute predicted SQL against MotherDuck
        predicted_result = None
        if predicted_sql and not meta.get("error"):
            predicted_result = execute_sql_returning_error_string(
                sql=predicted_sql,
                schema=db_id,
                mcp_client=mcp_client,
                translate_from_sqlite=False,
                database=db_config.database_name,
            )

        # Compare results with platinum fallback
        correctness_level, partial_reason, match_source = compare_with_platinum_fallback(
            gold_result,
            predicted_result,
            question["question_id"],
            self._platinum_answers,
        )

        # Override to HIT_LIMIT if iteration limit was reached
        hit_iteration_limit = meta.get("hit_iteration_limit", False)
        if hit_iteration_limit:
            correctness_level = CorrectnessLevel.HIT_LIMIT

        # LLM judge as last resort (only when gold/platinum/partial+ all failed)
        judge_result = None
        if self._truth_seeker is not None and self._should_judge(correctness_level, partial_reason, match_source):
            try:
                # Get platinum entry if exists
                question_id = question["question_id"]
                platinum_entry = self._platinum_answers.get(question_id)

                judge_result = self._truth_seeker.judge_single(
                    question_id=question_id,
                    db_id=db_id,
                    question=question_text,
                    evidence=question.get("evidence"),
                    gold_sql=question["SQL"],
                    gold_result=gold_result,
                    predicted_sql=predicted_sql,
                    predicted_result=predicted_result,
                    platinum_entry=platinum_entry,
                )

                # If judge approves, upgrade to JUDGE_CORRECT
                if judge_result.verdict in ("PREDICTED_CORRECT", "BOTH_CORRECT"):
                    correctness_level = CorrectnessLevel.JUDGE_CORRECT
                    match_source = "judge"

                # Collect for report with model/config context
                self._judge_results.append((judge_result, provider_config.display_name, db_config.display_name))

                # Log judge result to controllog
                model_name = provider_config.display_name
                if controllog.is_initialized():
                    controllog.event(
                        kind="llm_judge",
                        run_id=self.run_id,
                        postings=[],  # No accounting for judge calls
                        idempotency_key=f"judge:{self.run_id}:{question_id}:{db_id}:{model_name}",
                        payload={
                            "question_id": question_id,
                            "db_id": db_id,
                            "model": model_name,
                            "verdict": judge_result.verdict,
                            "confidence": judge_result.confidence,
                            "reasoning": judge_result.reasoning,
                            "recommendation": judge_result.recommendation,
                            "had_platinum_context": platinum_entry is not None,
                            "approved": judge_result.verdict in ("PREDICTED_CORRECT", "BOTH_CORRECT"),
                        },
                    )

            except Exception as e:
                print(f"  Judge error for Q{question['question_id']}: {e}")

        is_correct = correctness_level in (CorrectnessLevel.CORRECT, CorrectnessLevel.JUDGE_CORRECT)

        return EvalResult(
            question_id=question["question_id"],
            db_id=db_id,
            question=question["question"],
            evidence=question.get("evidence", ""),
            gold_sql=question["SQL"],
            predicted_sql=predicted_sql,
            gold_result=gold_result,
            predicted_result=predicted_result,
            is_correct=is_correct,
            error=meta.get("error"),
            model_config=provider_config,
            input_tokens=meta.get("input_tokens", 0),
            output_tokens=meta.get("output_tokens", 0),
            cost_usd=meta.get("cost_usd", 0),
            duration_ms=meta.get("duration_ms", 0),
            tool_calls=meta.get("tool_calls", 0),
            raw_response={"messages": meta.get("raw_messages", [])},
            correctness_level=correctness_level,
            partial_match_reason=partial_reason,
            hit_iteration_limit=hit_iteration_limit,
            match_source=match_source,
        )

    async def run_phase(
        self,
        phase: str,
        questions: list[dict],
        models: list[ModelConfig],
        db_configs: list[DatabaseConfig],
        max_concurrent: int = 5,
    ) -> list[PhaseResult]:
        """
        Run a single phase (train or test) across all models and configs.

        Args:
            phase: "train" or "test"
            questions: Questions to evaluate
            models: Models to test
            db_configs: Database configurations to test
            max_concurrent: Max concurrent evaluations

        Returns:
            List of PhaseResult for each model/config combination
        """
        results = []

        for model in models:
            for db_config in db_configs:
                print(f"\n{'='*60}")
                print(f"Phase: {phase.upper()}")
                print(f"Model: {model.name}")
                print(f"Config: {db_config.display_name}")
                print(f"Database: {db_config.database_name}")
                print(f"Questions: {len(questions)}")
                print(f"{'='*60}")

                # Create provider config
                provider_config = ProviderModelConfig(
                    model_id=model.provider_id,
                    display_name=model.name,
                    temperature=0.1,
                    include_sample_rows=True,
                    include_fk_info=True,
                )

                # Create fresh MCP client for each database config to avoid session state issues
                # Close existing client if any
                if self._mcp_client is not None:
                    self._mcp_client.close()
                    self._mcp_client = None
                mcp_client = self.mcp_client  # This creates a new one

                # Create provider with shared MCP client
                provider = create_provider(
                    provider_config,
                    self.motherduck_token,
                    use_optimized_prompts=True,
                    shared_mcp_client=mcp_client,
                )

                # Run evaluations with concurrency control
                semaphore = asyncio.Semaphore(max_concurrent)

                async def eval_with_semaphore(q: dict, idx: int) -> EvalResult:
                    async with semaphore:
                        print(f"  [{idx+1}/{len(questions)}] Q{q['question_id']} ({q['db_id']})...")
                        result = await self._evaluate_question(
                            q, provider_config, provider, db_config, mcp_client
                        )
                        status = "PASS" if result.is_correct else "FAIL"
                        print(f"    [{status}] ${result.cost_usd:.4f}")

                        # Log to controllog if initialized
                        if controllog.is_initialized():
                            task_id = str(q["question_id"])
                            agent_id = "bird-eval"
                            exchange_id = f"{self.run_id}:{phase}:{model.name}:{db_config.database_name}:q{q['question_id']}"
                            controllog.model_prompt(
                                exchange_id=exchange_id,
                                task_id=task_id,
                                agent_id=agent_id,
                                run_id=self.run_id,
                                prompt_tokens=result.input_tokens,
                                model=model.provider_id,
                                provider=DEFAULT_PROVIDER,
                                payload={
                                    "question_id": q["question_id"],
                                    "question": q["question"],
                                    "evidence": q.get("evidence", ""),
                                    "db_id": q["db_id"],
                                    "database": db_config.database_name,
                                    "config_type": db_config.config_type.value,
                                    "gold_sql": q["SQL"],
                                },
                            )
                            controllog.model_completion(
                                exchange_id=exchange_id,
                                task_id=task_id,
                                agent_id=agent_id,
                                run_id=self.run_id,
                                completion_tokens=result.output_tokens,
                                cost_money=result.cost_usd,
                                wall_ms=result.duration_ms,
                                model=model.provider_id,
                                provider=DEFAULT_PROVIDER,
                                payload={
                                    # error_report.py reads these from payload — keep
                                    # them alongside the (newer) builder-canonical fields.
                                    "cost_usd": result.cost_usd,
                                    "duration_ms": result.duration_ms,
                                    "success": result.error is None,
                                    "error": result.error,
                                    "question_id": q["question_id"],
                                    "db_id": q["db_id"],
                                    "question": q["question"],
                                    "evidence": q.get("evidence", ""),
                                    "gold_sql": q["SQL"],
                                    "predicted_sql": result.predicted_sql,
                                    "gold_result": result.gold_result,
                                    "predicted_result": result.predicted_result,
                                    "is_correct": result.is_correct,
                                    "correctness_level": result.correctness_level.value if result.correctness_level else None,
                                    "partial_reason": result.partial_match_reason,
                                    "match_source": result.match_source,
                                    "raw_response": result.raw_response,
                                    "hit_iteration_limit": result.hit_iteration_limit,
                                },
                            )

                        # Investigate errors if introspection is enabled
                        if self._investigator and result.correctness_level != CorrectnessLevel.CORRECT:
                            try:
                                print(f"    [INVESTIGATING]")
                                # Get conversation history from raw_response
                                conversation_history = result.raw_response.get("messages", [])
                                investigation = await self._investigator.investigate(
                                    provider=provider,
                                    conversation_history=conversation_history,
                                    question_id=q["question_id"],
                                    db_id=q["db_id"],
                                    database_name=db_config.database_name,
                                    model_name=model.name,
                                    gold_sql=q["SQL"],
                                    predicted_sql=result.predicted_sql,
                                    gold_result=result.gold_result,
                                    predicted_result=result.predicted_result,
                                    correctness_level=result.correctness_level.value,
                                    partial_reason=result.partial_match_reason,
                                    hit_iteration_limit=result.hit_iteration_limit,
                                )

                                # Log investigation to controllog
                                if controllog.is_initialized():
                                    controllog.event(
                                        kind="error_investigation",
                                        run_id=self.run_id,
                                        postings=[],  # No accounting for investigations
                                        idempotency_key=f"investigation:{self.run_id}:{q['question_id']}:{model.provider_id}:{db_config.database_name}",
                                        payload={
                                            "question_id": q["question_id"],
                                            "db_id": q["db_id"],
                                            "dataset": investigation.dataset,
                                            "model": model.provider_id,  # Use provider_id to match model_completion events
                                            "category": investigation.category,
                                            "short_description": investigation.short_description,
                                            "detailed_description": investigation.detailed_description,
                                            "fix": investigation.fix,
                                            "gold_tables": investigation.gold_tables,
                                            "predicted_tables": investigation.predicted_tables,
                                            "correctness_level": investigation.correctness_level,
                                            "partial_reason": investigation.partial_reason,
                                        },
                                    )
                                print(f"    [{investigation.category}] {investigation.short_description}")
                            except Exception as e:
                                print(f"    [INVESTIGATION FAILED] {e}")

                        return result

                try:
                    tasks = [eval_with_semaphore(q, i) for i, q in enumerate(questions)]
                    eval_results = await asyncio.gather(*tasks, return_exceptions=True)
                finally:
                    # Only close provider, NOT the shared MCP client
                    provider.close()

                # Filter valid results
                valid_results = [r for r in eval_results if isinstance(r, EvalResult)]

                # Score results
                scored = [
                    score_result(r.correctness_level, r.partial_match_reason, r.match_source)
                    for r in valid_results
                ]
                stats = calculate_accuracy_stats(scored)

                # Create phase result
                phase_result = PhaseResult(
                    phase=phase,
                    model=model.name,
                    config_type=db_config.config_type,
                    database=db_config.database_name,
                    results=valid_results,
                    scored_results=scored,
                    stats=stats,
                )

                results.append(phase_result)

                # Print summary with all categories
                print(f"\n{model.name} / {db_config.display_name} Summary:")
                print(f"  Accuracy: {stats.accuracy_pct} ({stats.credited}/{stats.total})")
                # Build correct breakdown
                correct_parts = [f"gold: {stats.correct_gold}"]
                if stats.correct_platinum > 0:
                    correct_parts.append(f"platinum: {stats.correct_platinum}")
                if stats.correct_judge > 0:
                    correct_parts.append(f"judge: {stats.correct_judge}")
                print(f"  Correct: {stats.correct} ({', '.join(correct_parts)}), Partial+: {stats.partial_accepted}")
                print(f"  Incorrect: {stats.incorrect}, Partial-: {stats.partial_unaccepted}, Hit limit: {stats.hit_limit}, Error: {stats.error}")

        return results

    async def run_full_evaluation(
        self,
        split: DatasetSplit | None = None,
        models: list[ModelConfig] | None = None,
    ) -> EvalRun:
        """
        Run the complete evaluation: train → history integration → test.

        Args:
            split: Train/test split (loads from file if not provided)
            models: Models to evaluate (uses default MODELS if not provided)

        Returns:
            EvalRun with all results
        """
        # Load split if not provided
        if split is None:
            split = load_split()

        # Use all models if not specified
        if models is None:
            models = MODELS

        # Get all database configs
        db_configs = list(DATABASE_CONFIGS.values())

        start_time = datetime.now().isoformat()

        print("=" * 60)
        print("BIRD-Bench Full Evaluation")
        print("=" * 60)
        print(f"Train questions: {len(split.train)}")
        print(f"Test questions: {len(split.test)}")
        print(f"Models: {[m.name for m in models]}")
        print(f"Configs: {[c.display_name for c in db_configs]}")
        print()

        # Phase 1: Train
        print("\n" + "=" * 60)
        print("PHASE 1: TRAIN")
        print("=" * 60)
        train_results = await self.run_phase(
            phase="train",
            questions=split.train,
            models=models,
            db_configs=db_configs,
            max_concurrent=self.config.max_concurrent,
        )

        # History Integration reminder
        print("\n" + "=" * 60)
        print("HISTORY INTEGRATION")
        print("=" * 60)
        print("Train phase complete. Before running test phase, integrate query history:")
        print()
        print("  cd ~/code/metadata_generator")
        print(f"  uv run metadata-generator history <schema> -d {DATABASE_CONFIGS[ConfigType.FULL].database_name}")
        print(f"  uv run metadata-generator describe <schema> -d {DATABASE_CONFIGS[ConfigType.FULL].database_name}")
        print(f"  uv run metadata-generator sql <schema> -d {DATABASE_CONFIGS[ConfigType.FULL].database_name} --execute")
        print()
        print("Then run: uv run bird-eval test")
        print()

        # For now, continue to test phase (user can run separately if needed)
        input("Press Enter to continue to test phase (or Ctrl+C to stop and run history integration)...")

        # Phase 2: Test
        print("\n" + "=" * 60)
        print("PHASE 2: TEST")
        print("=" * 60)
        test_results = await self.run_phase(
            phase="test",
            questions=split.test,
            models=models,
            db_configs=db_configs,
            max_concurrent=self.config.max_concurrent,
        )

        end_time = datetime.now().isoformat()

        # Create eval run
        eval_run = EvalRun(
            train_results=train_results,
            test_results=test_results,
            config=self.config,
            start_time=start_time,
            end_time=end_time,
        )

        # Save results
        self._save_results(eval_run)

        # Clean up shared MCP client
        self.close()

        return eval_run

    def _save_results(self, eval_run: EvalRun) -> Path:
        """Save evaluation results to file."""
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = RESULTS_DIR / f"eval_run_{timestamp}.json"

        with open(output_file, "w") as f:
            json.dump(eval_run.to_dict(), f, indent=2, default=str)

        print(f"\nResults saved to: {output_file}")
        return output_file


async def run_evaluation(models: list[str] | None = None) -> EvalRun:
    """
    Convenience function to run evaluation.

    Args:
        models: Model names to evaluate (default: all)

    Returns:
        EvalRun with results
    """
    from dotenv import load_dotenv
    load_dotenv()

    # Filter models if specified
    model_list = MODELS
    if models:
        model_list = [m for m in MODELS if m.name in models]

    runner = PhaseRunner()
    return await runner.run_full_evaluation(models=model_list)


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv

    load_dotenv()

    # Parse arguments
    models = None
    for i, arg in enumerate(sys.argv):
        if arg == "--models" and i + 1 < len(sys.argv):
            models = sys.argv[i + 1].split(",")

    # Run evaluation
    asyncio.run(run_evaluation(models=models))
