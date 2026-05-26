# Evaluation Design: Comments + Query History Impact Study

## Objective

Measure the impact of database comments and query history on text-to-SQL accuracy across frontier models.

## Experimental Design

### Dataset
- **Source**: `birdsql/bird_mini_dev` (SQLite split)
- **Total**: 500 questions across 11 databases
- **Split**: 150 train / 350 test (stratified by database)

### Models
- Gemini 3 Flash
- Claude Opus 4.5
- GPT-5.2

### Database Configurations

| Config | Database Name | Comments | Query History |
|--------|--------------|----------|---------------|
| A | `bird_bench_a` | No | No |
| B | `bird_bench_b` | Yes (profile only) | No |
| C | `bird_bench_c` | Yes (profile + history) | Yes |

### Execution Phases

```
PHASE 0: Setup
├── Stratified split: 150 train / 350 test (by database, fixed seed)
├── Create 3 database copies in MotherDuck
├── Config A: No comments
├── Config B: Profile-based comments (no history)
└── Config C: Same as B initially

PHASE 1: Train Evaluation (150 questions × 3 models × 3 configs)
├── Run all models on all configs
├── Capture query history from Config C runs (all models combined)
├── After completion:
│   ├── metadata_generator history <schema>
│   ├── metadata_generator describe <schema>
│   └── Apply enriched comments to Config C
└── FREEZE: No more comment updates to Config C

PHASE 2: Test Evaluation (350 questions × 3 models × 3 configs)
├── Run all models on all configs
├── Config C now has enriched comments from train history
└── Record final metrics
```

### Scoring Rules

| Scenario | Score | Category |
|----------|-------|----------|
| Exact match (gold) | 1 | CORRECT_GOLD |
| Exact match (platinum) | 1 | CORRECT_PLATINUM |
| LLM judge approved | 1 | CORRECT_JUDGE |
| Extra columns, correct data | 1 | PARTIAL_ACCEPTED |
| Extra duplicates (unique values match) | 1 | PARTIAL_ACCEPTED |
| Implicit DISTINCT (unique values match) | 1 | PARTIAL_ACCEPTED |
| Missing columns | 0 | PARTIAL_UNACCEPTED |
| Missing rows | 0 | PARTIAL_UNACCEPTED |
| Subset match | 0 | PARTIAL_UNACCEPTED |
| Wrong data | 0 | INCORRECT |
| Execution error | 0 | ERROR |
| Hit tool call limit | 0 | HIT_LIMIT |

**Note:** LLM judge is optional (`--judge` flag) and only invoked when gold/platinum/accepted-partial all fail.

### Results Matrix

| Model | Config | Train Acc (150) | Test Acc (350) |
|-------|--------|-----------------|----------------|
| Gemini 3 Flash | A (baseline) | | |
| Gemini 3 Flash | B (comments) | | |
| Gemini 3 Flash | C (full) | | |
| Opus 4.5 | A (baseline) | | |
| Opus 4.5 | B (comments) | | |
| Opus 4.5 | C (full) | | |
| GPT-5.2 | A (baseline) | | |
| GPT-5.2 | B (comments) | | |
| GPT-5.2 | C (full) | | |

**Total**: 18 evaluation runs, 9,000 question evaluations

---

## Implementation Plan

### Codebase Structure

```
bird-bench/
├── src/                          # Core test harness (existing)
│   ├── comparison.py             # Result comparison logic
│   ├── schema_helper.py          # Schema retrieval & caching
│   ├── sql_executor.py           # SQL execution via MCP
│   ├── mcp_client.py             # MotherDuck HTTP client
│   ├── providers/                # Model providers
│   └── constants.py              # Shared constants
│
├── eval/                         # Eval orchestration (NEW)
│   ├── __init__.py
│   ├── config.py                 # Eval configs
│   ├── sampler.py                # Stratified splitting
│   ├── runner.py                 # Phase orchestration
│   ├── database_setup.py         # Database config management
│   ├── history_integration.py    # metadata_generator integration
│   ├── scoring.py                # Accuracy with partial rules
│   ├── results.py                # Aggregation/reporting
│   └── cli.py                    # Entry point
```

### Implementation Tasks

#### Task 1: Create eval/ package structure
- [x] Create `eval/__init__.py`
- [x] Create `eval/config.py` with database names, seeds, model list

#### Task 2: Implement stratified sampler
- [x] Create `eval/sampler.py`
- [x] Load questions from HuggingFace dataset
- [x] Implement stratified split by database (proportional)
- [x] Support fixed seed for reproducibility
- [x] Output: train.json, test.json

#### Task 3: Implement database setup
- [x] Create `eval/database_setup.py`
- [x] Clone BIRD databases to 3 MotherDuck databases
- [x] Config A: Strip all comments
- [x] Config B: Apply profile-based comments
- [x] Config C: Same as B initially

#### Task 4: Update scoring logic
- [x] Create `eval/scoring.py`
- [x] Implement new partial correctness rules:
  - Extra columns + correct data = 1
  - Missing columns/rows = 0
- [x] Unit tests for scoring edge cases

#### Task 5: Implement phase runner
- [x] Create `eval/runner.py`
- [x] Run train phase on all configs/models
- [x] Trigger history integration after train
- [x] Run test phase on all configs/models
- [x] Handle concurrency limits

#### Task 6: History integration
- [x] Create `eval/hydrator.py` (replaces history_integration.py)
- [x] Execute gold SQL to populate query history
- [x] Apply updated comments to Config C via metadata_generator
- [x] Verify comments applied correctly

#### Task 7: Results aggregation
- [x] Create `eval/results.py`
- [x] Aggregate accuracy by model/config/phase
- [x] Generate comparison tables
- [x] Export to JSON/CSV

#### Task 8: CLI entry point
- [x] Create `eval/cli.py`
- [x] Commands: `setup`, `sample`, `train`, `test`, `full`, `report`, `hydrate`, `verify`
- [x] Script entry point: `uv run bird-eval <command>`
- [x] Additional commands: `upload`, `cleanup`, `inspect`, `errors`

#### Task 9: Testing and validation
- [x] Run small-scale test (10 questions × 1 model × 3 configs)
- [x] Verify scoring logic
- [x] Verify history integration
- [x] Full run

---

## Key Design Decisions

1. **Combined query history**: All 3 models' train queries contribute to Config C's history
2. **History freeze**: After train phase completes for all models, before test
3. **Stratification**: Proportional by database count
4. **Seeds**: Same within train set, same within test set, across all models

## Dependencies

- `metadata_generator` package (for history analysis and comment generation)
- MotherDuck account with query history access (Business plan)
- OpenRouter API access for all 3 models

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Query history not capturing all queries | Verify MotherDuck QUERY_HISTORY table after train |
| metadata_generator failure | Manual fallback, checkpoint after each step |
| Rate limits on models | Concurrency limits, retry logic |
| Cost overrun | Monitor with controllog, set budget alerts |

## Estimated Cost

- ~9,000 question evaluations
- Average tokens per question: ~2,000 input, ~500 output
- Rough estimate: $50-150 depending on model mix
