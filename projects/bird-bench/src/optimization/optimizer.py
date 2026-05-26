"""
BIRD-Bench Optimizer using GEPA and DSPy

Implements Generalized Evolutionary Prompting Algorithm (GEPA) with DSPy
for optimizing text-to-SQL prompts and generation strategies.
"""

import asyncio
import json
import os
import random
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Callable

import dspy
import optuna
import pandas as pd

from src.providers import create_provider, ModelConfig, MODELS, BaseProvider
from src.schema_helper import get_schema_info
from src.mcp_client import MotherDuckMCPClient
from src.sql_utils import sqlite_to_duckdb
from src.constants import MOTHERDUCK_DATABASE
from src.comparison import results_match
from src.sql_executor import execute_sql_returning_error_string


class OptimizedProvider(BaseProvider):
    """Provider that uses custom prompts for optimization."""

    def __init__(self, config: ModelConfig, motherduck_token: str,
                 system_prompt: str, user_template: str, generation_params: Dict):
        super().__init__(config, motherduck_token)
        self.custom_system_prompt = system_prompt
        self.custom_user_template = user_template
        self.custom_params = generation_params

    def build_system_prompt(self, db_id: str, schema_info: str) -> str:
        """Use the optimized system prompt."""
        return self.custom_system_prompt.format(db_id=db_id)

    def build_user_prompt(self, question: str, evidence: str) -> str:
        """Use the optimized user prompt template."""
        return self.custom_user_template.format(
            question=question,
            evidence=evidence or "None provided"
        )

    async def run_query(
        self,
        question: str,
        evidence: str,
        db_id: str,
        schema_info: str
    ) -> tuple[str | None, dict]:
        """Run text-to-SQL query with optimized prompts."""
        from providers.openrouter import OpenRouterProvider
        import time

        # Create a temporary config with custom parameters
        temp_config = ModelConfig(
            model_id=self.config.model_id,
            display_name=self.config.display_name,
            max_tokens=self.custom_params.get("max_tokens", self.config.max_tokens),
            temperature=self.custom_params.get("temperature", self.config.temperature),
        )

        # Create the base provider
        base_provider = OpenRouterProvider(temp_config, self.motherduck_token)

        # Temporarily replace the prompt methods
        original_system = base_provider.build_system_prompt
        original_user = base_provider.build_user_prompt

        base_provider.build_system_prompt = lambda db_id, schema_info: self.build_system_prompt(db_id, schema_info)
        base_provider.build_user_prompt = lambda question, evidence: self.build_user_prompt(question, evidence)

        try:
            print(f"    Running query for db_id={db_id}, question='{question[:50]}...'")
            result = await base_provider.run_query(question, evidence, db_id, schema_info)
            print(f"    Query result: sql='{result[0][:50] if result[0] else None}', meta_keys={list(result[1].keys()) if result[1] else None}")
            return result
        except Exception as e:
            print(f"    Query exception: {e}")
            raise
        finally:
            base_provider.close()



@dataclass
class OptimizationConfig:
    """Configuration for optimization process."""
    model_config: ModelConfig
    max_generations: int = 10
    population_size: int = 8
    mutation_rate: float = 0.3
    crossover_rate: float = 0.7
    elite_count: int = 2
    eval_sample_size: int = 20  # Questions to evaluate per generation
    max_iterations_per_prompt: int = 5
    output_dir: str = "data/optimization_results"


@dataclass
class PromptCandidate:
    """A candidate prompt with fitness score."""
    system_prompt: str
    user_prompt_template: str
    generation_params: Dict[str, Any] = field(default_factory=dict)
    fitness: float = 0.0
    accuracy: float = 0.0
    cost: float = 0.0
    generation: int = 0
    id: str = ""


