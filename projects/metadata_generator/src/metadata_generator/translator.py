"""
SQL-to-Text Translation

Converts SQL queries to natural language descriptions for semantic search
and query documentation.
"""

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    import sqlglot
    from sqlglot import exp
    SQLGLOT_AVAILABLE = True
except ImportError:
    SQLGLOT_AVAILABLE = False

from metadata_generator.llm_client import create_openrouter_client, get_model
from metadata_generator.persistence import save_json, load_json
from metadata_generator.models import (
    QueryTranslation,
    TranslatedQueryHistory,
    SchemaProfile,
)
from metadata_generator.profiler import format_profile_for_prompt


def extract_tables_from_sql(sql: str) -> list[str]:
    """Extract table names from a SQL query."""
    if not SQLGLOT_AVAILABLE:
        return []

    tables = set()
    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        for table in tree.find_all(exp.Table):
            # Get table name without schema prefix
            tables.add(table.name)
    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for table extraction: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error extracting tables from SQL: {e}")

    return sorted(tables)


def normalize_sql(sql: str) -> str:
    """Normalize SQL for deduplication by removing whitespace variations."""
    if not SQLGLOT_AVAILABLE:
        # Basic normalization without sqlglot
        return " ".join(sql.split()).lower()

    try:
        tree = sqlglot.parse_one(sql, dialect="duckdb")
        return tree.sql(dialect="duckdb", normalize=True).lower()
    except sqlglot.errors.ParseError as e:
        logger.debug(f"Failed to parse SQL for normalization, using fallback: {e}")
        return " ".join(sql.split()).lower()
    except Exception as e:
        logger.warning(f"Unexpected error normalizing SQL, using fallback: {e}")
        return " ".join(sql.split()).lower()


class SQLToTextGenerator:
    """
    Converts SQL queries to natural language descriptions.

    Uses an LLM to translate SQL into questions that the query answers.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ):
        """
        Initialize the translator.

        Args:
            api_key: OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.
            model: Model to use for translation. Defaults to Gemini Flash.
        """
        self.client = create_openrouter_client(api_key)
        self.model = get_model(model)

    def translate_query(
        self,
        sql: str,
        schema_context: str | None = None,
    ) -> QueryTranslation:
        """
        Translate a SQL query to natural language.

        Args:
            sql: The SQL query to translate
            schema_context: Optional metadata about tables/columns

        Returns:
            QueryTranslation with natural language description
        """
        context_section = ""
        if schema_context:
            context_section = f"\nDatabase Context:\n{schema_context}\n"

        prompt = f"""Translate this SQL query into TWO natural language questions:

SQL Query:
```sql
{sql}
```
{context_section}
Generate:
1. SHORT QUESTION (5-10 words): Concise, uses key domain terms. Good for few-shot examples.
2. LONG QUESTION (15-30 words): Detailed, fully describes what the query answers. Good for semantic search.

Example:
- Short: "Top 10 customers by revenue"
- Long: "Who are the top 10 customers ranked by total revenue across all their orders?"

