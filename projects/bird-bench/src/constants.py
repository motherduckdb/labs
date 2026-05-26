"""
Constants for BIRD-Bench evaluation.

Centralizes database names, file paths, and other configuration values
to reduce magic strings throughout the codebase.
"""

from pathlib import Path

# Database
MOTHERDUCK_DATABASE = "bird_bench"

# Project structure
PROJECT_ROOT = Path(__file__).parent.parent
SRC_DIR = PROJECT_ROOT / "src"
DATA_DIR = PROJECT_ROOT / "data"
PROMPTS_DIR = PROJECT_ROOT / "prompts"

# Mini-dev data (BIRD benchmark source data)
MINI_DEV_DIR = PROJECT_ROOT / "mini_dev_data" / "MINIDEV"
SQLITE_DB_DIR = MINI_DEV_DIR / "dev_databases"
DEV_TABLES_FILE = MINI_DEV_DIR / "dev_tables.json"
MINI_DEV_QUESTIONS_FILE = MINI_DEV_DIR / "mini_dev_sqlite.json"

# Dataset files
CURATED_DATASET_FILE = DATA_DIR / "bird_challenging_100_curated.json"
FULL_DATASET_FILE = DATA_DIR / "bird_challenging_100.json"
SAMPLE_DATASET_FILE = DATA_DIR / "bird_sample_10.json"
PLATINUM_ANSWERS_FILE = DATA_DIR / "platinum_answers.json"

# Generated/cached data
RESULTS_DIR = DATA_DIR / "results"
OPTIMIZATION_RESULTS_DIR = DATA_DIR / "optimization_results"

# Prompt templates
SYSTEM_PROMPT_FILE = PROMPTS_DIR / "system_prompt.md"
USER_PROMPT_FILE = PROMPTS_DIR / "user_prompt.md"

# Tool iteration limits
MAX_TOOL_ITERATIONS = 10

# Comparison tolerances
FLOAT_DISPLAY_PRECISION = 6       # Decimal places for display
FLOAT_RELATIVE_TOLERANCE = 0.0001 # 0.01% tolerance for numeric equality
CLOSE_VALUE_TOLERANCE = 0.05      # 5% tolerance for "close" values

# Token estimation
CHARS_PER_TOKEN_ESTIMATE = 4      # Rough estimate for token counting
