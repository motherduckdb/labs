"""Feature-parity tests for the rich evaluation review (eval_review.py)."""
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
