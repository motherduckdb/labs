# Metadata Generator - Claude Instructions

This is a CLI tool for generating metadata for MotherDuck databases.

## Project Structure

```
metadata_generator/
├── pyproject.toml                    # Project config (uv/hatch)
├── src/metadata_generator/
│   ├── __init__.py                   # Package exports
│   ├── annotations.py               # YAML domain annotations (load, validate, merge)
│   ├── cli.py                        # CLI entry point
│   ├── config.py                     # Configuration constants and AppConfig
│   ├── connection.py                 # MotherDuck connection management
│   ├── facts.py                      # Facts-only metadata extraction
│   ├── generator.py                  # LLM description generation
│   ├── history.py                    # Query history analysis
│   ├── llm_client.py                 # Shared OpenRouter client
│   ├── models.py                     # Data classes (profiles, descriptions)
│   ├── persistence.py                # JSON save/load with FileSystem abstraction
│   ├── profiler.py                   # Database profiling via SUMMARIZE
│   ├── progress.py                   # Progress callback system
│   ├── sql.py                        # SQL COMMENT generation
│   └── translator.py                 # SQL-to-text translation
├── tests/                            # Unit tests (214 tests)
│   ├── test_annotations.py           # Annotation load, validate, merge tests
│   ├── test_config.py                # AppConfig and provider tests
│   ├── test_facts.py                 # Facts extraction tests
│   ├── test_history.py               # SQL parsing tests
│   ├── test_models.py                # Model serialization tests
│   ├── test_persistence.py           # FileSystem tests
│   ├── test_sql.py                   # SQL generation tests
│   └── test_translator.py            # SQL normalization tests
└── output/                           # Generated files (gitignored)
```

## Running Commands

Always use `uv run` to execute the CLI:

```bash
uv run metadata-generator [global-options] <command> [command-options]
```

**Important**: Global options must come BEFORE the command name.

## Available Commands

| Command | Purpose |
|---------|---------|
| `list` | List all schemas in the database |
| `profile <schema>` | Extract column statistics using DuckDB SUMMARIZE |
| `comments <schema>` | **Recommended**: Generate facts-only SQL comments (no LLM needed) |
| `describe <schema>` | Generate LLM descriptions (needs OPENROUTER_API_KEY) |
| `sql <schema>` | Generate SQL COMMENT statements |
| `generate <schema>` | Full pipeline: profile -> describe -> SQL |
| `history <schema>` | Analyze query history for patterns |
| `validate-annotations <schema>` | Validate a YAML annotations file against a schema |

## Global Flags (before command)

These flags must appear BEFORE the command name:

- `-d, --database`: Target database (default: `bird_bench`)
- `-o, --output-dir`: Output directory (default: `output`)
- `-v, --verbose`: Show detailed progress

## Command-Specific Flags (after command)

- `-x, --execute`: Execute generated SQL (for `sql` and `generate` commands)
- `-a, --annotations`: Path to YAML annotations file (for `comments` and `generate` commands)

## Environment Variables

- `MOTHERDUCK_TOKEN`: Required for all database operations
- `OPENROUTER_API_KEY`: Required for LLM descriptions

## Key Classes

### DatabaseProfiler
Profiles schemas using DuckDB's SUMMARIZE function. Extracts:
- Column types, min/max values, distinct counts
- Null percentages, statistical metrics (avg, std, quartiles)
- Sample values for categorical columns

### MetadataGenerator
Generates natural language descriptions via OpenRouter API:
- Table-level descriptions
- Column semantic types (identifier, categorical, measure, etc.)
- Column descriptions explaining purpose

### QueryHistoryAnalyzer
Analyzes MD_INFORMATION_SCHEMA.QUERY_HISTORY to discover:
- Join patterns used in practice
- Field usage frequency and importance scoring
- Predicate patterns (common filter conditions)
- Derived metrics (aggregations and calculations)
- Requires MotherDuck Business plan with admin access

## Output Formats

All output files follow the naming convention `{database}_{schema}_{type}.{ext}` to avoid collisions when working with multiple databases.

### Profile JSON (`output/profiles/{database}_{schema}_profile.json`)
```json
{
  "db_id": "formula_1",
  "database": "bird_bench",
  "tables": [{
    "name": "races",
    "row_count": 1000,
    "columns": [{
      "name": "raceId",
      "dtype": "BIGINT",
      "approx_unique": 1000,
      "null_percentage": 0.0,
      "is_categorical": false
    }]
  }]
}
```

