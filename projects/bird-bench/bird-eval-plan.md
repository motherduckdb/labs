# BIRD-Bench Multi-Model Evaluation with MotherDuck

## Overview

Run 100 "challenging" BIRD-bench questions against multiple frontier models using a unified evaluation harness with MotherDuck as the database backend.

**Models to Test:**
- Claude Opus 4.5 (`claude-opus-4-5-20250514`)
- GPT-5.2 (`gpt-5.2`)  
- Gemini 3 (`gemini-3.0-pro`)

**Goal:** Compare text-to-SQL accuracy across frontier models using identical prompts, tools, and evaluation criteria.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Evaluation Harness                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Claude    │  │    GPT      │  │   Gemini    │         │
│  │  Provider   │  │  Provider   │  │  Provider   │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                 │
│         └────────────────┼────────────────┘                 │
│                          │                                  │
│                 ┌────────▼────────┐                         │
│                 │  Unified Tool   │                         │
│                 │   Interface     │                         │
│                 └────────┬────────┘                         │
│                          │                                  │
│                 ┌────────▼────────┐                         │
│                 │   MotherDuck    │                         │
│                 │   (DuckDB)      │                         │
│                 └─────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

Each provider implements the same interface:
1. Receives question + schema + evidence
2. Has access to `execute_sql` tool
3. Returns predicted SQL
4. Results compared against gold standard

---

## Phase 1: Data Preparation

### 1.1 Download and Parse BIRD Mini-Dev Dataset

Create `src/data_prep.py`:

```python
from datasets import load_dataset
import json
from pathlib import Path

def prepare_challenging_questions(output_path: str = "data/bird_challenging_100.json"):
    """Download BIRD Mini-Dev and extract challenging questions."""
    dataset = load_dataset("birdsql/bird_mini_dev")
    mini_dev = dataset["mini_dev_sqlite"]
    challenging = [dict(row) for row in mini_dev if row["difficulty"] == "challenging"]
    print(f"Found {len(challenging)} challenging questions")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(challenging, f, indent=2)
    print(f"Saved to {output_path}")
    return challenging

if __name__ == "__main__":
    prepare_challenging_questions()
```

### 1.2 Download BIRD Databases

Download from: https://drive.google.com/file/d/13VLWIwpw5E3d5DUkMvzw7hvHE67a4XkG/view
Extract to `./mini_dev_data/dev_databases/`

### 1.3 Load SQLite Databases into MotherDuck

Create `src/load_to_motherduck.py`:

```python
import duckdb
from pathlib import Path
import os

def load_databases_to_motherduck(
    sqlite_dir: str = "./mini_dev_data/dev_databases",
    motherduck_db: str = "bird_bench"
):
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        raise ValueError("MOTHERDUCK_TOKEN not set")
    
    md = duckdb.connect(f"md:{motherduck_db}?motherduck_token={token}")
    
    databases = [
        "debit_card_specializing", "student_club", "thrombosis_prediction",
        "european_football_2", "formula_1", "superhero", "codebase_community",
        "card_games", "toxicology", "california_schools", "financial"
    ]
    
    sqlite_base = Path(sqlite_dir)
    
    for db_name in databases:
        possible_paths = [
            sqlite_base / db_name / f"{db_name}.sqlite",
            sqlite_base / db_name / "sqlite" / f"{db_name}.sqlite",
        ]
        sqlite_path = next((p for p in possible_paths if p.exists()), None)
        if not sqlite_path:
            print(f"⚠ Could not find {db_name}")
            continue
        
        print(f"Loading {db_name}...")
        md.execute(f"CREATE SCHEMA IF NOT EXISTS {db_name}")
        md.execute(f"ATTACH '{sqlite_path}' AS src (TYPE sqlite)")
        
        tables = md.execute(
            "SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        
        for (table,) in tables:
            md.execute(f"CREATE OR REPLACE TABLE {db_name}.{table} AS SELECT * FROM src.{table}")
        
        md.execute("DETACH src")
        print(f"  ✓ {db_name} ({len(tables)} tables)")
    
    md.close()

if __name__ == "__main__":
    load_databases_to_motherduck()
```

---

## Phase 2: Project Setup

### 2.1 Project Structure

