"""Guarded execute: every pipeline write goes through here so the op profile holds at runtime too.

The profile is pipelines/<p>/ops.yaml (learned from query_history by scripts/learn_ops.py, reviewed in
git). A fix that needs a new destructive op has to add it to ops.yaml in the same PR, and the L2
diff guard blocks exactly that, turning the fix into an L3 proposal.
"""
import functools
import os
import pathlib

import yaml

from . import sqlguard
from .db import data_db

ROOT = pathlib.Path(__file__).resolve().parent.parent


@functools.lru_cache(maxsize=None)
def profile(pipeline: str) -> set[tuple[str, str]]:
    path = ROOT / "pipelines" / pipeline / "ops.yaml"
    if not path.exists():
        return set()
    doc = yaml.safe_load(path.read_text()) or {}
    return {(op["kind"], op["table"].lower()) for op in doc.get("ops", [])}


def execute(con, sql: str, params=None, *, pipeline: str | None = None):
    pipeline = pipeline or os.environ.get("HEAL_PIPELINE")
    if os.environ.get("HEAL_GUARD", "enforce") != "off" and pipeline:
        bad = [v for v in sqlguard.check(sql, profile(pipeline), protected=("heal_chaos", "heal.main", "heal.eval"))
               if not v.allowed]
        if bad:
            raise sqlguard.GuardViolation("; ".join(map(str, bad)))
    return con.execute(sql, params) if params is not None else con.execute(sql)


def table(name: str) -> str:
    """Fully qualified name in the current data DB (prod or sandbox clone)."""
    return f"{data_db()}.{name}"
