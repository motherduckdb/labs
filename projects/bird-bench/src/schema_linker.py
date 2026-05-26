"""
Schema linking using sentence embeddings.

Selects the most relevant tables for a given question using
semantic similarity with sentence-transformers.
"""

import numpy as np
from functools import lru_cache

# Lazy-load sentence-transformers to avoid slow import on every run
_model = None


def get_embedding_model():
    """
    Lazy-load the sentence-transformers model.

    Uses all-MiniLM-L6-v2 which is small (80MB) and fast.
    """
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def link_tables(question: str, tables: list[dict], top_k: int = 4) -> list[str]:
    """
    Select the top-k most relevant tables for a question.

    Args:
        question: The natural language question
        tables: List of dicts with 'name' and 'columns' keys
        top_k: Number of tables to return

    Returns:
        List of table names, ordered by relevance (most relevant first)
    """
    if not tables:
        return []

    if len(tables) <= top_k:
        # All tables fit, no need to filter
        return [t["name"] for t in tables]

    model = get_embedding_model()

    # Encode question
    q_emb = model.encode(question, convert_to_numpy=True)

    # Score each table
    scored = []
    for table in tables:
        # Create table representation: name + all column names
        table_text = f"{table['name']}: {', '.join(table['columns'])}"
        t_emb = model.encode(table_text, convert_to_numpy=True)
        score = cosine_similarity(q_emb, t_emb)
        scored.append((table["name"], score))

    # Sort by score descending and take top-k
    scored.sort(key=lambda x: -x[1])
    return [name for name, _ in scored[:top_k]]


def link_tables_with_scores(question: str, tables: list[dict], top_k: int = 4) -> list[tuple[str, float]]:
    """
    Select the top-k most relevant tables with their scores.

    Args:
        question: The natural language question
        tables: List of dicts with 'name' and 'columns' keys
        top_k: Number of tables to return

    Returns:
        List of (table_name, score) tuples, ordered by relevance
    """
    if not tables:
        return []

    model = get_embedding_model()
    q_emb = model.encode(question, convert_to_numpy=True)

    scored = []
    for table in tables:
        table_text = f"{table['name']}: {', '.join(table['columns'])}"
        t_emb = model.encode(table_text, convert_to_numpy=True)
        score = cosine_similarity(q_emb, t_emb)
        scored.append((table["name"], score))

    scored.sort(key=lambda x: -x[1])
    return scored[:top_k]


def link_tables_batch(questions: list[str], tables: list[dict], top_k: int = 4) -> list[list[str]]:
    """
    Batch version of link_tables for efficiency.

    Args:
        questions: List of natural language questions
        tables: List of dicts with 'name' and 'columns' keys
        top_k: Number of tables to return per question

    Returns:
        List of lists of table names, one per question
    """
    if not tables or not questions:
        return [[] for _ in questions]

    if len(tables) <= top_k:
        all_names = [t["name"] for t in tables]
        return [all_names for _ in questions]

    model = get_embedding_model()

    # Encode all questions at once
    q_embs = model.encode(questions, convert_to_numpy=True)

    # Encode all tables at once
    table_texts = [f"{t['name']}: {', '.join(t['columns'])}" for t in tables]
    t_embs = model.encode(table_texts, convert_to_numpy=True)
    table_names = [t["name"] for t in tables]

    results = []
    for q_emb in q_embs:
        # Compute similarities
        scores = [cosine_similarity(q_emb, t_emb) for t_emb in t_embs]
        # Sort and take top-k
        indexed = list(enumerate(scores))
        indexed.sort(key=lambda x: -x[1])
        top_tables = [table_names[i] for i, _ in indexed[:top_k]]
        results.append(top_tables)

    return results


if __name__ == "__main__":
    # Test the schema linker
    test_tables = [
        {"name": "customers", "columns": ["CustomerID", "Name", "Email", "Country"]},
        {"name": "orders", "columns": ["OrderID", "CustomerID", "Date", "Total"]},
        {"name": "products", "columns": ["ProductID", "Name", "Price", "Category"]},
        {"name": "order_items", "columns": ["OrderID", "ProductID", "Quantity", "Price"]},
        {"name": "categories", "columns": ["CategoryID", "Name", "Description"]},
        {"name": "suppliers", "columns": ["SupplierID", "Name", "Country", "Contact"]},
    ]

    test_questions = [
        "Which customers placed orders in January?",
        "What is the total revenue by product category?",
        "List all suppliers from Germany",
    ]

    print("Testing schema linker...")
    for q in test_questions:
        relevant = link_tables_with_scores(q, test_tables, top_k=3)
        print(f"\nQuestion: {q}")
        print(f"Relevant tables: {relevant}")
