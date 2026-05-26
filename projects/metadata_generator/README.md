# MotherDuck Metadata Generator

Generate rich metadata for MotherDuck databases including profile statistics, LLM-generated descriptions, and SQL COMMENT statements.

## Installation

```bash
cd metadata_generator
uv sync
```

## Environment Variables

```bash
# Required for all operations
export MOTHERDUCK_TOKEN="your_motherduck_token"

# Required for LLM descriptions (optional if using --skip-descriptions)
export OPENROUTER_API_KEY="your_openrouter_key"
```

Or create a `.env` file in the project root.

## Quick Start

```bash
# Simplest: generate facts-only comments (no LLM needed)
uv run metadata-generator comments formula_1 -x

# With query history patterns for richer metadata
uv run metadata-generator comments formula_1 --with-history -x

# Full pipeline with LLM descriptions (requires OPENROUTER_API_KEY)
uv run metadata-generator generate formula_1 -x
```

## Commands

Commands are listed in the order they should typically be run.

### 1. List Schemas

List all available schemas in a MotherDuck database:

```bash
uv run metadata-generator list
uv run metadata-generator -d my_database list
```

### 2. Profile a Schema

Extract column statistics using DuckDB's SUMMARIZE function:

```bash
uv run metadata-generator profile formula_1
uv run metadata-generator -v profile formula_1  # verbose
```

The profiler automatically detects VIEWs and marks them with `is_view: true` in the profile, ensuring correct `COMMENT ON VIEW` generation downstream.

Outputs:
- `output/profiles/{database}_{schema}_profile.json` - JSON with column statistics

### 3. Query History Analysis (Optional)

Analyze query history to discover patterns. Run this **before** using `--with-history` on other commands.

Requires MotherDuck Business plan with admin access.

```bash
# Analyze and view patterns
uv run metadata-generator history formula_1

# Store results in metadata schema (required for --with-history)
uv run metadata-generator history formula_1 -x

# Also translate query samples to natural language descriptions
uv run metadata-generator history formula_1 -x -t
```

Options:
```bash
uv run metadata-generator history formula_1 --user jmatson  # filter by user
uv run metadata-generator history formula_1 --days 90       # lookback period
uv run metadata-generator history formula_1 --limit 500     # max queries
uv run metadata-generator history formula_1 -t              # translate samples
uv run metadata-generator history formula_1 --model <model> # LLM for translation
```

The `-x` flag creates tables in a `metadata` schema containing:
- `join_patterns` - Discovered table relationships
- `field_usage` - Column importance scores based on query frequency
- `predicate_patterns` - Common filter conditions with example values
- `derived_metrics` - Frequently computed aggregations
- `query_samples` - Diverse sample queries (selected to maximize table coverage)
- `query_use_cases` - Natural language descriptions of samples (when using `-t`)

The `-t` flag translates query samples to natural language using an LLM (Gemini 3 Flash by default). This generates human-readable descriptions like "Find the top 10 countries by revenue" for each SQL query.

Outputs:
- `output/history/{database}_{schema}_history.json` - Discovered patterns with frequency counts
- `output/sql/{database}_{schema}_metadata.sql` - SQL to create metadata tables (when using `-x`)
- `output/translations/{database}_{schema}_translations.json` - Natural language translations (when using `-t`)

### 4. Generate LLM Descriptions

Generate natural language descriptions using an LLM (requires OPENROUTER_API_KEY):

```bash
# Basic description generation
uv run metadata-generator describe formula_1

# With a specific model
uv run metadata-generator describe formula_1 --model google/gemini-3-flash-preview

# Enriched with query history (requires: history -x first)
uv run metadata-generator describe formula_1 --with-history
```

The `--with-history` flag loads patterns from the metadata schema to improve descriptions:
- Predicate patterns inform semantic type classification
- Derived metrics document common calculations
- Query samples are translated to natural language use cases

Outputs:
- `output/descriptions/{database}_{schema}_descriptions.json` - JSON with descriptions
- `output/use_cases/{database}_{schema}_use_cases.json` - SQL-to-text translations (with `--with-history`)

### 5. Generate Facts-Only Comments (Recommended)

The `comments` command provides a simplified workflow for generating compact, factual metadata without LLM calls:

```bash
# Basic: profile stats only (no OPENROUTER_API_KEY needed)
uv run metadata-generator comments formula_1

# With query history: includes join patterns, usage, filters
uv run metadata-generator comments formula_1 --with-history

# Execute against MotherDuck
uv run metadata-generator comments formula_1 --with-history -x

# Refresh cached data
uv run metadata-generator comments formula_1 --with-history --refresh
```

Options:
- `--with-history` - Include query history patterns (joins, filters, usage)
- `-a, --annotations` - Path to YAML annotations file with domain knowledge
- `-x, --execute` - Execute SQL on MotherDuck
- `--refresh` - Re-profile and re-analyze instead of using cached
- `--days N` - Days of history to analyze (default: 30)
- `--limit N` - Max queries to analyze (default: 1000)

