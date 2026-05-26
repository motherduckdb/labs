# BIRD-Bench Optimization Module

This module contains optimization tools for improving text-to-SQL performance on the BIRD benchmark using GEPA (Generalized Evolutionary Prompting Algorithm) and DSPy.

## Features

- **GEPA Optimization**: Evolutionary algorithm that evolves prompts through generations
- **DSPy Integration**: Programmatic prompt optimization using DSPy framework
- **Multi-model Support**: Works with any OpenRouter-supported model
- **Comprehensive Evaluation**: Real SQL execution and result comparison
- **Result Tracking**: JSON outputs and generation-by-generation progress

## Usage

### Command Line

Run optimization on a specific model:

```bash
# Basic GEPA optimization
uv run python src/optimization/run.py gemini-flash-3 --generations 5 --population 6

# Customize parameters
uv run python src/optimization/run.py claude-opus-4.5 --generations 10 --population 8

# DSPy optimization (when implemented)
uv run python src/optimization/run.py gpt-5.2 --dspy --generations 3
```

### Programmatic Usage

```python
from optimization import run_gepa_optimization

# Run GEPA optimization
best_candidate = run_gepa_optimization(
    model_name="gemini-flash-3",
    questions=your_questions_list,
    motherduck_token="your_token",
    max_generations=5,
    population_size=6,
    eval_sample_size=10
)

print(f"Best accuracy: {best_candidate.accuracy:.1%}")
print(f"Optimized prompt: {best_candidate.system_prompt}")
```

## Files

- `optimizer.py` - Core optimization algorithms and classes
- `run.py` - Command-line interface for running optimizations
- `__init__.py` - Package exports

## Requirements

- OpenRouter API key (for model access)
- MotherDuck token (for database access)
- Python dependencies: DSPy, Optuna, pandas

## Output

Results are saved to `data/optimization_results/` with:
- `generation_*.json` - Results for each generation
- `final_results.json` - Complete optimization summary