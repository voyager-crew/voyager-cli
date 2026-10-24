#!/usr/bin/env python3
"""Mirror committed Git text and optional binary assets to a local sync folder.
Use push/status --repo PATH --name NAME [--config FILE] [--out DIR].
Push accepts --assets, --force and --report FILE (a local list of files kept back).
"""
from __future__ import annotations
import argparse
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch
import mirror_build
from mirror_build import build, commit_files, git, repo_root
from mirror_manifest import build_manifest, layer_ok, new_layer, policy_fingerprint, print_summary, read_mirror, write_report
from redaction import Redactor, local_identities
from safe_files import copy_atomic, inside, safe_segment, write_atomic
from kit_config import load_config, workspace_root
from local_lock import held

# A push of one mirror waits this long for another push of it to finish.
LOCK_TIMEOUT = 1800

NAME_RE_T = r"^{p}-(?:text|bin)(?:-\d+of\d+)?\.zip$"


def mirror_dir(repo: Path, name: str | None = None, settings: dict | None = None) -> Path:
    parent = workspace_root(settings) / "repos"
    return inside(parent, parent / safe_segment(repo.name if name is None else name, "--name"), "mirror folder")


def push(repo: Path, name: str | None, assets: bool, force: bool, out_dir: Path | None,
         settings: dict | None = None, identities: list[str] | None = None, report: Path | None = None) -> int:
    root = repo_root(repo)
    label = safe_segment(root.name if name is None else name, "--name")
    settings = load_config() if settings is None else settings
    dest = Path(out_dir) if out_dir is not None else mirror_dir(root, label, settings)
    # Two pushes of one mirror at once would each delete the volumes the other just wrote
    # and leave a MIRROR.json that names the wrong archives.
    with held(dest, "mirror push", LOCK_TIMEOUT):
        return _push(root, label, assets, force, dest, settings, identities, report)


