"""Tests for persistence module."""

import pytest
from pathlib import Path
from metadata_generator.persistence import (
    InMemoryFileSystem,
    RealFileSystem,
    save_json,
    load_json,
)


class MockSerializable:
    """Mock object that implements Serializable protocol."""

    def __init__(self, data: dict):
        self._data = data

    def to_dict(self) -> dict:
        return self._data

    @classmethod
    def from_dict(cls, data: dict) -> "MockSerializable":
        return cls(data)


class TestInMemoryFileSystem:
    """Tests for InMemoryFileSystem."""

    def test_write_and_read_json(self):
        """Test writing and reading JSON data."""
        fs = InMemoryFileSystem()
        path = Path("/test/output/data.json")
        data = {"key": "value", "nested": {"a": 1}}

        fs.write_json(path, data)
        result = fs.read_json(path)

        assert result == data

    def test_read_nonexistent_returns_none(self):
        """Test that reading nonexistent file returns None."""
        fs = InMemoryFileSystem()
        result = fs.read_json(Path("/nonexistent/file.json"))
        assert result is None

    def test_exists_after_write(self):
        """Test that path exists after writing."""
        fs = InMemoryFileSystem()
        path = Path("/test/file.json")

        assert not fs.exists(path)
        fs.write_json(path, {"test": True})
        assert fs.exists(path)

    def test_ensure_dir_marks_as_existing(self):
        """Test that ensure_dir marks directory as existing."""
        fs = InMemoryFileSystem()
        path = Path("/test/subdir")

        assert not fs.exists(path)
        fs.ensure_dir(path)
        assert fs.exists(path)

    def test_write_creates_parent_directories(self):
        """Test that write creates parent directories."""
        fs = InMemoryFileSystem()
        path = Path("/deep/nested/path/file.json")

        fs.write_json(path, {"test": True})
        assert fs.exists(path.parent)


class TestSaveJsonWithFileSystem:
    """Tests for save_json with injectable FileSystem."""

    def test_save_to_in_memory_fs(self):
        """Test saving to in-memory file system."""
        fs = InMemoryFileSystem()
        obj = MockSerializable({"name": "test", "value": 42})

        result_path = save_json(obj, "/output", "test.json", fs=fs)

        assert result_path == Path("/output/test.json")
        assert fs.exists(result_path)
        assert fs.read_json(result_path) == {"name": "test", "value": 42}

    def test_uses_default_fs_when_not_provided(self, tmp_path):
        """Test that real filesystem is used by default."""
        obj = MockSerializable({"data": "value"})
        output_dir = str(tmp_path / "test_output")

        result_path = save_json(obj, output_dir, "real.json")

        assert result_path.exists()
        assert result_path.read_text() != ""


class TestLoadJsonWithFileSystem:
    """Tests for load_json with injectable FileSystem."""

    def test_load_from_in_memory_fs(self):
        """Test loading from in-memory file system."""
        fs = InMemoryFileSystem()
        path = Path("/test/data.json")
        fs.write_json(path, {"name": "test", "value": 42})

        result = load_json(MockSerializable, path, fs=fs)

        assert result is not None
        assert result.to_dict() == {"name": "test", "value": 42}

    def test_load_nonexistent_returns_none(self):
        """Test that loading nonexistent file returns None."""
        fs = InMemoryFileSystem()
        result = load_json(MockSerializable, Path("/nonexistent.json"), fs=fs)
        assert result is None

    def test_roundtrip_through_in_memory_fs(self):
        """Test save then load roundtrip."""
        fs = InMemoryFileSystem()
        original = MockSerializable({"complex": {"nested": [1, 2, 3]}})

        save_json(original, "/test", "data.json", fs=fs)
        loaded = load_json(MockSerializable, Path("/test/data.json"), fs=fs)

        assert loaded is not None
        assert loaded.to_dict() == original.to_dict()