Respond in JSON format:
{{"short_question": "...", "long_question": "..."}}"""

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a database expert who translates SQL queries into clear business questions. Generate both concise and detailed versions. Respond only with valid JSON.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=300,
                temperature=0.0,
            )

            raw_content = response.choices[0].message.content
            if raw_content is None:
                return None
            content = raw_content.strip()

            # Parse JSON response
            short_question = ""
            long_question = ""

            try:
                # Handle markdown code blocks
                if content.startswith("```"):
                    lines = content.split("\n")
                    content = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])

                result = json.loads(content)
                short_question = result.get("short_question", "")
                long_question = result.get("long_question", "")
            except json.JSONDecodeError:
                # Fallback: try regex extraction
                import re
                short_match = re.search(r'"short_question":\s*"([^"]+)"', content)
                long_match = re.search(r'"long_question":\s*"([^"]+)"', content)
                if short_match:
                    short_question = short_match.group(1)
                if long_match:
                    long_question = long_match.group(1)

                # If still empty, use the whole response as short question
                if not short_question and not long_question:
                    short_question = content[:100] if content else "Query translation failed"

            tables = extract_tables_from_sql(sql)

            return QueryTranslation(
                sql=sql,
                natural_language=short_question,  # Backwards compat
                tables_referenced=tables,
                short_question=short_question,
                long_question=long_question,
            )

        except Exception as e:
            logger.error(f"Failed to translate query: {e}")
            raise RuntimeError(f"SQL translation failed: {e}") from e

    def translate_batch(
        self,
        queries: list[str],
        schema_context: str | None = None,
        max_queries: int = 100,
        deduplicate: bool = True,
        verbose: bool = False,
    ) -> list[QueryTranslation]:
        """
        Translate a batch of SQL queries.

        Args:
            queries: List of SQL query strings
            schema_context: Optional schema metadata for context
            max_queries: Maximum number of queries to translate
            deduplicate: Whether to deduplicate queries first
            verbose: Print progress

        Returns:
            List of QueryTranslation objects
        """
        if deduplicate:
            # Deduplicate by normalized SQL
            seen = set()
            unique_queries = []
            for q in queries:
                normalized = normalize_sql(q)
                if normalized not in seen:
                    seen.add(normalized)
                    unique_queries.append(q)
            queries = unique_queries

            if verbose:
                print(f"  Deduplicated to {len(queries)} unique queries")

        # Limit to max_queries
        if len(queries) > max_queries:
            queries = queries[:max_queries]
            if verbose:
                print(f"  Limited to {max_queries} queries")

        # TODO: Replace verbose/print() with ProgressCallback pattern for consistency
        translations = []
        for i, sql in enumerate(queries, 1):
            if verbose:
                print(f"  Translating query {i}/{len(queries)}...", end="", flush=True)

            translation = self.translate_query(sql, schema_context)
            translations.append(translation)

            if verbose:
                # Show preview of translation
                preview = translation.natural_language[:60]
                if len(translation.natural_language) > 60:
                    preview += "..."
                print(f" -> \"{preview}\"")

        return translations


def translate_query_history(
    queries: list[str],
    schema: str,
    schema_profile: SchemaProfile | None = None,
    max_queries: int = 100,
    model: str | None = None,
    verbose: bool = False,
    database: str | None = None,
) -> TranslatedQueryHistory:
    """
    Translate unique queries from history.

    Args:
        queries: List of SQL query strings
        schema: Schema name
        schema_profile: Optional profile for context
        max_queries: Maximum queries to translate
        model: LLM model to use
        verbose: Print progress
        database: MotherDuck database name

    Returns:
        TranslatedQueryHistory with translations
    """
    if verbose:
        print(f"  Input queries: {len(queries)}")

    # Build schema context if profile provided
    schema_context = None
    if schema_profile:
        schema_context = format_profile_for_prompt(schema_profile)
        if verbose:
            print(f"  Using schema context ({len(schema_profile.tables)} tables)")

    # Initialize generator
    generator = SQLToTextGenerator(model=model)

    # Translate queries
    translations = generator.translate_batch(
        queries,
        schema_context=schema_context,
        max_queries=max_queries,
        deduplicate=True,
        verbose=verbose,
    )

    return TranslatedQueryHistory(
        schema=schema,
        generated_at=datetime.now().isoformat(),
        translations=translations,
        database=database,
    )


def save_translations(
    result: TranslatedQueryHistory,
    output_dir: str = "output/translations",
) -> Path:
    """Save translations to JSON file."""
    if result.database:
        filename = f"{result.database}_{result.schema}_translations.json"
    else:
        filename = f"{result.schema}_translations.json"
    return save_json(result, output_dir, filename)


def load_translations(
    schema: str,
    translations_dir: str = "output/translations",
    database: str | None = None,
) -> TranslatedQueryHistory | None:
    """Load cached translations from JSON file."""
    if database:
        filename = f"{database}_{schema}_translations.json"
    else:
        filename = f"{schema}_translations.json"
    return load_json(TranslatedQueryHistory, Path(translations_dir) / filename)


def format_translations_for_prompt(
    result: TranslatedQueryHistory,
    max_examples: int = 10,
    use_long: bool = False,
) -> str:
    """
    Format translations for inclusion in prompts.

    Useful for few-shot prompting in text-to-SQL.

    Args:
        result: TranslatedQueryHistory with translations
        max_examples: Maximum examples to include
        use_long: Use long_question instead of short_question
    """
    lines = [f"EXAMPLE QUERIES FOR {result.schema}:"]
    lines.append("=" * 50)

    for i, t in enumerate(result.translations[:max_examples], 1):
        question = (t.long_question if use_long and t.long_question else t.short_question) or t.natural_language
        lines.append(f"\nQuestion {i}: {question}")
        lines.append(f"SQL: {t.sql}")
        if t.tables_referenced:
            lines.append(f"Tables: {', '.join(t.tables_referenced)}")

    return "\n".join(lines)