```
bird-eval/
├── pyproject.toml
├── src/
│   ├── __init__.py
│   ├── data_prep.py
│   ├── load_to_motherduck.py
│   ├── schema_helper.py
│   ├── providers/
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── anthropic.py
│   │   ├── openai.py
│   │   └── google.py
│   └── run_eval.py
├── data/
│   ├── bird_challenging_100.json
│   └── results/
└── .env
```

### 2.2 Dependencies (pyproject.toml)

```toml
[project]
name = "bird-eval"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "anthropic>=0.52.0",
    "openai>=1.50.0",
    "google-genai>=1.0.0",
    "duckdb>=1.0.0",
    "datasets>=2.14.0",
    "python-dotenv>=1.0.0",
]
```

### 2.3 Environment Variables (.env)

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
MOTHERDUCK_TOKEN=...
```

---

## Phase 3: Provider Abstraction

### 3.1 Base Provider (src/providers/base.py)

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
import duckdb
import os

@dataclass
class ModelConfig:
    provider: str
    model_id: str
    api_key: str | None = None
    max_tokens: int = 4096
    temperature: float = 0.0
    input_price_per_million: float = 0.0
    output_price_per_million: float = 0.0
    
    @classmethod
    def claude_opus(cls) -> "ModelConfig":
        return cls(
            provider="anthropic",
            model_id="claude-opus-4-5-20250514",
            api_key=os.environ.get("ANTHROPIC_API_KEY"),
            input_price_per_million=15.0,
            output_price_per_million=75.0
        )
    
    @classmethod
    def gpt_5_2(cls) -> "ModelConfig":
        return cls(
            provider="openai",
            model_id="gpt-5.2",
            api_key=os.environ.get("OPENAI_API_KEY"),
            input_price_per_million=10.0,
            output_price_per_million=30.0
        )
    
    @classmethod
    def gemini_3(cls) -> "ModelConfig":
        return cls(
            provider="google",
            model_id="gemini-3.0-pro",
            api_key=os.environ.get("GOOGLE_API_KEY"),
            input_price_per_million=7.0,
            output_price_per_million=21.0
        )

@dataclass
class EvalResult:
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

SQL_TOOL_DEFINITION = {
    "name": "execute_sql",
    "description": "Execute a SQL query against the database and return results.",
    "parameters": {
        "type": "object",
        "properties": {
            "sql": {"type": "string", "description": "The SQL query to execute."},
            "explanation": {"type": "string", "description": "Brief explanation."}
        },
        "required": ["sql"]
    }
}

class BaseProvider(ABC):
    def __init__(self, config: ModelConfig, motherduck_token: str):
        self.config = config
        self.motherduck_token = motherduck_token
        self._db_connection = None
    
    @property
    def db(self):
        if self._db_connection is None:
            self._db_connection = duckdb.connect(
                f"md:bird_bench?motherduck_token={self.motherduck_token}"
            )
        return self._db_connection
    
    def execute_sql(self, sql: str, db_id: str) -> dict[str, Any]:
        try:
            self.db.execute(f"SET search_path = '{db_id}'")
            result = self.db.execute(sql).fetchall()
            columns = [d[0] for d in self.db.description] if self.db.description else []
            return {"success": True, "columns": columns, "rows": result[:50], "row_count": len(result)}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    def build_system_prompt(self, db_id: str, schema_info: str) -> str:
        return f"""You are a SQL expert being evaluated on text-to-SQL tasks.

DATABASE: {db_id}
DIALECT: DuckDB

SCHEMA:
{schema_info}

INSTRUCTIONS:
1. Read the question and evidence/hints carefully
2. Write a DuckDB-compatible SQL query
3. Use the execute_sql tool to run your query
4. Tables use '{db_id}.table_name' syntax

DUCKDB SYNTAX:
- STRFTIME(date, '%Y-%m-%d') for dates
- CAST(x AS DOUBLE) for decimals
- || for string concat
- SUBSTR is 1-indexed

After executing, respond: FINAL_SQL: <your query>"""

    def build_user_prompt(self, question: str, evidence: str) -> str:
        return f"Question: {question}\n\nEvidence: {evidence if evidence else 'None'}"

    def calculate_cost(self, input_tokens: int, output_tokens: int) -> float:
        return (input_tokens * self.config.input_price_per_million / 1_000_000 +
                output_tokens * self.config.output_price_per_million / 1_000_000)

    @abstractmethod
    async def run_query(self, question: str, evidence: str, db_id: str, schema_info: str) -> tuple[str | None, dict]:
        pass
    
    def close(self):
        if self._db_connection:
            self._db_connection.close()
            self._db_connection = None
```

