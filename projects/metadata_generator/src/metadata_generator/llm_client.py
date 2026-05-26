"""
Shared LLM client configuration for OpenRouter.

Provides a single source of truth for OpenRouter client initialization
used by MetadataGenerator and SQLToTextGenerator.
"""

import os

from openai import OpenAI

from metadata_generator.config import (
    OPENROUTER_BASE_URL,
    DEFAULT_LLM_MODEL,
    HTTP_REFERER,
    APP_TITLE,
)


def create_openrouter_client(
    api_key: str | None = None,
) -> OpenAI:
    """
    Create a configured OpenAI client for OpenRouter.

    Args:
        api_key: OpenRouter API key. Falls back to OPENROUTER_API_KEY env var.

    Returns:
        Configured OpenAI client

    Raises:
        ValueError: If no API key is provided or found in environment
    """
    api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError(
            "OPENROUTER_API_KEY not set. "
            "Provide api_key parameter or set OPENROUTER_API_KEY environment variable."
        )

    return OpenAI(
        base_url=OPENROUTER_BASE_URL,
        api_key=api_key,
        default_headers={
            "HTTP-Referer": HTTP_REFERER,
            "X-Title": APP_TITLE,
        },
    )


def get_model(model: str | None = None) -> str:
    """
    Get the model to use, with fallback to default.

    Args:
        model: Requested model name, or None for default

    Returns:
        Model name to use
    """
    return model or DEFAULT_LLM_MODEL
