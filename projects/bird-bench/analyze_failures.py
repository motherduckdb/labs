#!/usr/bin/env python3
"""Analyze failure patterns from evaluation results."""

import json
from collections import defaultdict
from pathlib import Path

def analyze_failures(results_file: str):
    with open(results_file) as f:
        data = json.load(f)

    results = data["results"]

    # Try to load questions file for difficulty info
    difficulty_map = {}
    questions_files = [
        Path(__file__).parent / "data" / "bird_mini_dev_500.json",
        Path(__file__).parent / "mini_dev_data" / "MINIDEV" / "mini_dev_sqlite.json",
    ]
    for questions_file in questions_files:
        if questions_file.exists():
            with open(questions_file) as f:
                questions_data = json.load(f)
            if isinstance(questions_data, list):
                for q in questions_data:
                    difficulty_map[q["question_id"]] = q.get("difficulty", "unknown")
            elif "questions" in questions_data:
                for q in questions_data["questions"]:
                    difficulty_map[q["question_id"]] = q.get("difficulty", "unknown")
            break
    if not difficulty_map:
        print("Warning: Could not find questions file for difficulty info")

    # Categorize results
    correct = []
    wrong = []
    partial = []
    errors = []

    for r in results:
        if r["is_correct"]:
            correct.append(r)
        elif r["error"]:
            errors.append(r)
        elif r["partial_match_reason"]:
            partial.append(r)
        else:
            wrong.append(r)

    print(f"Total: {len(results)}")
    print(f"Correct: {len(correct)} ({100*len(correct)/len(results):.1f}%)")
    print(f"Wrong: {len(wrong)} ({100*len(wrong)/len(results):.1f}%)")
    print(f"Partial: {len(partial)} ({100*len(partial)/len(results):.1f}%)")
    print(f"Errors: {len(errors)} ({100*len(errors)/len(results):.1f}%)")

    # Analyze by database
    print("\n" + "="*60)
    print("FAILURES BY DATABASE")
    print("="*60)

    by_db = defaultdict(lambda: {"correct": 0, "wrong": 0, "partial": 0, "error": 0, "total": 0})
    for r in results:
        db = r["db_id"]
        by_db[db]["total"] += 1
        if r["is_correct"]:
            by_db[db]["correct"] += 1
        elif r["error"]:
            by_db[db]["error"] += 1
        elif r["partial_match_reason"]:
            by_db[db]["partial"] += 1
        else:
            by_db[db]["wrong"] += 1

    # Sort by accuracy (ascending)
    sorted_dbs = sorted(by_db.items(), key=lambda x: x[1]["correct"]/x[1]["total"])

    for db, stats in sorted_dbs:
        acc = 100 * stats["correct"] / stats["total"]
        print(f"  {db}: {stats['correct']}/{stats['total']} ({acc:.1f}%) | wrong={stats['wrong']} partial={stats['partial']} error={stats['error']}")

    # Analyze by difficulty
    print("\n" + "="*60)
    print("FAILURES BY DIFFICULTY")
    print("="*60)

    by_diff = defaultdict(lambda: {"correct": 0, "wrong": 0, "partial": 0, "error": 0, "total": 0})
    for r in results:
        diff = difficulty_map.get(r["question_id"], "unknown")
        by_diff[diff]["total"] += 1
        if r["is_correct"]:
            by_diff[diff]["correct"] += 1
        elif r["error"]:
            by_diff[diff]["error"] += 1
        elif r["partial_match_reason"]:
            by_diff[diff]["partial"] += 1
        else:
            by_diff[diff]["wrong"] += 1

    for diff in ["simple", "moderate", "challenging", "unknown"]:
        if diff in by_diff:
            stats = by_diff[diff]
            acc = 100 * stats["correct"] / stats["total"]
            print(f"  {diff}: {stats['correct']}/{stats['total']} ({acc:.1f}%) | wrong={stats['wrong']} partial={stats['partial']} error={stats['error']}")

    # Analyze partial match reasons
    print("\n" + "="*60)
    print("PARTIAL MATCH REASONS")
    print("="*60)

    partial_reasons = defaultdict(list)
    for r in partial:
        reason = r["partial_match_reason"]
        partial_reasons[reason].append(r)

    for reason, items in sorted(partial_reasons.items(), key=lambda x: -len(x[1])):
        print(f"  {reason}: {len(items)}")

    # Analyze error types
    print("\n" + "="*60)
    print("ERROR TYPES")
    print("="*60)

    error_types = defaultdict(list)
    for r in errors:
        err = r["error"]
        # Extract error type
        if "Binder Error" in err:
            error_types["Binder Error"].append(r)
        elif "Catalog Error" in err:
            error_types["Catalog Error"].append(r)
        elif "Parser Error" in err:
            error_types["Parser Error"].append(r)
        elif "timeout" in err.lower():
            error_types["Timeout"].append(r)
        else:
            error_types["Other"].append(r)

    for error_type, items in sorted(error_types.items(), key=lambda x: -len(x[1])):
        print(f"  {error_type}: {len(items)}")
        for item in items[:2]:
            err_preview = item["error"][:100].replace("\n", " ")
            print(f"    - Q{item['question_id']}: {err_preview}...")

    # Detailed analysis of wrong answers
    print("\n" + "="*60)
    print("WRONG ANSWER PATTERNS")
    print("="*60)

    # Sample some wrong answers
    print("\nSample wrong answers (first 20):")
    for r in wrong[:20]:
        print(f"\n  Q{r['question_id']} ({r['db_id']}):")
        print(f"    Question: {r['question'][:80]}...")
        print(f"    Gold result: {r['gold_result'][:80] if r['gold_result'] else 'N/A'}...")
        print(f"    Pred result: {r['predicted_result'][:80] if r['predicted_result'] else 'N/A'}...")

    # Check for pattern: SELECT column count mismatch
    print("\n" + "="*60)
    print("COLUMN COUNT MISMATCHES IN WRONG ANSWERS")
    print("="*60)

    col_mismatch = 0
    row_mismatch = 0
    value_mismatch = 0

    for r in wrong:
        gold = r.get("gold_result", "")
        pred = r.get("predicted_result", "")

        if not gold or not pred:
            continue

        # Try to parse and compare
        try:
            gold_data = eval(gold) if gold else []
            pred_data = eval(pred) if pred else []

            if gold_data and pred_data:
                gold_cols = len(gold_data[0]) if isinstance(gold_data[0], (list, tuple)) else 1
                pred_cols = len(pred_data[0]) if isinstance(pred_data[0], (list, tuple)) else 1

                if gold_cols != pred_cols:
                    col_mismatch += 1
                elif len(gold_data) != len(pred_data):
                    row_mismatch += 1
                else:
                    value_mismatch += 1
        except:
            pass

    print(f"  Column count mismatch: {col_mismatch}")
    print(f"  Row count mismatch: {row_mismatch}")
    print(f"  Value mismatch (same shape): {value_mismatch}")

    # Find worst performing question types
    print("\n" + "="*60)
    print("KEYWORDS IN FAILED QUESTIONS")
    print("="*60)

    keywords = ["ratio", "percentage", "average", "count", "sum", "max", "min",
                "most", "least", "highest", "lowest", "difference", "between"]

    keyword_stats = defaultdict(lambda: {"correct": 0, "wrong": 0})
    for r in results:
        q_lower = r["question"].lower()
        for kw in keywords:
            if kw in q_lower:
                if r["is_correct"]:
                    keyword_stats[kw]["correct"] += 1
                elif not r["error"] and not r["partial_match_reason"]:
                    keyword_stats[kw]["wrong"] += 1

    for kw, stats in sorted(keyword_stats.items(), key=lambda x: x[1]["wrong"]/(x[1]["wrong"]+x[1]["correct"]+0.01) if x[1]["wrong"]+x[1]["correct"]>5 else 0, reverse=True):
        if stats["wrong"] + stats["correct"] > 5:
            fail_rate = 100 * stats["wrong"] / (stats["wrong"] + stats["correct"])
            print(f"  '{kw}': {fail_rate:.1f}% fail rate ({stats['wrong']} wrong, {stats['correct']} correct)")

    return wrong, partial, errors

if __name__ == "__main__":
    import sys
    results_file = sys.argv[1] if len(sys.argv) > 1 else "data/results/results_Gemini_3_Flash_20260113_104523.json"
    analyze_failures(results_file)
