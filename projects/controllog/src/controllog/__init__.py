"""controllog — controllable logging for AI/agentic systems.

Events + balanced postings, JSONL transport, optional MotherDuck upload.
See docs/spec-v1.1.md for the full design.
"""

from .sdk import event, init, is_initialized, new_id, post
from .builders import (
    agent_run,
    model_completion,
    model_prompt,
    model_response,
    state_move,
    utility,
)

__all__ = [
    "init",
    "is_initialized",
    "event",
    "post",
    "new_id",
    "agent_run",
    "model_prompt",
    "model_completion",
    "model_response",
    "state_move",
    "utility",
]

__version__ = "0.1.0"
