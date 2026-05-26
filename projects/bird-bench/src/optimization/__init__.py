"""
BIRD-Bench Optimization Package

Contains GEPA and DSPy optimization tools for improving text-to-SQL prompts.
"""

from .optimizer import run_gepa_optimization, run_dspy_optimization

__all__ = ["run_gepa_optimization", "run_dspy_optimization"]