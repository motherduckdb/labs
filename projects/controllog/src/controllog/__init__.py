"""controllog — controllable logging for AI/agentic systems.

Events + balanced postings, JSONL transport, optional MotherDuck upload.
See docs/spec-v1.1.md for the full design.
"""

from .sdk import event, init, is_initialized, new_id, post
from .builders import (
    model_completion,
    model_prompt,
    run_metadata,
    state_move,
    tool_call,
    tool_result,
    utility,
)

__all__ = [
    "init",
    "is_initialized",
    "event",
    "post",
    "new_id",
    "model_prompt",
    "model_completion",
    "run_metadata",
    "tool_call",
    "tool_result",
    "state_move",
    "utility",
]
