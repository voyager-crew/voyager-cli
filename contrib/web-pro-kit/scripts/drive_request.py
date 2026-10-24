#!/usr/bin/env python3
"""Append a numbered request to a task's synced REQUEST.md."""
from __future__ import annotations

import argparse
import datetime as dt
from pathlib import Path
import re
import sys
import tempfile
from unittest.mock import patch
import threading
from kit_config import load_config, workspace_root
from local_lock import held
import safe_files

# Agents dispatching side by side may steer the same task; each waits its turn this long.
LOCK_TIMEOUT = 120

HEAD_RE = re.compile(r"^Version: (\d+)", re.M)


def request_path(workspace: Path, tag: str) -> Path:
    if not tag or tag in {".", ".."} or any(ch in tag for ch in "/\\:"):
        raise ValueError("Use a single task folder name")
    return workspace / tag / "REQUEST.md"


def append(request: Path, body: str) -> int:
    # Two writers reading the same version would both publish N+1 and one request would be lost.
    with held(request, "request", LOCK_TIMEOUT):
        return _append(request, body)


def _append(request: Path, body: str) -> int:
    # utf-8-sig: a BOM added by a Windows editor would hide "Version:" and restart the count at 1.
    old = request.read_text(encoding="utf-8-sig") if request.exists() else ""
    match = HEAD_RE.search(old)
    version = int(match.group(1)) + 1 if match else 1
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    entries = old.split("\n## ", 1)[1] if "\n## " in old else ""
    head = f"Version: {version}\nUpdated: {now}\n\nLater requests take precedence.\n"
    new_entry = f"## Request {version} ({now})\n\n{body.strip()}\n"
    text = head + ("\n## " + entries.rstrip() + "\n" if entries else "") + "\n" + new_entry
    request.parent.mkdir(parents=True, exist_ok=True)
    try:
        safe_files.write_atomic(request, text.encode("utf-8"), prefix=".request-")
    except OSError as error:
        raise OSError(f"request {version} was not published; {request.name} stayed unchanged ({error})") from error
    return version


def selftest() -> int:
    with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"VOYAGER_HOME": temporary}):
        workspace = Path(temporary)
        request = request_path(workspace, "sample-task")
        assert append(request, "First") == 1
        assert append(request, "Second") == 2
        assert append(request, "Third") == 3
        text = request.read_text(encoding="utf-8")
        assert text.startswith("Version: 3")
        assert text.index("First") < text.index("Second") < text.index("Third")
        assert text.count("## Request ") == 3
        for tag in ("../other-task", "/other-task"):
            try:
                request_path(workspace, tag)
            except ValueError:
                pass
            else:
                raise AssertionError("Expected a single task folder name")
        bom = request_path(workspace, "bom-task")
        bom.parent.mkdir()
        bom.write_bytes("\ufeffVersion: 9\nUpdated: x\n\n## Request 9 (x)\n\nNine\n".encode("utf-8"))
        assert append(bom, "Ten") == 10
        assert bom.read_text(encoding="utf-8").startswith("Version: 10") and "Nine" in bom.read_text(encoding="utf-8")

        def locked(src, dst):
            raise PermissionError(32, "in use")
        before = bom.read_bytes()
        with patch.object(safe_files, "REPLACE_DELAY", 0), patch("os.replace", locked):
            try:
                append(bom, "Eleven")
            except OSError as error:
                assert "not published" in str(error)
            else:
                raise AssertionError("Expected a failed publish")
        assert bom.read_bytes() == before
        assert sorted(p.name for p in bom.parent.iterdir()) == ["REQUEST.md"]

        # Two agents append at once: a slow read would let both see version N without the lock.
        shared = request_path(workspace, "shared-task")
        real_read = Path.read_text

        def slow_read(self, *args, **kwargs):
            text = real_read(self, *args, **kwargs)
            threading.Event().wait(0.05)
            return text
        with patch.object(Path, "read_text", slow_read):
            append(shared, "Base")
            writers = [threading.Thread(target=append, args=(shared, f"Agent {n}")) for n in (1, 2)]
            for writer in writers:
                writer.start()
            for writer in writers:
                writer.join()
        text = shared.read_text(encoding="utf-8")
        assert text.startswith("Version: 3") and "Agent 1" in text and "Agent 2" in text, text
    print("selftest PASS: 14 checks")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", nargs="?")
    parser.add_argument("text", nargs="?")
    parser.add_argument("--file", type=Path)
    parser.add_argument("--show", action="store_true")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.tag:
        parser.error("provide a task ID")
    try:
        request = request_path(workspace_root(load_config(args.config)), args.tag)
        if args.show:
            print(request.read_text(encoding="utf-8") if request.exists() else "(No requests yet)")
            return 0
        body = args.file.read_text(encoding="utf-8-sig") if args.file else (args.text or "")
        if not body.strip():
            parser.error("provide request text or --file")
        version = append(request, body)
        print(f"Wrote {request} (version {version}); read at the next checkpoint after sync.")
        return 0
    except (OSError, ValueError) as error:
        parser.exit(2, f"error: {error}\n")


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())