VIEWs are automatically detected and generate `COMMENT ON VIEW` instead of `COMMENT ON TABLE`.

The facts-only format uses compact notation optimized for text-to-SQL:

```sql
COMMENT ON TABLE formula_1.circuits IS '72 rows; pk:circuitId; joins:races,results';
COMMENT ON COLUMN formula_1.circuits.circuitId IS 'role:pk;fk(1:N)->races.circuitId';
COMMENT ON COLUMN formula_1.circuits.country IS 'role:dimension;filter:[=];used:[where,groupby]';
COMMENT ON COLUMN formula_1.circuits.lat IS 'role:fact;range:[-34.9,57.3]';
```

Fact notation includes:
- `role:pk|fk|fact|dimension|timestamp` - Semantic role
- `fk(1:N)->table.col` - Join target with cardinality
- `[val1,val2,...]` - Categorical values
- `agg:[SUM,AVG]` - Common aggregations from history
- `filter:[=,IN,>]` - Predicate operators from history
- `used:[where,groupby,orderby]` - Query usage patterns
- `null:N%` - Null rate (when >= 5%)
- `range:[min,max]` - Value range
- `granularity:day|hour` - Date/time granularity
- `pattern:email|url|uuid` - Detected patterns

### 6. Custom Domain Annotations

Add domain-expert knowledge to auto-generated comments using a YAML annotations file. Annotations are merged with facts at SQL generation time — no LLM calls needed.

#### YAML Format

Create an `annotations.yaml` file:

```yaml
tables:
  orders:
    annotation: "Core transactional table. One row per order."
    columns:
      status: "NULL = matches all regions"
      rate: "Basis points. rate=75 means 0.75%"
  customers:
    columns:
      tier: "Gold/Silver/Bronze. Determines discount level."
```

Tables can also use a shorthand string for table-level annotations only:

```yaml
tables:
  orders: "Core transactional table"
```

#### Usage

```bash
# Merge annotations with facts-only comments
uv run metadata-generator comments formula_1 --annotations annotations.yaml -x

# Merge annotations with full LLM pipeline
uv run metadata-generator generate formula_1 --annotations annotations.yaml -x

# Validate annotations against the schema (check for typos, etc.)
uv run metadata-generator validate-annotations formula_1 --annotations annotations.yaml
```

#### How Merging Works

Annotations are appended to the auto-generated comment with a `. ` separator:

```sql
-- Without annotation:
COMMENT ON COLUMN orders.rate IS 'role:fact;range:[0,500]';

-- With annotation "Basis points. rate=75 means 0.75%":
COMMENT ON COLUMN orders.rate IS 'role:fact;range:[0,500]. Basis points. rate=75 means 0.75%';
```

If a column has no auto-generated facts (e.g., a BLOB column), the annotation is used as-is.

#### Validation

The `validate-annotations` command checks for:
- **Unknown tables/columns** — catches typos in table or column names
- **Empty annotations** — whitespace-only text
- **Excessive length** — annotations longer than 200 characters
- **Restated names** — annotations that just repeat the column name without adding info

```bash
uv run metadata-generator validate-annotations formula_1 --annotations annotations.yaml
```

Exits with non-zero status if any warnings are found, making it suitable for CI checks.

### 7. Generate SQL Comments (Legacy - use `comments` instead)

Generate SQL COMMENT ON statements with more options:

```bash
# Basic (profile stats only)
uv run metadata-generator sql formula_1

# Include LLM descriptions
uv run metadata-generator sql formula_1 --with-descriptions

# Facts-only mode (same as `comments` command)
uv run metadata-generator sql formula_1 --facts-only

# Execute the SQL against MotherDuck
uv run metadata-generator sql formula_1 -x
```

Outputs:
- `output/sql/{database}_{schema}_comments.sql` - SQL file with COMMENT statements

### 8. Full Pipeline (with LLM descriptions)

Run the complete workflow (profile -> describe -> SQL) in one command:

```bash
# Basic pipeline with LLM descriptions
uv run metadata-generator generate formula_1

# Execute SQL after generation
uv run metadata-generator generate formula_1 -x

# Skip LLM descriptions (stats only)
uv run metadata-generator generate formula_1 --skip-descriptions

# Facts-only mode (no LLM needed, same as `comments` command)
uv run metadata-generator generate formula_1 --facts-only -x

# Enriched with query history (requires: history -x first)
uv run metadata-generator generate formula_1 --with-history -x

# With domain annotations
uv run metadata-generator generate formula_1 --annotations annotations.yaml -x
```

### Wildcard Schema Support

Use `'*'` as the schema argument to process all schemas in a database:

```bash
uv run metadata-generator comments '*' -x
uv run metadata-generator generate '*' -x
```

Schemas are processed in sequence with batch progress reporting and a final summary.

## Global Options

```
--database, -d    MotherDuck database name (default: bird_bench)
--output-dir, -o  Output directory (default: output)
--verbose, -v     Verbose output
```

## Output Structure

