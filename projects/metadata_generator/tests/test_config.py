"""Tests for config module."""

import pytest
from metadata_generator.config import (
    AppConfig,
    ConfigProvider,
    EnvConfigProvider,
)


class DictConfigProvider:
    """Test config provider that uses a dict."""

    def __init__(self, values: dict[str, str]):
        self._values = values

    def get(self, key: str, default: str | None = None) -> str | None:
        return self._values.get(key, default)


class TestEnvConfigProvider:
    """Tests for EnvConfigProvider."""

    def test_gets_from_environment(self, monkeypatch):
        """Test that EnvConfigProvider reads from os.environ."""
        monkeypatch.setenv("TEST_KEY", "test_value")
        provider = EnvConfigProvider()
        assert provider.get("TEST_KEY") == "test_value"

    def test_returns_default_when_missing(self, monkeypatch):
        """Test that missing keys return default."""
        monkeypatch.delenv("MISSING_KEY", raising=False)
        provider = EnvConfigProvider()
        assert provider.get("MISSING_KEY") is None
        assert provider.get("MISSING_KEY", "default") == "default"


class TestAppConfig:
    """Tests for AppConfig dataclass."""

    def test_from_env_with_all_values(self):
        """Test loading config with all required values."""
        provider = DictConfigProvider({
            "MOTHERDUCK_TOKEN": "md-token",
            "OPENROUTER_API_KEY": "openrouter-key",
            "GOOGLE_API_KEY": "google-key",
        })
        config = AppConfig.from_env(provider)

        assert config.motherduck_token == "md-token"
        assert config.openrouter_api_key == "openrouter-key"
        assert config.google_api_key == "google-key"

    def test_from_env_missing_motherduck_token_raises(self):
        """Test that missing MOTHERDUCK_TOKEN raises ValueError."""
        provider = DictConfigProvider({})

        with pytest.raises(ValueError, match="MOTHERDUCK_TOKEN not set"):
            AppConfig.from_env(provider)

    def test_from_env_missing_openrouter_when_required_raises(self):
        """Test that missing OPENROUTER_API_KEY raises when required."""
        provider = DictConfigProvider({
            "MOTHERDUCK_TOKEN": "md-token",
        })

        with pytest.raises(ValueError, match="OPENROUTER_API_KEY not set"):
            AppConfig.from_env(provider, require_openrouter=True)

    def test_from_env_missing_openrouter_when_not_required(self):
        """Test that missing OPENROUTER_API_KEY is allowed by default."""
        provider = DictConfigProvider({
            "MOTHERDUCK_TOKEN": "md-token",
        })
        config = AppConfig.from_env(provider)

        assert config.openrouter_api_key is None

    def test_default_values(self):
        """Test that defaults are set correctly."""
        config = AppConfig(motherduck_token="token")

        assert config.default_database == "bird_bench"

    def test_direct_construction_for_testing(self):
        """Test that AppConfig can be constructed directly for tests."""
        config = AppConfig(
            motherduck_token="fake-token",
            openrouter_api_key="fake-key",
            default_database="test_db",
        )

        assert config.motherduck_token == "fake-token"
        assert config.openrouter_api_key == "fake-key"
        assert config.default_database == "test_db"
