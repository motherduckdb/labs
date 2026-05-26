"""
Configuration for BIRD-Bench evaluation runs.

Defines database configurations, model list, and sampling parameters.
"""

from dataclasses import dataclass
from enum import Enum
from pathlib import Path

# Project paths (relative to eval package)
PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
EVAL_DATA_DIR = DATA_DIR / "eval"
RESULTS_DIR = DATA_DIR / "eval_results"
SQLITE_DB_DIR = PROJECT_ROOT / "mini_dev_data" / "MINIDEV" / "dev_databases"
DEV_TABLES_FILE = PROJECT_ROOT / "mini_dev_data" / "MINIDEV" / "dev_tables.json"

# Sampling configuration
TRAIN_SEED = 42
TEST_SEED = 42  # Same seed ensures consistent split across runs
TRAIN_RATIO = 0.3  # 150 out of 500 questions
TOTAL_QUESTIONS = 500

# Provider configuration
DEFAULT_PROVIDER = "openrouter"


class ConfigType(Enum):
    """Database configuration types for the evaluation."""
    BASELINE = "baseline"      # No comments
    COMMENTS = "comments"      # Profile-based comments only
    FULL = "full"              # Comments + query history


# Aliases for CLI config selection (supports both names and letters)
CONFIG_ALIASES: dict[str, ConfigType] = {
    "baseline": ConfigType.BASELINE,
    "comments": ConfigType.COMMENTS,
    "full": ConfigType.FULL,
    "a": ConfigType.BASELINE,
    "b": ConfigType.COMMENTS,
    "c": ConfigType.FULL,
}


@dataclass
class DatabaseConfig:
    """Configuration for a single database setup."""
    config_type: ConfigType
    database_name: str
    has_comments: bool
    has_query_history: bool

    @property
    def display_name(self) -> str:
        """Human-readable name for reports."""
        return {
            ConfigType.BASELINE: "Baseline (no comments)",
            ConfigType.COMMENTS: "Comments only",
            ConfigType.FULL: "Full (comments + history)",
        }[self.config_type]


# Database configurations
# Using new MotherDuck instance to avoid conflicts with existing bird_bench
DATABASE_CONFIGS = {
    ConfigType.BASELINE: DatabaseConfig(
        config_type=ConfigType.BASELINE,
        database_name="bird_bench_a",
        has_comments=False,
        has_query_history=False,
    ),
    ConfigType.COMMENTS: DatabaseConfig(
        config_type=ConfigType.COMMENTS,
        database_name="bird_bench_b",
        has_comments=True,
        has_query_history=False,
    ),
    ConfigType.FULL: DatabaseConfig(
        config_type=ConfigType.FULL,
        database_name="bird_bench_c",
        has_comments=True,
        has_query_history=True,
    ),
}


@dataclass
class ModelConfig:
    """Configuration for a model to evaluate."""
    name: str
    provider_id: str  # OpenRouter model ID


# Models to evaluate
MODELS = [
    ModelConfig(
        name="gemini-3-flash",
        provider_id="google/gemini-3-flash-preview",
    ),
    ModelConfig(
        name="opus-4.5",
        provider_id="anthropic/claude-opus-4.5",
    ),
    ModelConfig(
        name="gpt-5.2",
        provider_id="openai/gpt-5.2",
    ),
    ModelConfig(
        name="gpt-oss-20b",
        provider_id="openai/gpt-oss-safeguard-20b:nitro",
    ),
]


@dataclass
class EvalConfig:
    """Complete evaluation configuration."""
    train_seed: int = TRAIN_SEED
    test_seed: int = TEST_SEED
    train_ratio: float = TRAIN_RATIO
    total_questions: int = TOTAL_QUESTIONS
    max_concurrent: int = 5

    @property
    def train_size(self) -> int:
        return int(self.total_questions * self.train_ratio)

    @property
    def test_size(self) -> int:
        return self.total_questions - self.train_size

    def get_database_config(self, config_type: ConfigType) -> DatabaseConfig:
        return DATABASE_CONFIGS[config_type]

    def get_all_database_configs(self) -> list[DatabaseConfig]:
        return list(DATABASE_CONFIGS.values())
