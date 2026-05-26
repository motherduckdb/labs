#!/usr/bin/env python
"""
File descriptor monitor for evaluation runs.

Usage:
    python src/fd_monitor.py <pid>

Or wrap the evaluation:
    python src/fd_monitor.py --wrap "uv run python -m eval.cli train --models gemini-3-flash --limit 70"
"""

import os
import sys
import time
import subprocess
import threading
from pathlib import Path


def count_fds(pid: int) -> int | None:
    """Count open file descriptors for a process."""
    try:
        # macOS/Linux
        fd_dir = Path(f"/proc/{pid}/fd")
        if fd_dir.exists():
            return len(list(fd_dir.iterdir()))

        # macOS fallback using lsof
        result = subprocess.run(
            ["lsof", "-p", str(pid)],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return len(result.stdout.strip().split('\n')) - 1  # -1 for header
        return None
    except Exception as e:
        return None


def monitor_process(pid: int, interval: float = 2.0, stop_event: threading.Event = None):
    """Monitor file descriptors of a process."""
    max_fds = 0
    samples = []

    print(f"Monitoring PID {pid} for file descriptors...")
    print(f"{'Time':<10} {'FDs':>6} {'Max':>6}")
    print("-" * 24)

    start_time = time.time()

    while True:
        if stop_event and stop_event.is_set():
            break

        fds = count_fds(pid)
        if fds is None:
            # Process might have ended
            if stop_event:
                break
            time.sleep(interval)
            continue

        max_fds = max(max_fds, fds)
        elapsed = time.time() - start_time
        samples.append((elapsed, fds))

        print(f"{elapsed:>8.1f}s {fds:>6} {max_fds:>6}")

        time.sleep(interval)

    print("-" * 24)
    print(f"Max FDs observed: {max_fds}")
    print(f"Samples collected: {len(samples)}")

    return max_fds, samples


def run_with_monitoring(command: str):
    """Run a command and monitor its file descriptors."""
    print(f"Running: {command}")
    print()

    # Start the process
    proc = subprocess.Popen(
        command,
        shell=True,
        stdout=sys.stdout,
        stderr=sys.stderr
    )

    # Monitor in background
    stop_event = threading.Event()
    monitor_thread = threading.Thread(
        target=monitor_process,
        args=(proc.pid, 5.0, stop_event)
    )
    monitor_thread.start()

    # Wait for process to complete
    proc.wait()

    # Stop monitoring
    stop_event.set()
    monitor_thread.join()

    return proc.returncode


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--wrap":
        if len(sys.argv) < 3:
            print("Usage: python src/fd_monitor.py --wrap \"command\"")
            sys.exit(1)
        command = sys.argv[2]
        sys.exit(run_with_monitoring(command))
    else:
        pid = int(sys.argv[1])
        monitor_process(pid)
