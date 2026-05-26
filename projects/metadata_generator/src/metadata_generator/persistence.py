"""
Persistence utilities for JSON serialization.

Provides shared save/load functions to eliminate duplicated I/O patterns
across profiler, generator, history, and translator modules.

Also provides FileSystem abstraction for testability.
"""

import json
import logging
from pathlib import Path
from typing import Protocol, Type, TypeVar

logger = logging.getLogger(__name__)


class Serializable(Protocol):
    """Protocol for objects that can be serialized to/from dict."""

    def to_dict(self) -> dict:
        """Convert object to dictionary."""
        ...

    @classmethod
    def from_dict(cls, data: dict) -> "Serializable":
        """Create object from dictionary."""
        ...


T = TypeVar("T", bound=Serializable)


# ============================================================================
# FileSystem Abstraction
# ============================================================================

class FileSystem(Protocol):
    """Protocol for file system operations.

    Implement this to provide alternative storage backends or
    in-memory implementations for testing.
    """

    def write_json(self, path: Path, data: dict) -> None:
        """Write JSON data to a file."""
        ...

    def write_text(self, path: Path, text: str) -> None:
        """Write text data to a file."""
        ...

    def read_json(self, path: Path) -> dict | None:
        """Read JSON data from a file. Returns None if file doesn't exist."""
        ...

    def ensure_dir(self, path: Path) -> None:
        """Ensure a directory exists, creating it if needed."""
        ...

    def exists(self, path: Path) -> bool:
        """Check if a path exists."""
        ...


class RealFileSystem:
    """File system implementation using real disk I/O."""

    def write_json(self, path: Path, data: dict) -> None:
        """Write JSON data to a file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=2, default=str)

    def write_text(self, path: Path, text: str) -> None:
        """Write text data to a file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def read_json(self, path: Path) -> dict | None:
        """Read JSON data from a file. Returns None if file doesn't exist or is malformed."""
        if not path.exists():
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError):
            logger.warning(f"Malformed JSON in {path}, skipping")
            return None

    def ensure_dir(self, path: Path) -> None:
        """Ensure a directory exists, creating it if needed."""
        path.mkdir(parents=True, exist_ok=True)

    def exists(self, path: Path) -> bool:
        """Check if a path exists."""
        return path.exists()


class InMemoryFileSystem:
    """In-memory file system for testing - no real file I/O."""

    def __init__(self):
        self.files: dict[Path, dict] = {}
        self.directories: set[Path] = set()

    def write_json(self, path: Path, data: dict) -> None:
        """Write JSON data to in-memory storage."""
        self.ensure_dir(path.parent)
        self.files[path] = data

    def write_text(self, path: Path, text: str) -> None:
        """Write text data to in-memory storage."""
        self.ensure_dir(path.parent)
        self.files[path] = text

    def read_json(self, path: Path) -> dict | None:
        """Read JSON data from in-memory storage."""
        return self.files.get(path)

    def ensure_dir(self, path: Path) -> None:
        """Record directory as existing."""
        self.directories.add(path)

    def exists(self, path: Path) -> bool:
        """Check if path exists in memory."""
        return path in self.files or path in self.directories


# Default file system instance
_default_fs: FileSystem = RealFileSystem()


def save_json(
    obj: Serializable,
    output_dir: str,
    filename: str,
    fs: FileSystem | None = None,
) -> Path:
    """
    Save a serializable object to JSON.

    Args:
        obj: Object with to_dict() method
        output_dir: Directory to save to (created if needed)
        filename: Name of the JSON file
        fs: FileSystem implementation. Defaults to RealFileSystem.

    Returns:
        Path to the saved file
    """
    fs = fs or _default_fs
    output_path = Path(output_dir) / filename
    fs.write_json(output_path, obj.to_dict())
    return output_path


def load_json(
    cls: Type[T],
    filepath: Path,
    fs: FileSystem | None = None,
) -> T | None:
    """
    Load a serializable object from JSON.

    Args:
        cls: Class with from_dict() class method
        filepath: Path to the JSON file
        fs: FileSystem implementation. Defaults to RealFileSystem.

    Returns:
        Deserialized object or None if file doesn't exist
    """
    fs = fs or _default_fs
    data = fs.read_json(filepath)
    if data is None:
        return None
    return cls.from_dict(data)