### 3.2 Anthropic Provider (src/providers/anthropic.py)

```python
import asyncio, time, re
from typing import Any
import anthropic
from .base import BaseProvider, SQL_TOOL_DEFINITION

class AnthropicProvider(BaseProvider):
    def __init__(self, config, motherduck_token):
        super().__init__(config, motherduck_token)
        self.client = anthropic.Anthropic(api_key=config.api_key)
    
    async def run_query(self, question: str, evidence: str, db_id: str, schema_info: str) -> tuple[str | None, dict]:
        start = time.time()
        predicted_sql, tool_calls, input_tok, output_tok, error = None, 0, 0, 0, None
        
        messages = [{"role": "user", "content": self.build_user_prompt(question, evidence)}]
        tools = [{"name": SQL_TOOL_DEFINITION["name"], "description": SQL_TOOL_DEFINITION["description"],
                  "input_schema": SQL_TOOL_DEFINITION["parameters"]}]
        
        try:
            for _ in range(10):
                response = await asyncio.get_event_loop().run_in_executor(None, lambda: 
                    self.client.messages.create(
                        model=self.config.model_id, max_tokens=self.config.max_tokens,
                        temperature=self.config.temperature, system=self.build_system_prompt(db_id, schema_info),
                        tools=tools, messages=messages))
                
                input_tok += response.usage.input_tokens
                output_tok += response.usage.output_tokens
                
                assistant_content, has_tool = [], False
                for block in response.content:
                    if block.type == "text":
                        assistant_content.append({"type": "text", "text": block.text})
                        if "FINAL_SQL:" in block.text:
                            match = re.search(r'FINAL_SQL:\s*```sql\s*(.+?)\s*```', block.text, re.DOTALL)
                            if not match: match = re.search(r'FINAL_SQL:\s*(.+?)(?:\n\n|$)', block.text, re.DOTALL)
                            if match: predicted_sql = match.group(1).strip()
                    elif block.type == "tool_use":
                        has_tool, tool_calls = True, tool_calls + 1
                        assistant_content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                        if block.name == "execute_sql":
                            sql = block.input.get("sql", "")
                            predicted_sql = sql
                            result = self.execute_sql(sql, db_id)
                            messages.append({"role": "assistant", "content": assistant_content})
                            messages.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": block.id, "content": str(result)}]})
                            assistant_content = []
                
                if not has_tool or response.stop_reason == "end_turn": break
        except Exception as e:
            error = str(e)
        
        return predicted_sql, {"input_tokens": input_tok, "output_tokens": output_tok, 
                               "duration_ms": int((time.time()-start)*1000), "tool_calls": tool_calls,
                               "error": error, "cost_usd": self.calculate_cost(input_tok, output_tok)}
```

### 3.3 OpenAI Provider (src/providers/openai.py)

