from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import sys

from src.constants import SYSTEM_PROMPT_FILE, USER_PROMPT_FILE, MOTHERDUCK_DATABASE
from src.comparison import CorrectnessLevel
from src.mcp_client import MotherDuckMCPClient, MCP_TOOL_DEFINITIONS


def load_prompt_template(filepath: Path) -> str:
    """Load a prompt template from a markdown file."""
    if filepath.exists():
        return filepath.read_text()
    return None


@dataclass
class ModelConfig:
    """Configuration for a model provider."""
    model_id: str                          # OpenRouter model ID (e.g., "anthropic/claude-opus-4.5")
    display_name: str                      # Human-readable name
    max_tokens: int = 4096
    temperature: float = 0.0

    # Provider routing (for OpenRouter)
    # See: https://openrouter.ai/docs/guides/routing/provider-selection
    provider: dict | None = None           # e.g., {"only": ["google-ai-studio"]} for token caching

    # Optimization settings
    use_schema_linking: bool = True        # Use embedding-based schema filtering
    schema_link_top_k: int = 4             # Number of tables to include after linking
    include_sample_rows: bool = True       # Include sample data rows in schema
    sample_rows_limit: int = 3             # Number of sample rows per table
    include_fk_info: bool = True           # Include foreign key relationships

    @classmethod
    def claude_opus(cls) -> "ModelConfig":
        return cls(
            model_id="anthropic/claude-opus-4.5",
            display_name="Claude Opus 4.5",
        )

    @classmethod
    def gpt_5_2(cls) -> "ModelConfig":
        return cls(
            model_id="openai/gpt-5.2",
            display_name="GPT-5.2",
        )

    @classmethod
    def gemini_3_pro(cls) -> "ModelConfig":
        return cls(
            model_id="google/gemini-3-pro-preview",
            display_name="Gemini 3 Pro",
            provider={"only": ["google-ai-studio"]},  # Pin to single provider for token caching
        )

    @classmethod
    def gemini_flash_3(cls) -> "ModelConfig":
        return cls(
            model_id="google/gemini-3-flash-preview",
            display_name="Gemini 3 Flash",
            provider={"only": ["google-ai-studio"]},  # Pin to single provider for token caching
        )

    @classmethod
    def gemini_flash_3_optimized(cls) -> "ModelConfig":
        """Meta-optimized configuration for Gemini Flash 3 (60% accuracy from meta-GEPA)."""
        config = cls.gemini_flash_3()
        config.temperature = 0.13  # Meta-optimized temperature
        config.max_tokens = 4096   # Meta-optimized max tokens
        # Enable all optimizations
        config.use_schema_linking = True
        config.include_sample_rows = True
        config.include_fk_info = True
        return config

    @classmethod
    def claude_opus_optimized(cls) -> "ModelConfig":
        """Optimized configuration for Claude Opus (based on meta-GEPA insights)."""
        config = cls.claude_opus()
        config.temperature = 0.15  # Conservative temperature for Claude
        config.max_tokens = 4096   # Generous for complex reasoning
        # Enable all optimizations
        config.use_schema_linking = True
        config.include_sample_rows = True
        config.include_fk_info = True
        return config

    @classmethod
    def gpt_5_2_optimized(cls) -> "ModelConfig":
        """Optimized configuration for GPT-5.2 (based on meta-GEPA insights)."""
        config = cls.gpt_5_2()
        config.temperature = 0.12  # Very conservative for GPT
        config.max_tokens = 4096   # Allow complex outputs
        # Enable all optimizations
        config.use_schema_linking = True
        config.include_sample_rows = True
        config.include_fk_info = True
        return config



@dataclass
class EvalResult:
    """Result of evaluating a single question."""
    question_id: int
    db_id: str
    question: str
    evidence: str
    gold_sql: str
    predicted_sql: str | None
    gold_result: Any
    predicted_result: Any
    is_correct: bool
    error: str | None
    model_config: ModelConfig
    input_tokens: int
    output_tokens: int
    cost_usd: float
    duration_ms: int
    tool_calls: int
    raw_response: dict = field(default_factory=dict)
    # New fields for partial correctness
    correctness_level: CorrectnessLevel = CorrectnessLevel.INCORRECT
    partial_match_reason: str | None = None  # e.g., "missing_column", "extra_rows", "subset_match"
    # Upstream cost for BYOK mode (actual provider cost)
    upstream_cost_usd: float | None = None
    # Whether the query hit the max iteration limit (10 tool calls)
    hit_iteration_limit: bool = False
    # Match source for platinum fallback: "gold", "platinum", or "none"
    match_source: str = "none"


# Use MCP tool definitions
SQL_TOOL_DEFINITION = MCP_TOOL_DEFINITIONS[0]  # The 'query' tool


