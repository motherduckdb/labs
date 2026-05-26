#!/usr/bin/env python3
"""Deep analysis of failure patterns to find improvement opportunities."""

import json
from collections import defaultdict
from pathlib import Path

def analyze_wrong_answers(results_file: str):
    with open(results_file) as f:
        data = json.load(f)

    results = data["results"]

    # Get all wrong answers (not partial, not error)
    wrong = [r for r in results if not r["is_correct"] and not r["error"] and not r["partial_match_reason"]]

    print(f"\n{'='*70}")
    print(f"DEEP ANALYSIS OF {len(wrong)} WRONG ANSWERS")
    print(f"{'='*70}")

    # Categories of issues
    categories = defaultdict(list)

    for r in wrong:
        gold = r.get("gold_result", "")
        pred = r.get("predicted_result", "")
        question = r["question"].lower()
        gold_sql = r.get("gold_sql", "").lower()
        pred_sql = r.get("predicted_sql", "").lower()

        # Analyze the difference
        try:
            gold_data = eval(gold) if gold else []
            pred_data = eval(pred) if pred else []
        except:
            gold_data = []
            pred_data = []

        # Check for specific patterns
        if "percentage" in question or "percent" in question or "ratio" in question:
            categories["percentage_ratio_errors"].append(r)
        elif "highest" in question or "most" in question or "max" in question:
            categories["superlative_max_errors"].append(r)
        elif "lowest" in question or "least" in question or "min" in question:
            categories["superlative_min_errors"].append(r)
        elif "average" in question or "avg" in question:
            categories["average_errors"].append(r)
        elif "difference" in question or "between" in question:
            categories["difference_errors"].append(r)
        elif "count" in question or "how many" in question:
            categories["count_errors"].append(r)
        elif "sum" in question or "total" in question:
            categories["sum_total_errors"].append(r)
        else:
            categories["other_errors"].append(r)

        # Check for format mismatches
        if gold_data and pred_data:
            # Single value vs multiple rows
            if len(gold_data) > 1 and len(pred_data) == 1:
                categories["expected_list_got_single"].append(r)
            elif len(gold_data) == 1 and len(pred_data) > 1:
                categories["expected_single_got_list"].append(r)

            # Type mismatches
            if gold_data and pred_data:
                gold_first = gold_data[0][0] if isinstance(gold_data[0], tuple) else gold_data[0]
                pred_first = pred_data[0][0] if isinstance(pred_data[0], tuple) else pred_data[0]

                if type(gold_first) != type(pred_first):
                    categories["type_mismatch"].append(r)

    # Print analysis by category
    for category, items in sorted(categories.items(), key=lambda x: -len(x[1])):
        print(f"\n{'='*70}")
        print(f"{category.upper()}: {len(items)} failures")
        print(f"{'='*70}")

        for item in items[:5]:  # Show first 5 examples
            print(f"\n  Q{item['question_id']} ({item['db_id']}):")
            print(f"    Question: {item['question'][:80]}...")
            print(f"    Evidence: {item.get('evidence', 'N/A')[:80]}...")
            print(f"    Gold SQL snippet: ...{item['gold_sql'][-100:] if len(item['gold_sql']) > 100 else item['gold_sql']}")
            print(f"    Pred SQL snippet: ...{item['predicted_sql'][-100:] if len(item['predicted_sql']) > 100 else item['predicted_sql']}")
            print(f"    Gold result: {str(item['gold_result'])[:60]}...")
            print(f"    Pred result: {str(item['predicted_result'])[:60]}...")

    # Look for SQL pattern differences
    print(f"\n{'='*70}")
    print("SQL PATTERN ANALYSIS")
    print(f"{'='*70}")

    # Check for common SQL differences
    sql_patterns = defaultdict(int)
    for r in wrong:
        gold_sql = r.get("gold_sql", "").lower()
        pred_sql = r.get("predicted_sql", "").lower()

        if "group by" in gold_sql and "group by" not in pred_sql:
            sql_patterns["missing_group_by"] += 1
        if "group by" not in gold_sql and "group by" in pred_sql:
            sql_patterns["extra_group_by"] += 1
        if "order by" in gold_sql and "order by" not in pred_sql:
            sql_patterns["missing_order_by"] += 1
        if "limit 1" in gold_sql and "limit 1" not in pred_sql:
            sql_patterns["missing_limit"] += 1
        if "distinct" in gold_sql and "distinct" not in pred_sql:
            sql_patterns["missing_distinct"] += 1
        if "having" in gold_sql and "having" not in pred_sql:
            sql_patterns["missing_having"] += 1
        if "sum(" in gold_sql and "count(" in pred_sql:
            sql_patterns["sum_vs_count"] += 1
        if "count(" in gold_sql and "sum(" in pred_sql:
            sql_patterns["count_vs_sum"] += 1
        if "avg(" in gold_sql and "avg(" not in pred_sql:
            sql_patterns["missing_avg"] += 1
        if "case when" in gold_sql and "case when" not in pred_sql:
            sql_patterns["missing_case_when"] += 1
        if "iif(" in gold_sql and "iif(" not in pred_sql and "case" not in pred_sql:
            sql_patterns["missing_conditional_agg"] += 1
        if "strftime" in gold_sql or "substr" in gold_sql:
            if "strftime" not in pred_sql and "substr" not in pred_sql:
                sql_patterns["missing_date_extraction"] += 1
        if "inner join" in gold_sql and "left join" in pred_sql:
            sql_patterns["inner_vs_left_join"] += 1
        if "left join" in gold_sql and "inner join" in pred_sql:
            sql_patterns["left_vs_inner_join"] += 1

    for pattern, count in sorted(sql_patterns.items(), key=lambda x: -x[1]):
        print(f"  {pattern}: {count}")

    # Database-specific analysis for worst performers
    print(f"\n{'='*70}")
    print("WORST DATABASE DEEP DIVE")
    print(f"{'='*70}")

    worst_dbs = ["california_schools", "financial", "thrombosis_prediction"]
    for db in worst_dbs:
        db_wrong = [r for r in wrong if r["db_id"] == db]
        print(f"\n{db}: {len(db_wrong)} wrong")
        for r in db_wrong[:3]:
            print(f"\n  Q{r['question_id']}:")
            print(f"    Q: {r['question'][:70]}...")
            print(f"    Gold: {r['gold_sql'][:80]}...")
            print(f"    Pred: {r['predicted_sql'][:80]}...")
            print(f"    Gold result: {str(r['gold_result'])[:50]}")
            print(f"    Pred result: {str(r['predicted_result'])[:50]}")

    return categories

def analyze_partial_matches(results_file: str):
    with open(results_file) as f:
        data = json.load(f)

    results = data["results"]

    # Get partial matches
    partial = [r for r in results if r.get("partial_match_reason")]

    print(f"\n{'='*70}")
    print(f"PARTIAL MATCH ANALYSIS: {len(partial)} cases")
    print(f"{'='*70}")

    by_reason = defaultdict(list)
    for r in partial:
        reason = r["partial_match_reason"].split(":")[0]  # Get type without count
        by_reason[reason].append(r)

    for reason, items in sorted(by_reason.items(), key=lambda x: -len(x[1])):
        print(f"\n{reason}: {len(items)}")
        for item in items[:3]:
            print(f"  Q{item['question_id']}: {item['question'][:60]}...")
            print(f"    Gold: {str(item['gold_result'])[:50]}")
            print(f"    Pred: {str(item['predicted_result'])[:50]}")

if __name__ == "__main__":
    import sys
    results_file = sys.argv[1] if len(sys.argv) > 1 else "data/results/results_Gemini_3_Flash_20260113_104523.json"
    analyze_wrong_answers(results_file)
    analyze_partial_matches(results_file)