### Descriptions JSON (`output/descriptions/{database}_{schema}_descriptions.json`)
```json
{
  "db_id": "formula_1",
  "database": "bird_bench",
  "tables": [{
    "table_name": "races",
    "description": "Formula 1 race events...",
    "columns": [...]
  }]
}
```

### SQL Comments (`output/sql/{database}_{schema}_comments.sql`)
```sql
COMMENT ON TABLE formula_1.races IS 'Race events (1,000 rows)';
COMMENT ON COLUMN formula_1.races.raceId IS '[identifier] Unique race ID (BIGINT, 1,000 distinct)';
```

### History JSON (`output/history/{database}_{schema}_history.json`)
```json
{
  "schema": "formula_1",
  "database": "bird_bench",
  "queries_analyzed": 523,
  "joins": [{
    "left_table": "races",
    "left_column": "raceId",
    "right_table": "results",
    "right_column": "raceId",
    "count": 127
  }],
  "field_usage": [{
    "table": "races",
    "column": "raceId",
    "select_count": 45,
    "where_count": 30,
    "join_count": 127,
    "importance_score": 456.0
  }],
  "predicates": [{
    "table": "races",
    "column": "year",
    "operator": "=",
    "value_pattern": "<number>",
    "occurrence_count": 89
  }],
  "derived_metrics": [{
    "expression": "COUNT(*)",
    "alias_names": ["race_count"],
    "occurrence_count": 34
  }]
}
```

### Translations JSON (`output/translations/{database}_{schema}_translations.json`)
### Use Cases JSON (`output/use_cases/{database}_{schema}_use_cases.json`)
### Metadata SQL (`output/sql/{database}_{schema}_metadata.sql`)

## Typical Workflows

### Generate facts-only comments (recommended, no LLM needed)
```bash
uv run metadata-generator comments formula_1 -x
```

### Generate facts-only comments with query history
```bash
uv run metadata-generator comments formula_1 --with-history -x
```

### Generate facts-only comments with domain annotations
```bash
uv run metadata-generator comments formula_1 --annotations annotations.yaml -x
```

### Validate annotations file against schema
```bash
uv run metadata-generator validate-annotations formula_1 --annotations annotations.yaml
```

### Generate full metadata with LLM descriptions
```bash
uv run metadata-generator generate formula_1 -x
```

### Profile with verbose output
```bash
uv run metadata-generator -v profile formula_1
```

### Discover patterns from query history
```bash
uv run metadata-generator -v history formula_1 --days 90
```

## Design Principles

### No domain-specific heuristics
All classification logic must be **general-purpose**. Never hardcode column names, table names, or patterns from a specific domain (sports stats, e-commerce, healthcare, etc.). Use structural/statistical heuristics instead (e.g., contiguous integer range starting at 0, cardinality ratios, data type + naming conventions like `_id` suffix). If a heuristic can't be expressed without referencing domain-specific vocabulary, it's the wrong heuristic.

## Error Handling

- Missing MOTHERDUCK_TOKEN: Raises ValueError with clear message
- Missing OPENROUTER_API_KEY: Raises ValueError (skip with `--skip-descriptions`)
- Query history permission denied: Returns error message explaining Business plan requirement
- Table profiling failures: Logged as warnings, continues with other tables

## Testing

Run the test suite:

```bash
uv run pytest           # Run all 214 tests
uv run pytest -v        # Verbose output
uv run pytest --tb=short  # Short tracebacks on failure
```

Tests are organized by module and use dependency injection for isolation.

## Architecture Notes

### Dependency Injection
- `AppConfig`: Centralized configuration loaded from environment or injected for tests
- `ConfigProvider`: Protocol for configuration access (EnvConfigProvider for production)
- `FileSystem`: Protocol for file I/O (RealFileSystem for production, InMemoryFileSystem for tests)

### Progress Callbacks
Functions that report progress accept an optional `on_progress: ProgressCallback` parameter:
```python
def profile_schema(self, schema: str, on_progress: ProgressCallback | None = None)
```
This separates computation from output, enabling silent operation in tests.

### Shared Utilities
- `config.py`: All magic numbers and configuration constants
- `connection.py`: MotherDuckConnection class with context manager
- `persistence.py`: save_json/load_json with FileSystem abstraction
- `progress.py`: ProgressCallback protocol and ProgressReporter class
- `llm_client.py`: Shared OpenRouter client creation