All output files use the naming convention `{database}_{schema}_{type}.{ext}` to avoid collisions when working with multiple databases.

```
output/
├── profiles/
│   └── {database}_{schema}_profile.json      # Column statistics
├── history/
│   └── {database}_{schema}_history.json      # Discovered patterns
├── translations/
│   └── {database}_{schema}_translations.json # Query translations (history -t)
├── descriptions/
│   └── {database}_{schema}_descriptions.json # LLM descriptions
├── use_cases/
│   └── {database}_{schema}_use_cases.json    # SQL-to-text for describe
└── sql/
    ├── {database}_{schema}_metadata.sql      # Metadata schema tables (history -x)
    └── {database}_{schema}_comments.sql      # SQL COMMENT statements
```

## Example Workflows

### Quick Start (Facts-Only, No LLM)

```bash
# Simplest workflow - just profile stats
uv run metadata-generator comments california_schools -x

# With query history for richer metadata
uv run metadata-generator comments california_schools --with-history -x
```

### Facts-Only with Domain Annotations

```bash
# 1. Create annotations.yaml with domain knowledge
# 2. Validate for typos
uv run metadata-generator validate-annotations california_schools --annotations annotations.yaml

# 3. Generate and apply
uv run metadata-generator comments california_schools --annotations annotations.yaml -x
```

### Enhanced Workflow with Query History

```bash
# 1. Analyze query history (run once, results are cached)
uv run metadata-generator -d eastlake history main

# 2. Generate facts-only comments with history
uv run metadata-generator -d eastlake comments main --with-history -x
```

### Full Workflow with LLM Descriptions

```bash
# 1. Analyze query history, store patterns, and translate to natural language
uv run metadata-generator -d eastlake history main -x -t

# 2. Generate metadata enriched with query patterns
uv run metadata-generator -d eastlake generate main --with-history -x

# 3. Review the generated translations
cat output/translations/main_translations.json
```

### Step-by-Step Workflow

```bash
# 1. List available schemas
uv run metadata-generator list

# 2. Profile the schema
uv run metadata-generator -v profile california_schools

# 3. (Optional) Analyze query history
uv run metadata-generator history california_schools

# 4. Generate facts-only comments (recommended)
uv run metadata-generator comments california_schools --with-history -x

# OR: Generate LLM descriptions (requires OPENROUTER_API_KEY)
uv run metadata-generator describe california_schools --with-history
uv run metadata-generator sql california_schools --with-descriptions -x
```

## Programmatic Usage

```python
from pathlib import Path
from metadata_generator import (
    DatabaseProfiler,
    MetadataGenerator,
    generate_sql_comments,
    QueryHistoryAnalyzer,
)
from metadata_generator.annotations import load_annotations, validate_annotations
from metadata_generator.progress import print_progress

# Profile a schema
with DatabaseProfiler(database="bird_bench") as profiler:
    profile = profiler.profile_schema("formula_1", on_progress=print_progress)
    profiler.save_profile(profile)

# Load domain annotations (optional)
annotations = load_annotations(Path("annotations.yaml"))
warnings = validate_annotations(annotations, profile)
for w in warnings:
    print(f"WARNING: {w}")

# Generate facts-only SQL with annotations
sql = generate_sql_comments(profile, facts_only=True, annotations=annotations)
print(sql)

# Or: full pipeline with LLM descriptions + annotations
generator = MetadataGenerator()
descriptions = generator.generate_descriptions(profile, on_progress=print_progress)
sql = generate_sql_comments(profile, descriptions, annotations=annotations)
print(sql)
```

## Testing

Run the test suite:

```bash
uv run pytest                    # Run all tests
uv run pytest -v                 # Verbose output
uv run pytest tests/test_sql.py  # Run specific test file
```

The test suite includes 274 tests covering:
- SQL parsing and extraction (joins, fields, predicates, metrics)
- Facts extraction (semantic role detection, date granularity, contiguous range heuristics)
- Model serialization/deserialization (including VIEW roundtrip)
- SQL comment generation (identifier quoting, VIEW support, string escaping)
- Annotation loading, validation, and merge
- SQL-to-text translation and formatting
- Configuration and persistence utilities

Tests use dependency injection for isolation - no environment variables or file I/O required.

## Architecture

The codebase follows clean code principles with:

- **Dependency injection**: `AppConfig` and `FileSystem` abstractions enable testing without mocking
- **Progress callbacks**: Functions accept `on_progress` callbacks to separate computation from output
- **Shared utilities**: Common patterns extracted to `config.py`, `persistence.py`, `connection.py`
- **Pure functions**: SQL parsing and formatting functions are side-effect free and easily testable
- **SQL safety**: Identifiers are quoted via `quote_identifier()` to handle special characters and reserved words; string values are escaped via `escape_sql_string()`
- **General-purpose heuristics**: All classification logic is domain-agnostic — no hardcoded column names or domain vocabulary

## Requirements

- Python 3.11+
- MotherDuck account with API token
- OpenRouter API key (for LLM descriptions)
- MotherDuck Business plan (for query history analysis)
