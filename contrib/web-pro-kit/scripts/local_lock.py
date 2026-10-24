#!/usr/bin/env python3
"""A lock on this computer for one synced target, so agents running side by side never publish it at once.

The lock file lives under `$VOYAGER_HOME/locks/web-pro-kit/` (else `~/.voyager/...`), never in the synced
folder, and the system frees it when its process ends, so a crash leaves nothing to clean up.
"""
from __future__ import annotations

import contextlib
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
from unittest.mock import patch

POLL_SECONDS = 0.2


def lock_dir() -> Path:
    base = Path(os.environ["VOYAGER_HOME"]) if os.environ.get("VOYAGER_HOME") else Path.home() / ".voyager"
    return base / "locks" / "web-pro-kit"


def _private_lock_dir() -> Path:
    """The lock folder, created 0700 like `~/.voyager` itself: its file names come from local paths."""
    directory = lock_dir()
    for path in (directory.parent.parent, directory.parent, directory):
        path.mkdir(mode=0o700, exist_ok=True)
    if os.name != "nt":
        for path in (directory.parent, directory):
            os.chmod(path, 0o700)  # also one an earlier kit created with the default mode
    return directory


def _try_lock(handle) -> bool:
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return False
        return True
    import fcntl
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    return True


def _unlock(handle) -> None:
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def held(target: Path, label: str, timeout: float):
    """Run the block while this process alone holds `target` (a REQUEST.md, a mirror folder)."""
    directory = _private_lock_dir()
    key = hashlib.sha256(str(Path(target).resolve()).encode("utf-8")).hexdigest()[:24]
    with open(directory / f"{key}.lock", "a+b") as handle:
        started, told = time.monotonic(), False
        while not _try_lock(handle):
            if time.monotonic() - started >= timeout:
                raise TimeoutError(f"another {label} of {target} has run for over {timeout:g}s; try again later")
            if not told:
                print(f"Waiting for another {label} of {target} to finish...", file=sys.stderr, flush=True)
                told = True
            time.sleep(POLL_SECONDS)
        try:
            yield
        finally:
            _unlock(handle)


def selftest() -> int:
    checks = 0
    with tempfile.TemporaryDirectory(prefix="local-lock-test-") as td, patch.dict(os.environ, {"VOYAGER_HOME": td}):
        target = Path(td) / "Voyager-workspace" / "task" / "REQUEST.md"
        inside, release = threading.Event(), threading.Event()

        def holder():
            with held(target, "request", timeout=5):
                inside.set()
                release.wait(5)
        thread = threading.Thread(target=holder)
        thread.start()
        assert inside.wait(5)
        try:
            with held(target, "request", timeout=0.3):
                raise AssertionError("a second holder got in")
        except TimeoutError as error:
            assert "another request" in str(error)
            checks += 1
        with held(Path(td) / "other" / "REQUEST.md", "request", timeout=0.3):
            checks += 1  # another target is not held up
        release.set()
        thread.join(5)
        with held(target, "request", timeout=1):
            checks += 1
        assert list(lock_dir().glob("*.lock")) and not target.parent.exists()
        checks += 1  # the lock stays local, out of the synced folder
        if os.name != "nt":
            assert all(stat.S_IMODE(p.stat().st_mode) == 0o700 for p in (lock_dir(), lock_dir().parent))
            checks += 1  # only this user can list the lock folder
    print(f"selftest PASS: {checks} checks")
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if sys.argv[1:] == ["--selftest"]:
        sys.exit(selftest())
    print(__doc__)
