"""
Evaluation orchestration for BIRD-Bench.

This package handles the multi-phase evaluation comparing:
- Baseline (no comments) - bird_bench_a
- Comments only (profile-based) - bird_bench_b
- Full (comments + query history) - bird_bench_c
"""

from eval.config import (
    EvalConfig,
    DatabaseConfig,
    ConfigType,
    DATABASE_CONFIGS,
    MODELS,
    TRAIN_SEED,
    TEST_SEED,
    TRAIN_RATIO,
)
from eval.sampler import (
    DatasetSplit,
    create_split,
    load_split,
    stratified_split_by_database,
)
from eval.scoring import (
    ScoredResult,
    AccuracyStats,
    ScoreCategory,
    score_result,
    calculate_accuracy,
    calculate_accuracy_stats,
)

__all__ = [
    # Config
    "EvalConfig",
    "DatabaseConfig",
    "ConfigType",
    "DATABASE_CONFIGS",
    "MODELS",
    "TRAIN_SEED",
    "TEST_SEED",
    "TRAIN_RATIO",
    # Sampler
    "DatasetSplit",
    "create_split",
    "load_split",
    "stratified_split_by_database",
    # Scoring
    "ScoredResult",
    "AccuracyStats",
    "ScoreCategory",
    "score_result",
    "calculate_accuracy",
    "calculate_accuracy_stats",
]