```python
import asyncio, time, re, json
from openai import OpenAI
from .base import BaseProvider, SQL_TOOL_DEFINITION

class OpenAIProvider(BaseProvider):
    def __init__(self, config, motherduck_token):
        super().__init__(config, motherduck_token)
        self.client = OpenAI(api_key=config.api_key)
    
    async def run_query(self, question: str, evidence: str, db_id: str, schema_info: str) -> tuple[str | None, dict]:
        start = time.time()
        predicted_sql, tool_calls, input_tok, output_tok, error = None, 0, 0, 0, None
        
        messages = [{"role": "system", "content": self.build_system_prompt(db_id, schema_info)},
                    {"role": "user", "content": self.build_user_prompt(question, evidence)}]
        tools = [{"type": "function", "function": {"name": SQL_TOOL_DEFINITION["name"],
                  "description": SQL_TOOL_DEFINITION["description"], "parameters": SQL_TOOL_DEFINITION["parameters"]}}]
        
        try:
            for _ in range(10):
                response = await asyncio.get_event_loop().run_in_executor(None, lambda:
                    self.client.chat.completions.create(
                        model=self.config.model_id, messages=messages, tools=tools,
                        tool_choice="auto", max_tokens=self.config.max_tokens, temperature=self.config.temperature))
                
                input_tok += response.usage.prompt_tokens
                output_tok += response.usage.completion_tokens
                msg = response.choices[0].message
                
                if msg.tool_calls:
                    messages.append(msg)
                    for tc in msg.tool_calls:
                        tool_calls += 1
                        if tc.function.name == "execute_sql":
                            args = json.loads(tc.function.arguments)
                            predicted_sql = args.get("sql", "")
                            result = self.execute_sql(predicted_sql, db_id)
                            messages.append({"role": "tool", "tool_call_id": tc.id, "content": str(result)})
                else:
                    if msg.content and "FINAL_SQL:" in msg.content:
                        match = re.search(r'FINAL_SQL:\s*```sql\s*(.+?)\s*```', msg.content, re.DOTALL)
                        if not match: match = re.search(r'FINAL_SQL:\s*(.+?)(?:\n\n|$)', msg.content, re.DOTALL)
                        if match: predicted_sql = match.group(1).strip()
                    break
                if response.choices[0].finish_reason == "stop": break
        except Exception as e:
            error = str(e)
        
        return predicted_sql, {"input_tokens": input_tok, "output_tokens": output_tok,
                               "duration_ms": int((time.time()-start)*1000), "tool_calls": tool_calls,
                               "error": error, "cost_usd": self.calculate_cost(input_tok, output_tok)}
```

### 3.4 Google Provider (src/providers/google.py)

```python
import asyncio, time, re
from google import genai
from google.genai import types
from .base import BaseProvider, SQL_TOOL_DEFINITION

class GoogleProvider(BaseProvider):
    def __init__(self, config, motherduck_token):
        super().__init__(config, motherduck_token)
        self.client = genai.Client(api_key=config.api_key)
    
    async def run_query(self, question: str, evidence: str, db_id: str, schema_info: str) -> tuple[str | None, dict]:
        start = time.time()
        predicted_sql, tool_calls, input_tok, output_tok, error = None, 0, 0, 0, None
        
        tools = [types.Tool(function_declarations=[types.FunctionDeclaration(
            name=SQL_TOOL_DEFINITION["name"], description=SQL_TOOL_DEFINITION["description"],
            parameters=types.Schema(type="object", properties={
                "sql": types.Schema(type="string"), "explanation": types.Schema(type="string")
            }, required=["sql"]))])]
        
        contents = [types.Content(role="user", parts=[types.Part(text=self.build_user_prompt(question, evidence))])]
        
        try:
            for _ in range(10):
                response = await asyncio.get_event_loop().run_in_executor(None, lambda:
                    self.client.models.generate_content(
                        model=self.config.model_id, contents=contents,
                        config=types.GenerateContentConfig(
                            system_instruction=self.build_system_prompt(db_id, schema_info),
                            tools=tools, max_output_tokens=self.config.max_tokens, temperature=self.config.temperature)))
                
                if response.usage_metadata:
                    input_tok += response.usage_metadata.prompt_token_count or 0
                    output_tok += response.usage_metadata.candidates_token_count or 0
                
                candidate = response.candidates[0]
                contents.append(candidate.content)
                has_func = False
                
                for part in candidate.content.parts:
                    if part.function_call:
                        has_func, tool_calls = True, tool_calls + 1
                        if part.function_call.name == "execute_sql":
                            predicted_sql = part.function_call.args.get("sql", "")
                            result = self.execute_sql(predicted_sql, db_id)
                            contents.append(types.Content(role="user", parts=[types.Part(
                                function_response=types.FunctionResponse(name="execute_sql", response={"result": str(result)}))]))
                    elif part.text and "FINAL_SQL:" in part.text:
                        match = re.search(r'FINAL_SQL:\s*```sql\s*(.+?)\s*```', part.text, re.DOTALL)
                        if not match: match = re.search(r'FINAL_SQL:\s*(.+?)(?:\n\n|$)', part.text, re.DOTALL)
                        if match: predicted_sql = match.group(1).strip()
                
                if not has_func: break
        except Exception as e:
            error = str(e)
        
        return predicted_sql, {"input_tokens": input_tok, "output_tokens": output_tok,
                               "duration_ms": int((time.time()-start)*1000), "tool_calls": tool_calls,
                               "error": error, "cost_usd": self.calculate_cost(input_tok, output_tok)}
```