class TextToSQLProgram(dspy.Module):
    """DSPy program for text-to-SQL generation with semantic awareness."""

    def __init__(self, system_prompt: str, user_prompt_template: str):
        super().__init__()
        self.system_prompt = system_prompt
        self.user_prompt_template = user_prompt_template

        # DSPy signatures with semantic guidance built in
        # Step 1: Analyze question with semantic awareness
        self.analyze_question = dspy.ChainOfThought(
            "question, evidence -> analysis, required_columns, aggregation_type"
        )

        # Step 2: Plan query considering column selection and aggregation
        self.plan_query = dspy.ChainOfThought(
            "analysis, required_columns, aggregation_type, schema_info -> query_plan, join_strategy"
        )

        # Step 3: Generate SQL with DuckDB-specific syntax
        self.generate_sql = dspy.ChainOfThought(
            "query_plan, join_strategy, schema_info -> sql_query"
        )

        # Step 4: Validate SQL (single-pass check)
        self.validate_sql = dspy.ChainOfThought(
            "sql_query, required_columns, aggregation_type -> validated_sql, is_valid"
        )

    def forward(self, question: str, evidence: str, schema_info: str) -> dspy.Prediction:
        """Generate SQL query using semantic-aware DSPy program."""
        # Step 1: Analyze with semantic awareness
        # - What columns are needed (contextual, not just minimal)?
        # - Is this a per-entity aggregation or simple ratio?
        analysis = self.analyze_question(
            question=question,
            evidence=evidence or "None provided"
        )

        # Step 2: Plan the query
        query_plan = self.plan_query(
            analysis=analysis.analysis,
            required_columns=analysis.required_columns,
            aggregation_type=analysis.aggregation_type,
            schema_info=schema_info
        )

        # Step 3: Generate SQL
        sql_result = self.generate_sql(
            query_plan=query_plan.query_plan,
            join_strategy=query_plan.join_strategy,
            schema_info=schema_info
        )

        # Step 4: Validate (single-pass, no retry)
        validated = self.validate_sql(
            sql_query=sql_result.sql_query,
            required_columns=analysis.required_columns,
            aggregation_type=analysis.aggregation_type
        )

        return validated


