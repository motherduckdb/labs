"""Rich evaluation review — full feature parity with agentic-sql's dabstep_review.html.

When a run contains ``evaluation_result`` events, their payloads carry the complete
per-question detail (question, predicted/gold SQL, results, correctness, cost/tokens, and
``raw_response.messages`` — the full agent conversation). This package rebuilds the
reference review from those events.

Split by concern: :mod:`model` (data + extraction + text helpers), :mod:`trace`
(conversation-trace parsing/rendering), :mod:`assets` (inline CSS/JS), :mod:`page`
(HTML assembly).
"""
from controllog_viz.eval_review.model import has_eval_results
from controllog_viz.eval_review.page import generate_eval_review

__all__ = ["has_eval_results", "generate_eval_review"]