### 3.5 Provider Factory (src/providers/__init__.py)

```python
import os
from .base import BaseProvider, ModelConfig, EvalResult, SQL_TOOL_DEFINITION
from .anthropic import AnthropicProvider
from .openai import OpenAIProvider
from .google import GoogleProvider

def create_provider(config: ModelConfig, motherduck_token: str) -> BaseProvider:
    providers = {"anthropic": AnthropicProvider, "openai": OpenAIProvider, "google": GoogleProvider}
    return providers[config.provider](config, motherduck_token)

MODELS = {
    "claude-opus-4.5": ModelConfig.claude_opus(),
    "gpt-5.2": ModelConfig.gpt_5_2(),
    "gemini-3": ModelConfig.gemini_3(),
}

__all__ = ["BaseProvider", "ModelConfig", "EvalResult", "create_provider", "MODELS"]
```

---

## Phase 4: Schema Helper (src/schema_helper.py)

```python
import duckdb, os

def get_schema_info(db_id: str, motherduck_db: str = "bird_bench") -> str:
    conn = duckdb.connect(f"md:{motherduck_db}?motherduck_token={os.environ['MOTHERDUCK_TOKEN']}")
    tables = conn.execute(f"SELECT table_name FROM information_schema.tables WHERE table_schema='{db_id}'").fetchall()
    lines = [f"Database: {db_id}", "="*40]
    for (table,) in tables:
        lines.append(f"\nTABLE: {table}")
        cols = conn.execute(f"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='{db_id}' AND table_name='{table}'").fetchall()
        for col, dtype in cols:
            lines.append(f"  {col}: {dtype}")
    conn.close()
    return "\n".join(lines)
```

---

## Phase 5: Evaluation Runner (src/run_eval.py)

