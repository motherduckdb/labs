# Automatic Metadata Extraction for Text-to-SQL

Implementation of [Automatic Metadata Extraction for Text-to-SQL](https://arxiv.org/abs/2505.19988) (arXiv:2505.19988).

## Quick Start

```bash
# Step 1: Analyze query history and store patterns
uv run metadata-generator -d mydb history myschema

# Step 2: Generate metadata with history context
uv run metadata-generator -d mydb generate myschema --with-history
```

That's it. Two commands to go from raw database to rich semantic metadata.

## Step 1: `history` — Extract Patterns from Query Logs

Analyzes `MD_INFORMATION_SCHEMA.QUERY_HISTORY` to discover how the schema is actually used.

### Artifacts Generated

**Database tables** (in `metadata` schema):

| Table | Contents |
|-------|----------|
| `join_patterns` | Table pairs joined together, join columns, occurrence count |
| `field_usage` | Per-column counts for SELECT/WHERE/JOIN/GROUP BY, importance score |
| `predicate_patterns` | Column, operator, value pattern (e.g., `year = <number>`), count |
| `derived_metrics` | Aggregation expressions (e.g., `SUM(quantity * price)`), aliases used |
| `query_samples` | Representative SQL queries selected for diversity and frequency |
| `query_use_cases` | Natural language translations of query samples (short + long form) |

**JSON files**:

- `output/history/{db}_{schema}_history.json` — All patterns in one file
- `output/translations/{db}_{schema}_translations.json` — SQL-to-text mappings

### Example: Join Patterns

```json
{
  "left_table": "orders",
  "left_column": "customer_id",
  "right_table": "customers",
  "right_column": "customer_id",
  "join_count": 847
}
```

### Example: Derived Metrics

```json
{
  "expression": "SUM(unit_price * quantity * (1 - discount))",
  "alias_names": ["revenue", "total_revenue", "sales"],
  "occurrence_count": 156
}
```

### Example: Query Use Cases

```json
{
  "sql": "SELECT c.country, SUM(od.quantity) FROM customers c JOIN orders o ON c.customer_id = o.customer_id JOIN order_details od ON o.order_id = od.order_id GROUP BY c.country",
  "short_question": "Total quantity sold by country",
  "long_question": "What is the total quantity of products sold, broken down by customer country?"
}
```

---

## Step 2: `generate --with-history` — Create Rich Descriptions

Runs three sub-steps: profile → describe → SQL comments.

### 2a. Profile

Uses DuckDB's `SUMMARIZE` to extract column statistics.

**Output**: `output/profiles/{db}_{schema}_profile.json`

```json
{
  "table_name": "orders",
  "row_count": 10000,
  "columns": [{
    "name": "order_date",
    "dtype": "DATE",
    "approx_unique": 480,
    "null_percentage": 0.0,
    "min": "2020-01-01",
    "max": "2024-12-31",
    "is_categorical": false
  }]
}
```

### 2b. Describe

LLM generates semantic descriptions using profile data + history patterns (when `--with-history` is set).

**Output**: `output/descriptions/{db}_{schema}_descriptions.json`

**Inputs used**:
- Profile statistics (column types, cardinality, sample values)
- Join patterns → identifies foreign keys and relationships
- Predicate patterns → informs semantic type (columns filtered with `=` are likely categorical)
- Derived metrics → documents common calculations in table descriptions
- Query use cases → adds example questions showing how tables are used

```json
{
  "table_name": "orders",
  "description": "Customer orders with shipping and payment details. Commonly joined with order_details for revenue calculations.",
  "columns": [{
    "column_name": "customer_id",
    "semantic_type": "foreign_key",
    "description": "Links to customers.customer_id"
  }, {
    "column_name": "order_date",
    "semantic_type": "date",
    "description": "Date order was placed, frequently filtered by year/month"
  }]
}
```

### 2c. SQL Comments

Combines profile stats + LLM descriptions into COMMENT statements.

**Output**: `output/sql/{db}_{schema}_comments.sql`

```sql
COMMENT ON TABLE orders IS 'Customer orders (10,000 rows). Commonly joined with order_details for revenue calculations.';
COMMENT ON COLUMN orders.customer_id IS '[foreign_key] Links to customers.customer_id (BIGINT, 500 distinct)';
COMMENT ON COLUMN orders.order_date IS '[date] Date order was placed, frequently filtered by year/month (DATE, 480 distinct)';
```

When applied to MotherDuck, these comments are visible to any tool that queries the database schema.

---

## How Artifacts Connect

```
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 1: history                                                        │
│                                                                         │
│  QUERY_HISTORY ──▶ metadata.join_patterns                               │
│                    metadata.field_usage                                 │
│                    metadata.predicate_patterns    ──▶ history.json      │
│                    metadata.derived_metrics                             │
│                    metadata.query_samples                               │
│                    metadata.query_use_cases       ──▶ translations.json │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ --with-history loads from metadata schema
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 2: generate                                                       │
│                                                                         │
│  2a. SUMMARIZE ──────────────────────────────────▶ profile.json         │
│                                                          │              │
│  2b. profile.json + metadata.* ──▶ LLM ──────────▶ descriptions.json    │
│                                                          │              │
│  2c. profile.json + descriptions.json ───────────▶ comments.sql         │
│                                                          │              │
│                                                          ▼              │
│                                              COMMENT ON TABLE/COLUMN    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Metadata Schema Tables

Stored in the database for team sharing and incremental updates:

```sql
metadata.join_patterns       -- (left_table, left_column, right_table, right_column, join_count)
metadata.field_usage         -- (table, column, select_count, where_count, join_count, group_by_count, importance_score)
metadata.predicate_patterns  -- (table, column, operator, value_pattern, occurrence_count)
metadata.derived_metrics     -- (expression, alias_names[], occurrence_count)
metadata.query_samples       -- (sql, frequency, tables[])
metadata.query_use_cases     -- (sql, short_question, long_question)
```

## Reference

Shkapenyuk, Srivastava, Johnson, Ghane. "Automatic Metadata Extraction for Text-to-SQL." arXiv:2505.19988, May 2025.
