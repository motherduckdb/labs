"""Small shared runtime helpers used across packages."""

import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None


@dataclass(frozen=True)
class LockedFile:
    handle: IO[str]
    wait_ms: int


@contextmanager
def locked_file(
    path: Path,
    *,
    mode: str = "a+",
    encoding: str = "utf-8",
    timeout_sec: float | None = None,
    poll_interval_sec: float = 0.1,
) -> Iterator[LockedFile]:
    """Open a file and hold an exclusive advisory lock for the context."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, mode, encoding=encoding) as handle:
        wait_start = time.monotonic()
        if fcntl is not None:
            if timeout_sec is None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            else:
                deadline = wait_start + timeout_sec
                while True:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError(f"Timed out waiting for lock on {path} after {timeout_sec:.1f}s")
                        time.sleep(min(poll_interval_sec, remaining))

        try:
            yield LockedFile(
                handle=handle,
                wait_ms=int((time.monotonic() - wait_start) * 1000),
            )
        finally:
            handle.flush()
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
