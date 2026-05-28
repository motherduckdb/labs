"""Feature-parity tests for the rich evaluation review (eval_review.py)."""
import json
from pathlib import Path

import pytest

from controllog_viz import eval_review, reader, render

FIXTURE_DIR = Path(__file__).parent / "fixtures_eval"


@pytest.fixture
def econ():
    c = reader.connect(str(FIXTURE_DIR))
    yield c
    c.close()


def test_has_eval_results_dispatch(econ):
    assert eval_review.has_eval_results(econ, "eval-run") is True
    # render_run_review should route to the rich review, not the universal one
    html = render.render_run_review(econ, "eval-run")
    assert "EVALUATION REVIEW" in html


def test_universal_fallback_when_no_eval_results():
    # The plain fixture has no evaluation_result events → universal review.
    c = reader.connect(str(Path(__file__).parent / "fixtures"))
    try:
        assert eval_review.has_eval_results(c, "run-a") is False
        html = render.render_run_review(c, "run-a")
        assert "RUN REVIEW" in html and "EVALUATION REVIEW" not in html
    finally:
        c.close()


def test_stats_bar_counts(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "3 total" in html
    assert "1 correct" in html
    assert "1 errors" in html
    assert "1 incorrect" in html


def test_filter_bar_present(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    for sel in ("status-filter", "model-filter", "config-filter", "category-filter"):
        assert f'id="{sel}"' in html
    assert "filter-count" in html
    # dynamic options populated from cards
    assert ">gpt-5<" in html          # model short name
    assert ">v3<" in html             # tier/config
    assert ">execution_error<" in html  # error category


def test_buttons_and_js(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "Expand All" in html and "Collapse All" in html and "Export Comments" in html
    assert "function applyFilters" in html
    assert "function exportComments" in html
    assert "function toggleCard" in html
    assert "addEventListener('keydown'" in html


def test_per_question_cards_and_data_attrs(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert html.count('class="question-card') == 3
    assert 'data-status="error"' in html
    assert 'data-status="correct"' in html
    assert 'data-model="gpt-5"' in html
    assert 'data-category="execution_error"' in html
    # comment textarea per question
    assert html.count("data-qid=") >= 3


def test_error_first_sort(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    # error card must appear before incorrect, which appears before correct
    assert html.index('data-status="error"') < html.index('data-status="incorrect"')
    assert html.index('data-status="incorrect"') < html.index('data-status="correct"')


def test_conversation_explorer_responses_api(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "Chain of Thought Trace" in html
    assert "USER PROMPT" in html
    assert "TOOL CALL #1 - run_sql" in html
    assert "division by zero" in html  # tool result rendered


def test_conversation_explorer_chat_completions(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "SYSTEM PROMPT" in html
    assert "FINAL ANSWER" in html  # FINAL_SQL detection


def test_metadata_fallback_when_no_trace(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "Tool calls:" in html  # metadata fallback for Q3 (no raw_response)


def test_sql_panel_bird_vs_dabstep(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "Gold SQL" in html          # bird-style card (gold_sql present)
    assert "Predicted SQL" in html
    assert "PREDICTED ANSWER" in html  # dabstep string result
    assert "GOLD (2 rows)" in html     # bird list result row count


def test_html_escaping(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)</script>" not in html


def test_investigation_and_partial_reason(econ):
    html = eval_review.generate_eval_review(econ, "eval-run")
    assert "Error Investigation" in html
    assert "division by zero" in html
    assert "Partial reason: off by one" in html


def test_nested_chat_completions_tool_call(tmp_path):
    # Chat Completions nests tool call name/arguments under "function" — must not render
    # as "unknown" / "{}".
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    payload = {
        "question_id": "1", "db_id": "d", "question_text": "q", "model": "m",
        "config_type": "v3", "database": "d", "predicted_sql": None, "gold_sql": None,
        "gold_result": "x", "predicted_result": "x", "is_correct": True,
        "correctness_level": "correct", "duration_ms": 1, "cost_usd": 0.0,
        "input_tokens": 0, "output_tokens": 0, "tool_calls": 1,
        "raw_response": {"messages": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "type": "function",
                 "function": {"name": "run_sql", "arguments": json.dumps({"sql": "SELECT 1"})}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "[[1]]"},
        ]},
    }
    ev = {"event_id": "e1", "event_time": "2026-05-26T10:00:00+00:00",
          "ingest_time": "2026-05-26T10:00:00+00:00", "kind": "evaluation_result",
          "project_id": "p", "source": "sdk", "idempotency_key": "e1",
          "payload_json": payload, "run_id": "r", "actor_agent_id": None, "actor_task_id": None}
    (cl / "events.jsonl").write_text(json.dumps(ev) + "\n")
    con = reader.connect(str(tmp_path))
    try:
        html = eval_review.generate_eval_review(con, "r")
        assert "TOOL CALL #1 - run_sql" in html
        assert "unknown" not in html
        assert "SELECT 1" in html  # nested arguments rendered
    finally:
        con.close()


def test_payload_labels_are_escaped(tmp_path):
    # answer_source and correctness_level come from the payload and must be escaped at the
    # HTML boundary, not just the larger text blocks (XSS).
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    payload = {
        "question_id": "1", "db_id": "d", "question_text": "q", "model": "m",
        "config_type": "v3", "database": "d", "predicted_sql": None, "gold_sql": None,
        "gold_result": "x", "predicted_result": "y", "is_correct": False,
        "correctness_level": "<img src=x onerror=alert(1)>", "duration_ms": 1, "cost_usd": 0.0,
        "input_tokens": 0, "output_tokens": 0, "tool_calls": 0,
        "answer_source": "<script>alert(1)</script>", "raw_response": None,
    }
    ev = {"event_id": "e1", "event_time": "2026-05-26T10:00:00+00:00",
          "ingest_time": "2026-05-26T10:00:00+00:00", "kind": "evaluation_result",
          "project_id": "p", "source": "sdk", "idempotency_key": "e1",
          "payload_json": payload, "run_id": "r", "actor_agent_id": None, "actor_task_id": None}
    (cl / "events.jsonl").write_text(json.dumps(ev) + "\n")
    con = reader.connect(str(tmp_path))
    try:
        html = eval_review.generate_eval_review(con, "r")
        assert "<script>alert(1)</script>" not in html      # answer_source escaped
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
        assert "<img src=x onerror=alert(1)>" not in html    # level_display escaped
    finally:
        con.close()


def test_metadata_fallback_fields_escaped(tmp_path):
    # No raw_response → metadata fallback; its token/tool/duration fields are payload-derived
    # and could be malformed strings, so they must be escaped.
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    payload = {
        "question_id": "1", "db_id": "d", "question_text": "q", "model": "m",
        "config_type": "v3", "database": "d", "predicted_sql": None, "gold_sql": None,
        "gold_result": "x", "predicted_result": "y", "is_correct": False,
        "correctness_level": "error", "duration_ms": 1, "cost_usd": 0.0,
        "input_tokens": "<script>alert(7)</script>", "output_tokens": 0, "tool_calls": 0,
        "raw_response": None,
    }
    ev = {"event_id": "e1", "event_time": "2026-05-26T10:00:00+00:00",
          "ingest_time": "2026-05-26T10:00:00+00:00", "kind": "evaluation_result",
          "project_id": "p", "source": "sdk", "idempotency_key": "e1",
          "payload_json": payload, "run_id": "r", "actor_agent_id": None, "actor_task_id": None}
    (cl / "events.jsonl").write_text(json.dumps(ev) + "\n")
    con = reader.connect(str(tmp_path))
    try:
        html = eval_review.generate_eval_review(con, "r")
        assert "<script>alert(7)</script>" not in html
        assert "&lt;script&gt;alert(7)&lt;/script&gt;" in html
    finally:
        con.close()


def test_unmatched_chat_completions_tool_call_flushed(tmp_path):
    # Trace ends after an assistant tool call with no tool result (truncated/crashed run);
    # the attempted call must still render, not fall back to metadata.
    cl = tmp_path / "controllog"
    cl.mkdir(parents=True)
    payload = {
        "question_id": "1", "db_id": "d", "question_text": "q", "model": "m",
        "config_type": "v3", "database": "d", "predicted_sql": None, "gold_sql": None,
        "gold_result": "x", "predicted_result": "x", "is_correct": False,
        "correctness_level": "hit_limit", "duration_ms": 1, "cost_usd": 0.0,
        "input_tokens": 0, "output_tokens": 0, "tool_calls": 1,
        "raw_response": {"messages": [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "type": "function",
                 "function": {"name": "run_sql", "arguments": json.dumps({"sql": "SELECT 2"})}}]},
            # no tool-result message follows
        ]},
    }
    ev = {"event_id": "e1", "event_time": "2026-05-26T10:00:00+00:00",
          "ingest_time": "2026-05-26T10:00:00+00:00", "kind": "evaluation_result",
          "project_id": "p", "source": "sdk", "idempotency_key": "e1",
          "payload_json": payload, "run_id": "r", "actor_agent_id": None, "actor_task_id": None}
    (cl / "events.jsonl").write_text(json.dumps(ev) + "\n")
    con = reader.connect(str(tmp_path))
    try:
        html = eval_review.generate_eval_review(con, "r")
        assert "run_sql (no response)" in html
        assert "SELECT 2" in html
    finally:
        con.close()
