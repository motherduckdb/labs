#!/usr/bin/env python3
"""
Standalone optimization script for BIRD-Bench models.

Usage:
    python src/optimization/run.py gemini-flash-3 --generations 5 --population 6
    uv run python src/optimization/run.py gemini-flash-3 --generations 5 --population 6
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from src.optimization.optimizer import run_gepa_optimization

def main():
    """Run optimization from command line."""
    load_dotenv()

    if len(sys.argv) < 2:
        print("Usage: python src/optimize.py <model_name> [--generations N] [--population N]")
        print("Available models: gemini-flash-3, gemini-3-pro, claude-opus-4.5, gpt-5.2")
        sys.exit(1)

    model_name = sys.argv[1]

    # Parse arguments
    generations = 5
    population = 6

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--generations" and i + 1 < len(sys.argv):
            generations = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == "--population" and i + 1 < len(sys.argv):
            population = int(sys.argv[i + 1])
            i += 2
        else:
            print(f"Unknown argument: {sys.argv[i]}")
            sys.exit(1)

    # Get MotherDuck token
    motherduck_token = os.environ.get("MOTHERDUCK_TOKEN")
    if not motherduck_token:
        print("MOTHERDUCK_TOKEN not set in environment")
        sys.exit(1)

    # Load questions
    questions_file = "data/bird_sample_10.json"
    if Path(questions_file).exists():
        with open(questions_file) as f:
            questions = json.load(f)
        print(f"Using sample questions: {questions_file}")
    else:
        print(f"Questions file not found: {questions_file}")
        sys.exit(1)

    print(f"Running GEPA optimization on {model_name}")
    print(f"Generations: {generations}, Population: {population}")
    print(f"Questions: {len(questions)}")

    # Run optimization
    best_candidate = run_gepa_optimization(
        model_name=model_name,
        questions=questions,
        motherduck_token=motherduck_token,
        max_generations=generations,
        population_size=population,
        eval_sample_size=min(5, len(questions))  # Small sample for testing
    )

    print("\n" + "="*60)
    print("OPTIMIZATION COMPLETE")
    print("="*60)
    print(f"Best Candidate: {best_candidate.id}")
    print(f"Fitness: {best_candidate.fitness:.3f}")
    print(f"Accuracy: {best_candidate.accuracy:.1%}")
    print(f"Cost: ${best_candidate.cost:.4f}")
    print("\nSystem Prompt:")
    print(best_candidate.system_prompt)
    print("\nUser Template:")
    print(best_candidate.user_prompt_template)
    print("\nParameters:")
    print(f"  Temperature: {best_candidate.generation_params.get('temperature', 'N/A')}")
    print(f"  Max Tokens: {best_candidate.generation_params.get('max_tokens', 'N/A')}")

if __name__ == "__main__":
    main()