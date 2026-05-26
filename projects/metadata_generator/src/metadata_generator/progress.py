"""
Progress reporting utilities.

Provides a callback-based progress system to separate computation
from output, making functions more testable and reusable.
"""

from typing import Protocol


class ProgressCallback(Protocol):
    """Protocol for progress reporting callbacks."""

    def __call__(self, message: str) -> None:
        """Report a progress message."""
        ...


def print_progress(message: str) -> None:
    """Default progress callback that prints to stdout."""
    print(f"  {message}")


class ProgressReporter:
    """
    Progress reporter that can be enabled/disabled.

    Useful for wrapping verbose output in a consistent way.
    """

    def __init__(self, callback: ProgressCallback | None = None, enabled: bool = True):
        """
        Initialize reporter.

        Args:
            callback: Progress callback function. Defaults to print_progress.
            enabled: Whether to actually report progress.
        """
        self._callback = callback or print_progress
        self._enabled = enabled

    def report(self, message: str) -> None:
        """Report progress if enabled."""
        if self._enabled:
            self._callback(message)

    def __call__(self, message: str) -> None:
        """Shorthand for report()."""
        self.report(message)