class GEPAOptimizer:
    """Generalized Evolutionary Prompting Algorithm optimizer."""

    def __init__(self, config: OptimizationConfig, motherduck_token: str):
        self.config = config
        self.motherduck_token = motherduck_token
        self.population: List[PromptCandidate] = []
        self.generation = 0
        self.best_candidate: Optional[PromptCandidate] = None
        self.history: List[Dict[str, Any]] = []
        self._mcp_client: MotherDuckMCPClient | None = None

        # Setup output directory
        self.output_dir = Path(config.output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Initialize DSPy
        dspy.settings.configure(lm=self._create_dspy_lm())

    @property
    def mcp(self) -> MotherDuckMCPClient:
        """Lazy MCP client initialization."""
        if self._mcp_client is None:
            self._mcp_client = MotherDuckMCPClient(self.motherduck_token)
            self._mcp_client.initialize()
        return self._mcp_client

    def _create_dspy_lm(self) -> dspy.LM:
        """Create DSPy language model wrapper."""
        # Create a simple wrapper for our OpenRouter provider
        class OpenRouterLM(dspy.LM):
            def __init__(self, model_config: ModelConfig, motherduck_token: str):
                self.model_config = model_config
                self.motherduck_token = motherduck_token
                self.provider = None

            def __call__(self, prompt: str, **kwargs) -> str:
                """Basic call method - simplified for optimization."""
                if self.provider is None:
                    self.provider = create_provider(self.model_config, self.motherduck_token)

                # For now, just return a simple SQL query
                # This will be enhanced with proper DSPy integration
                return "SELECT * FROM test_table LIMIT 1;"

        return OpenRouterLM(self.config.model_config, self.motherduck_token)

    def _create_initial_population(self, questions: List[Dict]) -> List[PromptCandidate]:
        """Create initial population of prompt candidates."""
        population = []

        # Semantic guidance blocks (based on failure analysis)
        column_selection_hint = """
COLUMN SELECTION: When asked "which X did Y", return BOTH the identifier AND contextual columns.
Include columns that identify entities mentioned in the question."""

        aggregation_hint = """
AGGREGATION: "On average how many X per Y" means AVG of grouped counts, not a simple ratio.
Use subqueries: SELECT AVG(cnt) FROM (SELECT COUNT(*) as cnt ... GROUP BY entity)"""

        evidence_hint = """
EVIDENCE HINTS: These provide guidance but may not be exact SQL logic.
Cross-check hints against the question's semantic meaning."""

        syntax_hint = """
DUCKDB SYNTAX: Never use backticks. Use double quotes for column names with spaces.
Schema-qualify all tables: {db_id}.table_name"""

        single_pass_hint = """
CRITICAL: Single-pass evaluation - you only get ONE attempt. Think carefully."""

        # Base prompt templates incorporating semantic guidance
        base_system_prompts = [
            f"""You are a SQL expert. Write DuckDB SQL queries to answer questions.
DATABASE: bird_bench
SCHEMA: {{db_id}}
Use schema-qualified table names like {{db_id}}.table_name.
{single_pass_hint}
{column_selection_hint}
{aggregation_hint}""",

            f"""Expert SQL developer for text-to-SQL tasks.
Database: bird_bench, Schema: {{db_id}}
Dialect: DuckDB
Tables accessed as {{db_id}}.table_name
{single_pass_hint}
{syntax_hint}
{evidence_hint}""",

            f"""Convert natural language questions to DuckDB SQL.
Context: bird_bench.{{db_id}} schema
{single_pass_hint}
{column_selection_hint}
{syntax_hint}""",
        ]

        base_user_templates = [
            """QUESTION: {question}
HINTS (verify against question semantics): {evidence}
CHECKLIST: 1) What columns to return? 2) Is "average" per-entity? 3) Do hints match question?
Generate SQL:""",

            """Task: Answer this question with SQL (SINGLE ATTEMPT)
{question}
Hints: {evidence}
Before writing: Consider what columns the answer needs.
SQL:""",

            """Write a SQL query for: {question}
Context: {evidence}
Remember: Include contextual columns, not just minimal answer.
SQL:""",
        ]

        for i in range(self.config.population_size):
            system_prompt = random.choice(base_system_prompts)
            user_template = random.choice(base_user_templates)

            # Add some random variations
            if random.random() < 0.5:
                system_prompt += "\nBe precise and efficient."
            if random.random() < 0.3:
                system_prompt += "\nUse appropriate JOINs and WHERE clauses."

            candidate = PromptCandidate(
                system_prompt=system_prompt,
                user_prompt_template=user_template,
                generation_params={
                    "temperature": random.uniform(0.0, 0.3),
                    "max_tokens": random.choice([2048, 3072, 4096]),
                },
                id=f"gen0_{i}"
            )

            population.append(candidate)

        return population

    def _mutate_candidate(self, candidate: PromptCandidate) -> PromptCandidate:
        """Mutate a prompt candidate with semantic-aware mutations."""
        new_candidate = PromptCandidate(
            system_prompt=candidate.system_prompt,
            user_prompt_template=candidate.user_prompt_template,
            generation_params=candidate.generation_params.copy(),
            generation=self.generation + 1,
            id=f"gen{self.generation + 1}_{random.randint(1000, 9999)}"
        )

        # Semantic mutations based on failure analysis
        semantic_system_mutations = [
            # Column selection guidance
            lambda p: p + "\nCOLUMN RULE: Return contextual columns, not just minimal answer.",
            lambda p: p + "\nWhen asked 'which X', include identifying columns for X.",
            # Aggregation guidance
            lambda p: p + "\nAVERAGE RULE: 'Average per entity' = AVG of grouped counts.",
            lambda p: p + "\nFor per-entity averages, use: AVG(cnt) FROM (SELECT COUNT(*) as cnt GROUP BY entity)",
            # Evidence interpretation
            lambda p: p + "\nEVIDENCE WARNING: Hints may not match exact SQL logic. Verify semantics.",
            # DuckDB syntax
            lambda p: p + "\nSYNTAX: No backticks. Use double quotes for spaces in column names.",
            lambda p: p + "\nGROUP BY: All non-aggregated SELECT columns must appear in GROUP BY.",
            # Single pass reminder
            lambda p: p + "\nCRITICAL: One attempt only. Verify before submitting.",
        ]

        generic_system_mutations = [
            lambda p: p + "\nUse EXPLAIN to optimize queries.",
            lambda p: p + "\nConsider performance implications.",
            lambda p: p.replace("SQL expert", "Senior SQL developer"),
            lambda p: p + "\nValidate results with test queries.",
            lambda p: p.replace("DuckDB", "DuckDB with schema qualification"),
        ]

        # Mutate system prompt - prefer semantic mutations
        if random.random() < self.config.mutation_rate:
            if random.random() < 0.7:  # 70% chance of semantic mutation
                mutation = random.choice(semantic_system_mutations)
            else:
                mutation = random.choice(generic_system_mutations)
            new_candidate.system_prompt = mutation(new_candidate.system_prompt)

        # Semantic user template mutations
        semantic_user_mutations = [
            lambda t: t + "\nCHECK: What columns should the result include?",
            lambda t: t + "\nCHECK: Is 'average' per-entity or a simple ratio?",
            lambda t: t + "\nCHECK: Do the hints match the question's meaning?",
            lambda t: t.replace("Generate SQL:", "Generate SQL (include contextual columns):"),
        ]

        generic_user_mutations = [
            lambda t: t.replace("Question:", "Q:"),
            lambda t: t + "\nEnsure correct table joins.",
            lambda t: t.replace("SQL:", "DuckDB SQL:"),
            lambda t: "Context: " + t,
        ]

        # Mutate user template - prefer semantic mutations
        if random.random() < self.config.mutation_rate:
            if random.random() < 0.7:  # 70% chance of semantic mutation
                mutation = random.choice(semantic_user_mutations)
            else:
                mutation = random.choice(generic_user_mutations)
            new_candidate.user_prompt_template = mutation(new_candidate.user_prompt_template)

        # Mutate generation params
        if random.random() < self.config.mutation_rate:
            new_candidate.generation_params["temperature"] = random.uniform(0.0, 0.5)
            new_candidate.generation_params["max_tokens"] = random.choice([1024, 2048, 3072, 4096])

        return new_candidate

    def _crossover_candidates(self, parent1: PromptCandidate, parent2: PromptCandidate) -> Tuple[PromptCandidate, PromptCandidate]:
        """Create offspring from two parent candidates."""
        child1 = PromptCandidate(
            system_prompt=parent1.system_prompt if random.random() < 0.5 else parent2.system_prompt,
            user_prompt_template=parent1.user_prompt_template if random.random() < 0.5 else parent2.user_prompt_template,
            generation_params=parent1.generation_params.copy() if random.random() < 0.5 else parent2.generation_params.copy(),
            generation=self.generation + 1,
            id=f"gen{self.generation + 1}_{random.randint(1000, 9999)}"
        )

        child2 = PromptCandidate(
            system_prompt=parent2.system_prompt if random.random() < 0.5 else parent1.system_prompt,
            user_prompt_template=parent2.user_prompt_template if random.random() < 0.5 else parent1.user_prompt_template,
            generation_params=parent2.generation_params.copy() if random.random() < 0.5 else parent1.generation_params.copy(),
            generation=self.generation + 1,
            id=f"gen{self.generation + 1}_{random.randint(1000, 9999)}"
        )

        return child1, child2

    async def _evaluate_candidate_async(self, candidate: PromptCandidate, questions: List[Dict], schema_cache: Dict) -> PromptCandidate:
        """Evaluate a candidate prompt on a sample of questions."""
        # Create a custom provider that uses the candidate's prompts
        provider = OptimizedProvider(
            self.config.model_config,
            self.motherduck_token,
            candidate.system_prompt,
            candidate.user_prompt_template,
            candidate.generation_params
        )

        correct = 0
        total_cost = 0.0
        evaluated_questions = random.sample(questions, min(self.config.eval_sample_size, len(questions)))

        for question in evaluated_questions:
            try:
                # Get schema info
                db_id = question["db_id"]
                if db_id not in schema_cache:
                    schema_cache[db_id] = get_schema_info(db_id)

                # Run query with custom provider
                try:
                    predicted_sql, meta = await provider.run_query(
                        question["question"],
                        question.get("evidence", ""),
                        db_id,
                        schema_cache[db_id]
                    )

                    # Debug: print what we got
                    print(f"  Candidate {candidate.id}: SQL='{predicted_sql[:50] if predicted_sql else None}', Error='{meta.get('error', 'None') if meta else 'No meta'}'")
                except Exception as e:
                    print(f"  Candidate {candidate.id}: Exception during query: {e}")
                    predicted_sql, meta = None, {"error": str(e), "cost_usd": 0}

                # Get gold result via MCP
                gold_result = execute_sql_returning_error_string(
                    sql=question["SQL"],
                    schema=db_id,
                    mcp_client=self.mcp,
                    translate_from_sqlite=True,
                )

                # Get predicted result if we have SQL
                predicted_result = None
                if predicted_sql and not meta.get("error"):
                    predicted_result = execute_sql_returning_error_string(
                        sql=predicted_sql,
                        schema=db_id,
                        mcp_client=self.mcp,
                        translate_from_sqlite=True,
                    )

                # Compare results
                is_correct = results_match(gold_result, predicted_result)

                if is_correct:
                    correct += 1

                total_cost += meta.get("cost_usd", 0)

            except Exception as e:
                print(f"Error evaluating candidate {candidate.id}: {e}")
                continue

        provider.close()

        candidate.accuracy = correct / len(evaluated_questions) if evaluated_questions else 0
        candidate.cost = total_cost

        # Fitness combines accuracy and cost efficiency
        candidate.fitness = candidate.accuracy - (candidate.cost * 0.001)  # Penalize high cost

        return candidate

    def _select_parents(self) -> List[PromptCandidate]:
        """Select parents using tournament selection."""
        parents = []
        tournament_size = 3

        for _ in range(self.config.population_size - self.config.elite_count):
            tournament = random.sample(self.population, tournament_size)
            winner = max(tournament, key=lambda x: x.fitness)
            parents.append(winner)

        return parents

    def _create_next_generation(self) -> List[PromptCandidate]:
        """Create the next generation through selection, crossover, and mutation."""
        # Sort by fitness and keep elites
        sorted_population = sorted(self.population, key=lambda x: x.fitness, reverse=True)
        elites = sorted_population[:self.config.elite_count]

        # Select parents
        parents = self._select_parents()

        # Create offspring through crossover
        offspring = []
        for i in range(0, len(parents) - 1, 2):
            if random.random() < self.config.crossover_rate:
                child1, child2 = self._crossover_candidates(parents[i], parents[i + 1])
                offspring.extend([child1, child2])
            else:
                offspring.extend([parents[i], parents[i + 1]])

        # Apply mutation
        for candidate in offspring:
            if random.random() < self.config.mutation_rate:
                candidate = self._mutate_candidate(candidate)

        # Combine elites and offspring
        next_generation = elites + offspring[:self.config.population_size - self.config.elite_count]

        return next_generation

    async def optimize(self, questions: List[Dict]) -> PromptCandidate:
        """Run the GEPA optimization process."""
        print(f"Starting GEPA optimization for {self.config.model_config.display_name}")
        print(f"Population size: {self.config.population_size}, Generations: {self.config.max_generations}")

        # Initialize population
        self.population = self._create_initial_population(questions)
        schema_cache = {}

        # Evaluate initial population
        print("Evaluating initial population...")
        for i, candidate in enumerate(self.population):
            print(f"  Evaluating candidate {i+1}/{len(self.population)}")
            self.population[i] = await self._evaluate_candidate_async(candidate, questions, schema_cache)

        self.best_candidate = max(self.population, key=lambda x: x.fitness)
        self._save_generation_results()

        # Evolutionary loop
        for generation in range(self.config.max_generations):
            self.generation = generation + 1
            print(f"\nGeneration {self.generation}/{self.config.max_generations}")

            # Create next generation
            self.population = self._create_next_generation()

            # Evaluate new candidates
            print("Evaluating new generation...")
            for i, candidate in enumerate(self.population):
                if candidate.generation == self.generation:  # Only evaluate new candidates
                    print(f"  Evaluating candidate {i+1}/{len(self.population)}")
                    self.population[i] = await self._evaluate_candidate_async(candidate, questions, schema_cache)

            # Update best candidate
            current_best = max(self.population, key=lambda x: x.fitness)
            if current_best.fitness > self.best_candidate.fitness:
                self.best_candidate = current_best
                print(f"New best candidate found: {current_best.fitness:.3f}")
            self._save_generation_results()

            print(f"Best fitness: {self.best_candidate.fitness:.3f}, "
                  f"Accuracy: {self.best_candidate.accuracy:.1%}")

        # Save final results
        self._save_final_results()

        return self.best_candidate

    def _save_generation_results(self):
        """Save results for current generation."""
        gen_results = {
            "generation": self.generation,
            "timestamp": time.time(),
            "population": [
                {
                    "id": c.id,
                    "fitness": c.fitness,
                    "accuracy": c.accuracy,
                    "cost": c.cost,
                    "system_prompt": c.system_prompt,
                    "user_template": c.user_prompt_template,
                    "params": c.generation_params
                }
                for c in self.population
            ],
            "best_candidate": {
                "id": self.best_candidate.id,
                "fitness": self.best_candidate.fitness,
                "accuracy": self.best_candidate.accuracy,
                "cost": self.best_candidate.cost,
                "system_prompt": self.best_candidate.system_prompt,
                "user_template": self.best_candidate.user_prompt_template,
                "params": self.best_candidate.generation_params
            } if self.best_candidate else None
        }

        self.history.append(gen_results)

        # Save to file
        with open(self.output_dir / f"generation_{self.generation}.json", "w") as f:
            json.dump(gen_results, f, indent=2)

    def _save_final_results(self):
        """Save final optimization results."""
        final_results = {
            "config": {
                "model": self.config.model_config.display_name,
                "model_id": self.config.model_config.model_id,
                "max_generations": self.config.max_generations,
                "population_size": self.config.population_size,
                "eval_sample_size": self.config.eval_sample_size,
            },
            "best_candidate": {
                "id": self.best_candidate.id,
                "fitness": self.best_candidate.fitness,
                "accuracy": self.best_candidate.accuracy,
                "cost": self.best_candidate.cost,
                "system_prompt": self.best_candidate.system_prompt,
                "user_template": self.best_candidate.user_prompt_template,
                "params": self.best_candidate.generation_params
            } if self.best_candidate else None,
            "history": self.history
        }

        with open(self.output_dir / "final_results.json", "w") as f:
            json.dump(final_results, f, indent=2)

        # Close MCP client
        if self._mcp_client:
            self._mcp_client.close()

        print(f"\nOptimization complete! Results saved to {self.output_dir}")
        print(f"Best candidate: {self.best_candidate.id if self.best_candidate else 'None'}")
        if self.best_candidate:
            print(f"Fitness: {self.best_candidate.fitness:.3f}")
            print(f"Accuracy: {self.best_candidate.accuracy:.1%}")


class DSPyOptimizer:
    """DSPy-based optimizer for text-to-SQL programs."""

    def __init__(self, model_config: ModelConfig, motherduck_token: str):
        self.model_config = model_config
        self.motherduck_token = motherduck_token
        self.lm = self._create_dspy_lm()

        # Configure DSPy
        dspy.settings.configure(lm=self.lm)

    def _create_dspy_lm(self) -> dspy.LM:
        """Create DSPy language model wrapper for OpenRouter."""
        class OpenRouterLM(dspy.LM):
            def __init__(self, model_config: ModelConfig, motherduck_token: str):
                super().__init__(model_config.model_id)
                self.model_config = model_config
                self.motherduck_token = motherduck_token
                self.provider = None

            def __call__(self, prompt: str, **kwargs) -> str:
                """Call the language model."""
                if self.provider is None:
                    self.provider = create_provider(self.model_config, self.motherduck_token)

                try:
                    # For optimization, we'll use a simplified approach
                    # In a full implementation, this would integrate with the provider's run_query method
                    return self._mock_response(prompt)
                except Exception as e:
                    print(f"Error in DSPy LM call: {e}")
                    return "SELECT * FROM error_table;"

            def _mock_response(self, prompt: str) -> str:
                """Mock response for optimization - replace with real provider calls."""
                if "sql" in prompt.lower():
                    return "SELECT COUNT(*) FROM test_table WHERE condition = true;"
                return "Analysis complete. The query should count records matching criteria."

        return OpenRouterLM(self.model_config, self.motherduck_token)

    def optimize_program(self, train_questions: List[Dict], dev_questions: List[Dict], num_iterations: int = 10) -> TextToSQLProgram:
        """Optimize a DSPy program using training data."""

        # Create initial program with semantic-aware prompts
        system_prompt = """You are a SQL expert for text-to-SQL tasks using DuckDB.

CRITICAL - SINGLE PASS: You only get ONE attempt. Think carefully.

COLUMN SELECTION:
- When asked "which X did Y", return BOTH the identifier AND contextual columns
- Include columns that identify entities mentioned in the question

AGGREGATION SEMANTICS:
- "On average how many X per Y" = AVG of grouped counts, not a simple ratio
- Use: SELECT AVG(cnt) FROM (SELECT COUNT(*) as cnt ... GROUP BY entity)

EVIDENCE INTERPRETATION:
- Evidence hints provide guidance but may not be exact SQL logic
- Cross-check hints against the question's semantic meaning

DUCKDB SYNTAX:
- Never use backticks. Use double quotes for column names with spaces
- Schema-qualify all tables: schema.table_name
- GROUP BY: All non-aggregated SELECT columns must appear in GROUP BY"""

        user_prompt_template = """QUESTION: {question}

HINTS (verify against question semantics): {evidence}

BEFORE WRITING SQL:
1. What columns should the result include? (Include contextual columns)
2. If asking for "average", is it per-entity or a simple ratio?
3. Do the hints match the question's actual meaning?

Generate DuckDB SQL:"""

        program = TextToSQLProgram(
            system_prompt=system_prompt,
            user_prompt_template=user_prompt_template
        )

        # Create training data
        train_data = self._create_dspy_examples(train_questions)
        dev_data = self._create_dspy_examples(dev_questions)

        # Use DSPy's teleprompter for optimization
        teleprompter = dspy.BootstrapFewShot(metric=self._validate_sql_metric, max_bootstraps=num_iterations)

        # Optimize the program
        optimized_program = teleprompter.compile(program, trainset=train_data)

        # Evaluate on dev set
        evaluator = dspy.evaluate.Evaluate(
            devset=dev_data,
            metric=self._validate_sql_metric,
            num_threads=1,
            display_progress=True
        )

        eval_results = evaluator(optimized_program)
        print(f"Evaluation score: {eval_results:.3f}")
        return optimized_program

    def _create_dspy_examples(self, questions: List[Dict]) -> List[dspy.Example]:
        """Convert questions to DSPy examples."""
        examples = []
        for q in questions[:50]:  # Limit for optimization
            example = dspy.Example(
                question=q["question"],
                evidence=q.get("evidence", ""),
                schema_info=get_schema_info(q["db_id"]),
                gold_sql=q["SQL"]
            ).with_inputs("question", "evidence", "schema_info")
            examples.append(example)
        return examples

    def _validate_sql_metric(self, example: dspy.Example, prediction: dspy.Prediction, trace=None) -> bool:
        """Metric for validating SQL predictions."""
        # Simple heuristic: check if prediction looks like SQL
        pred_sql = prediction.sql_query if hasattr(prediction, 'sql_query') else str(prediction)
        return "SELECT" in pred_sql.upper() or "INSERT" in pred_sql.upper() or "UPDATE" in pred_sql.upper()


def run_gepa_optimization(
    model_name: str,
    questions: List[Dict],
    motherduck_token: str,
    output_dir: str = "data/optimization_results",
    max_generations: int = 5,
    population_size: int = 6,
    eval_sample_size: int = 10
) -> PromptCandidate:
    """Run GEPA optimization on a model."""

    async def _run_async():
        model_config = MODELS[model_name]

        config = OptimizationConfig(
            model_config=model_config,
            max_generations=max_generations,
            population_size=population_size,
            eval_sample_size=eval_sample_size,
            output_dir=output_dir
        )

        optimizer = GEPAOptimizer(config, motherduck_token)
        best_candidate = await optimizer.optimize(questions)

        return best_candidate

    # Run the async optimization
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(_run_async())
        loop.close()
        return result
    except Exception as e:
        print(f"Error in optimization: {e}")
        # Return a dummy candidate
        return PromptCandidate(
            system_prompt="Error in optimization",
            user_prompt_template="Error in optimization",
            accuracy=0.0,
            fitness=0.0,
            cost=0.0
        )


def run_dspy_optimization(
    model_name: str,
    train_questions: List[Dict],
    dev_questions: List[Dict],
    motherduck_token: str,
    num_iterations: int = 5
) -> TextToSQLProgram:
    """Run DSPy optimization on a model."""

    model_config = MODELS[model_name]
    optimizer = DSPyOptimizer(model_config, motherduck_token)

    optimized_program = optimizer.optimize_program(train_questions, dev_questions, num_iterations)

    return optimized_program


if __name__ == "__main__":
    # Example usage
    print("BIRD-Bench Optimizer")
    print("Run with: uv run python -m eval.cli train --models gemini-3-flash")