```python
import asyncio, json, os
from datetime import datetime
from pathlib import Path
import duckdb
from dotenv import load_dotenv
from providers import create_provider, ModelConfig, EvalResult, MODELS
from schema_helper import get_schema_info

class Evaluator:
    def __init__(self):
        load_dotenv()
        self.motherduck_token = os.environ["MOTHERDUCK_TOKEN"]
    
    def execute_gold_sql(self, sql: str, db_id: str):
        try:
            conn = duckdb.connect(f"md:bird_bench?motherduck_token={self.motherduck_token}")
            conn.execute(f"SET search_path = '{db_id}'")
            result = conn.execute(sql).fetchall()
            conn.close()
            return result
        except Exception as e:
            return f"ERROR: {e}"
    
    def compare_results(self, gold, predicted) -> bool:
        if not gold or not predicted or "ERROR" in str(gold) or "ERROR" in str(predicted):
            return False
        try:
            normalize = lambda r: tuple(round(v,6) if isinstance(v,float) else v for v in r)
            return set(normalize(r) for r in gold) == set(normalize(r) for r in predicted)
        except:
            return gold == predicted
    
    async def evaluate_question(self, q: dict, config: ModelConfig, schema_cache: dict) -> EvalResult:
        db_id = q["db_id"]
        if db_id not in schema_cache:
            schema_cache[db_id] = get_schema_info(db_id)
        
        provider = create_provider(config, self.motherduck_token)
        try:
            predicted_sql, meta = await provider.run_query(q["question"], q.get("evidence",""), db_id, schema_cache[db_id])
        finally:
            provider.close()
        
        gold_result = self.execute_gold_sql(q["SQL"], db_id)
        predicted_result = self.execute_gold_sql(predicted_sql, db_id) if predicted_sql and not meta.get("error") else None
        is_correct = self.compare_results(gold_result, predicted_result)
        
        return EvalResult(q["question_id"], db_id, q["question"], q.get("evidence",""), q["SQL"],
                          predicted_sql, gold_result, predicted_result, is_correct, meta.get("error"),
                          config, meta.get("input_tokens",0), meta.get("output_tokens",0),
                          meta.get("cost_usd",0), meta.get("duration_ms",0), meta.get("tool_calls",0))
    
    async def run_evaluation(self, questions: list, model_configs: list, max_concurrent: int = 3, output_dir: str = "data/results"):
        all_results, schema_cache = {}, {}
        
        for config in model_configs:
            model_name = f"{config.provider}/{config.model_id}"
            print(f"\n{'='*60}\nEvaluating: {model_name}\n{'='*60}")
            
            sem = asyncio.Semaphore(max_concurrent)
            async def run(q, i):
                async with sem:
                    print(f"  [{i+1}/{len(questions)}] Q{q['question_id']}...")
                    r = await self.evaluate_question(q, config, schema_cache)
                    print(f"    {'✓' if r.is_correct else '✗'} ${r.cost_usd:.4f}")
                    return r
            
            results = await asyncio.gather(*[run(q,i) for i,q in enumerate(questions)], return_exceptions=True)
            valid = [r for r in results if isinstance(r, EvalResult)]
            all_results[model_name] = valid
            
            correct = sum(1 for r in valid if r.is_correct)
            print(f"\n{model_name}: {correct}/{len(valid)} ({correct/len(valid)*100:.1f}%)")
        
        self._save_results(all_results, questions, output_dir)
        return all_results
    
    def _save_results(self, all_results, questions, output_dir):
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        summary = {"timestamp": ts, "num_questions": len(questions), "models": {}}
        for model, results in all_results.items():
            correct = sum(1 for r in results if r.is_correct)
            summary["models"][model] = {
                "accuracy_percent": correct/len(results)*100 if results else 0,
                "correct": correct, "total": len(results),
                "total_cost_usd": sum(r.cost_usd for r in results)
            }
            with open(f"{output_dir}/results_{model.replace('/','_')}_{ts}.json", "w") as f:
                json.dump({"model": model, "results": [{"question_id": r.question_id, "is_correct": r.is_correct,
                           "predicted_sql": r.predicted_sql, "error": r.error} for r in results]}, f, indent=2)
        
        with open(f"{output_dir}/summary_{ts}.json", "w") as f:
            json.dump(summary, f, indent=2)
        
        print(f"\n{'='*70}\nMODEL COMPARISON\n{'='*70}")
        print(f"{'Model':<35} {'Accuracy':>12} {'Cost':>10}")
        for m, s in sorted(summary["models"].items(), key=lambda x: x[1]["accuracy_percent"], reverse=True):
            print(f"{m:<35} {s['accuracy_percent']:>11.1f}% ${s['total_cost_usd']:>8.2f}")

async def main():
    import sys
    with open("data/bird_challenging_100.json") as f:
        questions = json.load(f)
    
    limit, models_to_run = None, list(MODELS.keys())
    for arg in sys.argv[1:]:
        if arg.isdigit(): limit = int(arg)
        elif arg in MODELS: models_to_run = [arg]
    
    if limit: questions = questions[:limit]
    print(f"Questions: {len(questions)}, Models: {models_to_run}")
    
    await Evaluator().run_evaluation(questions, [MODELS[m] for m in models_to_run])

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Phase 6: Running

```bash
# Setup
pip install anthropic openai google-genai duckdb datasets python-dotenv

# Prepare data
python src/data_prep.py
python src/load_to_motherduck.py

# Test single model
python src/run_eval.py 5 claude-opus-4.5

# Run all models
python src/run_eval.py
```

---

## Cost Estimates

| Model | Per Question | 100 Questions |
|-------|--------------|---------------|
| Claude Opus 4.5 | ~$0.12 | ~$12 |
| GPT-5.2 | ~$0.08 | ~$8 |
| Gemini 3 | ~$0.05 | ~$5 |

**Total for 3-model eval: ~$25**

---

## Adding Models

```python
# In src/providers/__init__.py
MODELS["claude-sonnet"] = ModelConfig(
    provider="anthropic",
    model_id="claude-sonnet-4-5-20250929",
    api_key=os.environ.get("ANTHROPIC_API_KEY"),
    input_price_per_million=3.0,
    output_price_per_million=15.0
)
```
