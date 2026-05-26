"""
Configuration constants for metadata generator.

This module consolidates magic numbers and configurable values
that were previously scattered across the codebase.

Also provides dependency injection infrastructure for testability.
"""

import os
from dataclasses import dataclass
from typing import Protocol


# ============================================================================
# Dependency Injection Infrastructure
# ============================================================================

class ConfigProvider(Protocol):
    """Protocol for configuration access."""

    def get(self, key: str, default: str | None = None) -> str | None:
        """Get a configuration value by key."""
        ...


class EnvConfigProvider:
    """Gets config from environment variables."""

    def get(self, key: str, default: str | None = None) -> str | None:
        """Get a configuration value from environment."""
        return os.environ.get(key, default)


@dataclass
class AppConfig:
    """Application configuration for external services.

    Use AppConfig.from_env() to load from environment variables.
    For testing, construct directly with test values.
    """

    motherduck_token: str
    openrouter_api_key: str | None = None
    google_api_key: str | None = None
    default_database: str = "bird_bench"

    @classmethod
    def from_env(
        cls,
        provider: ConfigProvider | None = None,
        require_openrouter: bool = False,
    ) -> "AppConfig":
        """Load config from environment.

        Args:
            provider: Configuration provider. Defaults to EnvConfigProvider.
            require_openrouter: If True, raise error when OpenRouter API key missing.

        Returns:
            AppConfig instance.

        Raises:
            ValueError: If required config is missing.
        """
        provider = provider or EnvConfigProvider()

        token = provider.get("MOTHERDUCK_TOKEN")
        if not token:
            raise ValueError("MOTHERDUCK_TOKEN not set")

        api_key = provider.get("OPENROUTER_API_KEY")
        if require_openrouter and not api_key:
            raise ValueError("OPENROUTER_API_KEY not set")

        return cls(
            motherduck_token=token,
            openrouter_api_key=api_key,
            google_api_key=provider.get("GOOGLE_API_KEY"),
        )

# ============================================================================
# Profiling Configuration
# ============================================================================

# Columns with <= this many distinct values are treated as categorical
# 20 is a common threshold in statistics/visualization tools
CATEGORICAL_THRESHOLD = 20

# Number of permutations for MinHash similarity detection
# 128 provides good accuracy/performance tradeoff
MINHASH_NUM_PERM = 128

# Only compute MinHash for columns with fewer distinct values
# Columns with very high cardinality are unlikely to be join keys
MINHASH_MAX_CARDINALITY = 100_000

# Sample size for MinHash computation - balances accuracy vs speed
MINHASH_SAMPLE_SIZE = 10_000

# Minimum Jaccard similarity to report as potential relationship
SIMILARITY_THRESHOLD = 0.5

# Sample size for string pattern analysis
STRING_SHAPE_SAMPLE_SIZE = 10_000

# Number of sample values to fetch for categorical columns
CATEGORICAL_SAMPLE_LIMIT = 10

# Number of sample values to fetch for pattern detection
PATTERN_DETECTION_SAMPLE_SIZE = 20

# Minimum percentage of values that must match for pattern detection
PATTERN_MATCH_THRESHOLD = 0.8


# ============================================================================
# LLM Configuration
# ============================================================================

# OpenRouter API configuration
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_LLM_MODEL = "google/gemini-3-flash-preview"
HTTP_REFERER = "https://github.com/matsonj/metadata_generator"
APP_TITLE = "MotherDuck Metadata Generator"

# Parallelization settings for LLM calls
DEFAULT_MAX_WORKERS = 6  # Conservative default for rate limits
MAX_WORKERS_LIMIT = 12   # Upper bound to avoid overwhelming API


# ============================================================================
# Output Formatting Limits
# ============================================================================

# Max items to include in formatted prompt output
MAX_JOINS_IN_PROMPT = 15
MAX_FIELD_USAGE_IN_PROMPT = 20
MAX_PREDICATES_IN_PROMPT = 20
MAX_METRICS_IN_PROMPT = 15
MAX_QUERY_SAMPLES = 30

# Max characters per query sample (0 = unlimited)
MAX_QUERY_SAMPLE_LENGTH = 0


# ============================================================================
# Batch Processing
# ============================================================================

# Progress update frequency (every N queries)
PROGRESS_UPDATE_INTERVAL = 100

# Max example values to store per predicate pattern
MAX_PREDICATE_EXAMPLES = 5

# Max aliases to store per derived metric
MAX_METRIC_ALIASES = 3


# ============================================================================
# Query History Filtering Thresholds
# ============================================================================

# Minimum occurrence percentage of total queries to keep a pattern
# Patterns appearing in fewer than this percentage of queries are filtered out
# E.g., 0.5 means pattern must appear in at least 0.5% of analyzed queries
MIN_OCCURRENCE_PERCENT = 0.5

# Absolute minimum occurrences (used when percentage would be < this value)
# Ensures we don't filter everything when analyzing few queries
MIN_OCCURRENCE_ABSOLUTE = 2

# Minimum importance score for field usage (0 = no filtering)
# Fields with lower scores are filtered out as niche use cases
# Score = SELECT*1 + WHERE*2 + JOIN*3 + GROUP_BY*2 + ORDER_BY*1
MIN_FIELD_IMPORTANCE_SCORE = 50


# ============================================================================
# Facts-Only Metadata Configuration
# ============================================================================

# Max orphan examples to store per side of a join pair
ORPHAN_SAMPLE_LIMIT = 10

# Max distinct values to consider per side when computing orphans.
# Columns above this threshold are skipped — orphan detection matters
# most for smaller, sparse join keys, not high-cardinality columns.
ORPHAN_MAX_DISTINCT = 10_000

# Max orphan values to display in fact notation
FACT_ORPHAN_DISPLAY_VALUES = 3


# Approximate token budget per column fact string
# ~4 characters per token, so 30 tokens ≈ 120 characters
FACT_TOKEN_BUDGET = 30

# Max values to display in enum notation
FACT_ENUM_DISPLAY_VALUES = 5

# Null percentage threshold - only show null rate if >= this value
FACT_NULL_THRESHOLD = 5.0

# Max characters per annotation (warning threshold)
ANNOTATION_MAX_LENGTH = 200