def _push(repo: Path, name: str | None, assets: bool, force: bool, out_dir: Path | None,
          settings: dict | None = None, identities: list[str] | None = None, report: Path | None = None) -> int:
    repo = repo_root(repo)
    name = safe_segment(repo.name if name is None else name, "--name")
    settings = load_config() if settings is None else settings
    dest = Path(out_dir) if out_dir is not None else mirror_dir(repo, name, settings)
    if report is not None and Path(report).resolve().is_relative_to(dest.resolve()):
        raise ValueError("--report must be outside the mirror folder; it lists private paths and must stay local")
    dest.mkdir(parents=True, exist_ok=True)
    head = git(repo, "rev-parse", "HEAD").strip()
    prev = read_mirror(dest)
    if prev and prev.get("project") != name:
        raise ValueError("Destination contains another project's MIRROR.json; choose a separate --out")
    layers = prev.get("layers", {})
    red = Redactor(local_identities(repo) if identities is None else identities, settings.get("redact", []))
    policy = policy_fingerprint(red)
    policy_changed = prev.get("redaction_policy") != policy
    text_layer, bin_layer = layers.get("text") or {}, layers.get("bin") or {}
    need_text = force or policy_changed or text_layer.get("commit") != head or not layer_ok(dest, text_layer)
    need_bin = assets and (force or policy_changed or bin_layer.get("commit") != head or not layer_ok(dest, bin_layer))
    dirty = len(git(repo, "status", "--porcelain").splitlines())
    if not need_text and not need_bin:
        kept_back = len(prev.get("excluded_files") or [])
        print(f"Up to date: {dest} at {head[:10]}; {dirty} uncommitted changes excluded"
              + (f"; {kept_back} files not uploaded (see MIRROR.json; --force rebuilds the list)" if kept_back else ""))
        if report is not None:
            print("No --report written: nothing was rebuilt; add --force to rebuild and report")
        return 0
    with tempfile.TemporaryDirectory(prefix="drive-mirror-") as td:
        result = build(repo, name, head, Path(td), red, want_text=need_text, want_bin=need_bin)
        layers = dict(layers)
        writes = []
        if policy_changed and not assets:
            layers.pop("bin", None)
        if need_text:
            layers["text"] = new_layer([result["text_zip"]], head, result["text_count"])
            writes.append(result["text_zip"])
        old_bin = layers.get("bin")
        if need_bin and not force and old_bin and old_bin.get("fingerprint") == result["bin_fingerprint"] and layer_ok(dest, old_bin):
            layers["bin"] = dict(old_bin, commit=head)
            print("Binary content unchanged; retaining existing volumes")
        elif need_bin:
            layers["bin"] = new_layer(result["bin_zips"], head, result["bin_count"], fingerprint=result["bin_fingerprint"])
            writes.extend(result["bin_zips"])
        if layers.get("bin"):
            layers["bin"]["same_as_text_commit"] = layers["bin"].get("fingerprint") == result["bin_fingerprint"]
        owned = re.compile(NAME_RE_T.format(p=re.escape(name)))
        for item in writes:
            # Written beside the target, checked, then swapped in: readers never see half an archive.
            copy_atomic(item, inside(dest, dest / item.name, "archive"))
        keep = {filename for layer in layers.values() for filename in layer["files"]}
        for item in dest.iterdir():
            if item.is_file() and owned.fullmatch(item.name) and item.name not in keep:
                item.unlink()
        manifest = build_manifest(name, head, result, policy, layers, dirty, prev, need_text)
        # This is the final published file, after archive read-back and stale-volume cleanup.
        write_atomic(dest / "MIRROR.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print_summary(result)
    if report is not None:
        write_report(Path(report), name, head, dest, result)
    print(f"Mirrored {head[:10]} to {dest}; wrote {len(writes)} archives; {dirty} uncommitted changes excluded")
    return 0


def status(repo: Path, name: str | None, out_dir: Path | None = None, settings: dict | None = None) -> int:
    repo = repo_root(repo)
    name = safe_segment(repo.name if name is None else name, "--name")
    dest = Path(out_dir) if out_dir is not None else mirror_dir(repo, name, settings)
    head = git(repo, "rev-parse", "HEAD").strip()
    manifest = read_mirror(dest)
    layer = (manifest.get("layers") or {}).get("text") or {}
    ok = manifest.get("project") == name and layer.get("commit") == head and layer_ok(dest, layer)
    print(f"{dest}: {'up to date' if ok else 'missing, outdated, or damaged'}; HEAD {head[:10]}")
    binary = (manifest.get("layers") or {}).get("bin")
    if binary and (binary.get("same_as_text_commit") is False or not layer_ok(dest, binary)):
        print("Binary layer differs or is damaged; use push --assets")
    return 0 if ok else 1


def _selftest_export(root: Path) -> bool:
    repo, output, unpacked = root / "kit-source", root / "镜像", root / "unpacked"
    shutil.copytree(Path(__file__).resolve().parents[1], repo,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for args in (("init", "-q"), ("config", "user.email", "test@example.invalid"),
                 ("config", "user.name", "Sample Test"), ("add", "."), ("commit", "-qm", "sample")):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
    config = root / "kit-config.json"
    config.write_text("{}", encoding="utf-8")
    temporary = root / "临时文件"
    temporary.mkdir()
    # Child selftests exercise the exported scripts once, without nesting another export.
    env = dict(os.environ, VOYAGER_WEB_PRO_SELFTEST_CHILD="1", PYTHONIOENCODING="gbk",
               PYTHONUTF8="0", TEMP=str(temporary), TMP=str(temporary))
    result = subprocess.run(
        [sys.executable, "-B", str(Path(__file__).resolve()), "push", "--repo", str(repo),
         "--name", "kit", "--out", str(output), "--config", str(config)],
        env=env, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stdout + result.stderr
    with zipfile.ZipFile(output / "kit-text.zip") as archive:
        archive.extractall(unpacked)
    scripts = sorted(unpacked.rglob("*.py"))
    for script in scripts:
        result = subprocess.run([sys.executable, "-B", str(script), "--selftest"], env=env,
                                capture_output=True, text=True, encoding="utf-8")
        assert result.returncode == 0, f"{script.name}:\n{result.stdout}\n{result.stderr}"
    print(f"Export selftest PASS: {len(scripts)} scripts")
    return True



def _expect_error(action, *needles) -> int:
    try:
        action()
    except ValueError as exc:
        assert all(n in str(exc) for n in needles), str(exc)
        return 1
    raise AssertionError(f"expected an error mentioning {needles}")


def selftest() -> int:
    checks = 0
    def check(value, label=""):
        nonlocal checks
        assert value, label
        checks += 1
    saved_chunk = mirror_build.CHUNK
    try:
        # Its own VOYAGER_HOME: the push locks of a selftest never touch the real ~/.voyager.
        with tempfile.TemporaryDirectory(prefix="drive-mirror-test-") as td, patch.dict(os.environ, {"VOYAGER_HOME": td}):
            root = Path(td)
            repo = root / "sample"
            (repo / "src").mkdir(parents=True)
            def run(*args, at=repo):
                subprocess.run(["git", "-C", str(at), *args], check=True, capture_output=True)
            run("init", "-q")
            run("config", "user.email", "test@example.invalid")
            run("config", "user.name", "Sample Test")
            key_begin = "-----BEGIN " + "RSA PRIVATE KEY-----"
            key_end = "-----END " + "RSA PRIVATE KEY-----"
            email = "me@" + "example.com"
            secret = "abcdefgh" + "ijklmnop"
            access_key = "AKIA" + "0123456789ABCDEF"
            pw = "PASS" + "WORD"
            source = ('# C:/Users/' + 'AliceNine/a and /home/' + 'bobfive/b and /Users/Public/c\n'
                      + f'def first():\n    token = "{secret}"\n'
                      + f'    return "PrivateName Zed12345 {email} {access_key}"\n'
                      + f'# {key_begin}\n# secret key lines\n# {key_end}\n')
            (repo / "src" / "sample.py").write_text(source, encoding="utf-8")
            (repo / "orphan.txt").write_text(key_begin + "\nfollowing line\n", encoding="utf-8")
            (repo / "src" / "sample.ts").write_text("export function ready() { return true; }\n", encoding="utf-8")
            (repo / "one.png").write_bytes(b"\0" + b"x" * 300)
            (repo / "two.png").write_bytes(b"\0" + b"y" * 300)
            (repo / "private.bin").write_bytes(b"\0" + "Zed12345".encode("utf-16-be"))
            (repo / "skip.txt").write_text("skip", encoding="utf-8")
            (repo / ".gitattributes").write_text("skip.txt export-ignore\n", encoding="utf-8")
            (repo / ".env").write_text(f"{pw}=Zq7env\nAPI_" + "KEY=Zq7short\n", encoding="utf-8")
            (repo / "settings.ini").write_bytes(f"{pw}=Zq7wide\r\n".encode("utf-16"))
            (repo / "legacy-hit.txt").write_bytes("作者：张三\n".encode("gbk"))
            (repo / "legacy-clean.txt").write_bytes("普通说明\n".encode("gbk"))
            (repo / "PrivateName-notes.txt").write_text("plain\n", encoding="utf-8")
            run("add", "-A")
            run("commit", "-qm", "first PrivateName")
            (repo / "src" / "sample.py").write_text("uncommitted value", encoding="utf-8")
            out = root / "output"
            settings = {"redact": ["PrivateName", "张三"]}
            identities = ["Zed12345"]
            mirror_build.CHUNK = 350
            report, printed = root / "local-report.json", io.StringIO()
            with contextlib.redirect_stdout(printed):
                check(push(repo, "sample", True, False, out, settings, identities, report) == 0)
            shown = printed.getvalue()
            first = read_mirror(out)
            head = git(repo, "rev-parse", "HEAD").strip()
            check(first["commit"] == head)
            check("PrivateName" not in first["subject"])
            check(first["layers"]["bin"]["files"] == ["sample-bin-1of2.zip", "sample-bin-2of2.zip"])
            check(first["excluded_binary_files"] == ["private.bin"])
            check({e["path"]: e["reason"] for e in first["excluded_files"]} == {
                "<path withheld: personal>": "path: personal", "legacy-hit.txt": "non-UTF-8 text: personal",
                "orphan.txt": "unclosed private key", "private.bin": "binary: private term or identity"})
            manifest_text = (out / "MIRROR.json").read_text(encoding="utf-8")
            check(not any(t in manifest_text for t in ("PrivateName", "张三", "Zq7")))
            check(all(p in shown for p in ("4 files not uploaded", "PrivateName-notes.txt", "orphan.txt", "legacy-clean.txt")))
            check("Zq7" not in shown and "张三" not in shown)
            local = json.loads(report.read_text(encoding="utf-8"))
            check("PrivateName-notes.txt" in {e["path"] for e in local["not_uploaded"]})
            check(first["worktree"]["uncommitted_changes_excluded"] == 1)
            with zipfile.ZipFile(out / "sample-text.zip") as z:
                names = z.namelist()
                check(not {"orphan.txt", "legacy-hit.txt", "PrivateName-notes.txt"} & set(names))
                check(z.read("legacy-clean.txt") == "普通说明\n".encode("gbk"))
                check("Zq7" not in z.read("settings.ini").decode("utf-16") and "Zq7" not in z.read(".env").decode())
                data = z.read("src/sample.py").decode()
                check("uncommitted value" not in data and "def first" in data)
                check("skip.txt" not in names)
                check("INDEX/INDEX-functions.tsv" in names)
                check(len(names) == len(set(names)))
                check(json.loads(z.read("_mirror/STAMP.json"))["commit"] == head)
                for token in ("AliceNine", "bobfive", "PrivateName", "Zed12345", email, "AKIA0123", secret, "secret key lines"):
                    check(token not in data)
                check("/Users/Public/c" in data)
            check(push(repo, "sample", True, False, out, settings, identities) == 0)
            check(read_mirror(out)["pushed_at"] == first["pushed_at"])
            check(status(repo, "sample", out, settings) == 0)
            damaged = bytearray((out / "sample-text.zip").read_bytes())
            damaged[len(damaged) // 2] ^= 0xFF
            (out / "sample-text.zip").write_bytes(bytes(damaged))
            check(status(repo, "sample", out, settings) == 1)
            check(push(repo, "sample", True, False, out, settings, identities) == 0)
            check(status(repo, "sample", out, settings) == 0)
            (repo / "src" / "sample.py").write_text("def updated():\n    return 2\n", encoding="utf-8")
            run("commit", "-qam", "second")
            old_time = (out / first["layers"]["bin"]["files"][0]).stat().st_mtime_ns
            check(push(repo, "sample", False, False, out, settings, identities) == 0)
            second = read_mirror(out)
            check(second["layers"]["bin"]["commit"] == head)
            check(second["layers"]["bin"]["same_as_text_commit"] is True)
            check(push(repo, "sample", True, False, out, settings, identities) == 0)
            check((out / first["layers"]["bin"]["files"][0]).stat().st_mtime_ns == old_time)
            (out / "unrelated.txt").write_text("retain", encoding="utf-8")
            (repo / "two.png").unlink()
            run("commit", "-qam", "third")
            check(push(repo, "sample", True, False, out, settings, identities) == 0)
            check(read_mirror(out)["layers"]["bin"]["files"] == ["sample-bin.zip"])
            check((out / "unrelated.txt").read_text(encoding="utf-8") == "retain")
            check(not (out / "sample-bin-1of2.zip").exists())
            old = 10 ** 18  # 2001-09-09 in nanoseconds: --force must rewrite even unchanged volumes.
            os.utime(out / "sample-bin.zip", ns=(old, old))
            check(push(repo, "sample", True, True, out, settings, identities) == 0)
            check((out / "sample-bin.zip").stat().st_mtime_ns > old)
            prior = read_mirror(out)["pushed_at"]
            check(push(repo, "sample", False, False, out, {"redact": ["updated"]}, identities) == 0)
            check(read_mirror(out)["pushed_at"] != prior)
            with zipfile.ZipFile(out / "sample-text.zip") as z:
                check("updated" not in z.read("src/sample.py").decode())
            checks += _expect_error(lambda: push(repo, "other-project", False, False, out, settings, identities), "another project")
            checks += _expect_error(lambda: push(repo, "sample", False, True, out, settings, identities, out / "r.json"), "--report")
            never = root / "never"
            for bad in ("../escape", "CON", "", "a/b", "C:x", "trail."):
                checks += _expect_error(lambda: push(repo, bad, False, False, never / "out", settings, identities), "--name")
            check(not never.exists() and not (root / "escape-text.zip").exists())
            twins = root / "twins"
            twins.mkdir()
            for args in (("init", "-q"), ("config", "user.email", "t@example.invalid"), ("config", "user.name", "Twin Test")):
                run(*args, at=twins)
            commit_files(twins, {"Foo.txt": b"a\n", "foo.txt": b"b\n"}, "twins")
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                check(push(twins, "twins", False, False, root / "twins-out", {}, []) == 0)
            check("Foo.txt  <->  foo.txt" in printed.getvalue())
            commit_files(twins, {"_Mirror/notes.md": b"x\n"}, "clash")
            checks += _expect_error(lambda: push(twins, "twins", False, False, root / "twins-out", {}, []), "_Mirror/notes.md")
            if os.environ.get("VOYAGER_WEB_PRO_SELFTEST_CHILD") != "1":
                check(_selftest_export(root))
    finally:
        mirror_build.CHUNK = saved_chunk
    print(f"selftest PASS: {checks} checks")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--selftest"]:
        return selftest()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("push", "status"):
        cmd = sub.add_parser(command)
        cmd.add_argument("--repo", type=Path, default=Path("."))
        cmd.add_argument("--name")
        cmd.add_argument("--config")
        cmd.add_argument("--out", type=Path)
        if command == "push":
            cmd.add_argument("--assets", action="store_true")
            cmd.add_argument("--force", action="store_true")
            cmd.add_argument("--report", type=Path, help="local JSON listing files kept back, with full paths")
    args = parser.parse_args(argv)
    try:
        settings = load_config(args.config)
        if args.command == "status":
            return status(args.repo, args.name, args.out, settings)
        return push(args.repo, args.name, args.assets, args.force, args.out, settings, report=args.report)
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main(sys.argv[1:]))
