import os
from .base import BaseProvider, ModelConfig, EvalResult, SQL_TOOL_DEFINITION, CorrectnessLevel
from .openrouter import OpenRouterProvider

def create_provider(config: ModelConfig, motherduck_token: str, use_optimized_prompts: bool = False, shared_mcp_client=None) -> BaseProvider:
    """Factory function to create a provider instance."""
    return OpenRouterProvider(config, motherduck_token, use_optimized_prompts, shared_mcp_client)

# Meta-optimized models (60%+ accuracy from GEPA) - now the default
MODELS = {
    "gemini-flash-3": ModelConfig.gemini_flash_3_optimized(),
    "claude-opus-4.5": ModelConfig.claude_opus_optimized(),
    "gpt-5.2": ModelConfig.gpt_5_2_optimized(),
}

__all__ = ["BaseProvider", "ModelConfig", "EvalResult", "CorrectnessLevel", "create_provider", "MODELS", "SQL_TOOL_DEFINITION"]