class BaseProvider(ABC):
    """Base class for model providers using MotherDuck MCP."""

    def __init__(self, config: ModelConfig, motherduck_token: str, use_optimized_prompts: bool = False, shared_mcp_client: MotherDuckMCPClient | None = None):
        self.config = config
        self.motherduck_token = motherduck_token
        self._mcp_client: MotherDuckMCPClient | None = shared_mcp_client
        self._owns_mcp_client = shared_mcp_client is None  # Only close if we created it
        self.use_optimized_prompts = use_optimized_prompts

    @property
    def mcp(self) -> MotherDuckMCPClient:
        """Lazy MCP client initialization."""
        if self._mcp_client is None:
            self._mcp_client = MotherDuckMCPClient(self.motherduck_token)
            self._mcp_client.initialize()
        return self._mcp_client

    def execute_tool(self, tool_name: str, arguments: dict, db_id: str, motherduck_db: str = None) -> dict[str, Any]:
        """
        Execute an MCP tool call.

        Args:
            tool_name: Name of the MCP tool (query, list_tables, list_columns, search_catalog)
            arguments: Tool arguments
            db_id: Database schema context
            motherduck_db: MotherDuck database name (bird_bench_a/b/c) - overrides model's argument

        Returns:
            Tool result dictionary
        """
        # Handle the query tool specially to inject schema context
        if tool_name == "query":
            sql = arguments.get("sql", "")
            # Always use enforced database from eval context, ignore model's argument
            database = motherduck_db or arguments.get("database", MOTHERDUCK_DATABASE)
            result = self.mcp.query(sql, database)

            if result.success:
                return {
                    "success": True,
                    "result": result.content
                }
            else:
                return {
                    "success": False,
                    "error": result.error
                }

        elif tool_name == "list_tables":
            database = motherduck_db or arguments.get("database", MOTHERDUCK_DATABASE)
            schema = arguments.get("schema", db_id)
            result = self.mcp.list_tables(database, schema)

            if result.success:
                return {"success": True, "result": result.content}
            else:
                return {"success": False, "error": result.error}

        elif tool_name == "list_columns":
            database = motherduck_db or arguments.get("database", MOTHERDUCK_DATABASE)
            schema = arguments.get("schema", db_id)
            table = arguments.get("table", "")
            result = self.mcp.list_columns(database, table, schema)

            if result.success:
                return {"success": True, "result": result.content}
            else:
                return {"success": False, "error": result.error}

        elif tool_name == "search_catalog":
            query = arguments.get("query", "")
            result = self.mcp.search_catalog(query)

            if result.success:
                return {"success": True, "result": result.content}
            else:
                return {"success": False, "error": result.error}

        else:
            return {"success": False, "error": f"Unknown tool: {tool_name}"}

    def build_system_prompt(self, db_id: str, motherduck_db: str = None) -> str:
        """Build the system prompt for the model."""
        if not motherduck_db:
            motherduck_db = MOTHERDUCK_DATABASE

        if self.use_optimized_prompts:
            # Load from external markdown file for easy tuning
            template = load_prompt_template(SYSTEM_PROMPT_FILE)
            if template:
                return template.format(db_id=db_id, motherduck_db=motherduck_db)
            # Fallback to minimal prompt if file not found
            return f"""You are a SQL expert. Write DuckDB SQL queries to answer questions.
DATABASE: {motherduck_db}
SCHEMA: {db_id}
Use schema-qualified table names like {db_id}.table_name.

Use tools to explore the schema, then write and validate your query.

After validating your query, respond with your final SQL in this format:
FINAL_SQL: ```sql
YOUR QUERY HERE
```"""

        # Default prompt (original)
        return f"""You are a SQL expert being evaluated on text-to-SQL tasks using MotherDuck (cloud DuckDB).

DATABASE: {motherduck_db}
SCHEMA: {db_id}
DIALECT: DuckDB

AVAILABLE TOOLS:
1. list_tables - List tables in a schema
2. list_columns - Get column names and types for a table
3. search_catalog - Fuzzy search for database objects
4. query - Execute SQL queries against the database

INSTRUCTIONS:
1. Read the question and any evidence/hints carefully
2. Use the tools to explore the schema
3. Write DuckDB-compatible SQL queries
4. Tables are accessed using '{db_id}.table_name' syntax (schema-qualified)
5. Always test your query with the 'query' tool before finalizing

After validating your query, respond with your final SQL in this format:
FINAL_SQL: ```sql
YOUR QUERY HERE
```"""

    def build_user_prompt(self, question: str, evidence: str, db_id: str = None, relevant_tables: list[str] = None) -> str:
        """Build the user prompt with question and evidence.

        If use_jinja_metadata is enabled and db_id is provided, uses Jinja template
        with pre-cached metadata for fast prompt generation.
        """
        evidence_text = evidence if evidence else "None provided"

        if self.use_optimized_prompts:
            # Load from external markdown file for easy tuning
            template = load_prompt_template(USER_PROMPT_FILE)
            if template:
                return template.format(question=question, evidence=evidence_text)
            # Fallback to minimal prompt if file not found
            return f"""Question: {question}

Hints: {evidence_text}

Write a SQL query to answer this question."""

        # Default user prompt
        return f"""Question: {question}

Evidence/Hints: {evidence_text}

Write a SQL query to answer this question. Use the available tools to explore the schema and test your query, then provide your final answer."""

    @abstractmethod
    async def run_query(
        self,
        question: str,
        evidence: str,
        db_id: str,
        motherduck_db: str = None,
        relevant_tables: list[str] = None
    ) -> tuple[str | None, dict]:
        """
        Run a text-to-SQL query.

        Args:
            question: The natural language question
            evidence: Hints/evidence for the question
            db_id: The schema name (e.g., 'california_schools')
            motherduck_db: The database name (e.g., 'bird_bench_a')
            relevant_tables: Optional list of relevant tables for schema linking

        Returns:
            tuple: (predicted_sql, metadata_dict)
            metadata_dict contains: input_tokens, output_tokens, duration_ms,
                                   tool_calls, error, cost_usd, raw_messages
        """
        pass

    def close(self):
        """Close MCP client if we own it."""
        if self._mcp_client and self._owns_mcp_client:
            self._mcp_client.close()
            self._mcp_client = None
