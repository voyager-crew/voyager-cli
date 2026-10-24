# Setup and project runbook

## Install and configure

Keep this directory together. Use Python 3.12, Git, and a paired Voyager CLI; follow the
[Voyager skill](../../skills/voyager/SKILL.md) for pairing. Commands below run from the checkout root;
when using another project, substitute the kit's installed script paths.
Check the interpreter first: `python3 --version` on macOS and Linux, `py -3.12 --version` or
`python --version` on Windows. Commands below use `python3`; on Windows use the one that reported 3.12.

Connect ChatGPT and Drive desktop to the same Google account. Create `Voyager-workspace` in
`My Drive` or `我的云端硬盘`, with this layout:

```text
Voyager-workspace/
  repos/<project>/
  tools/request-channel/
  <task-id>/
```

Copy `config.example.json` to `~/.voyager/web-pro-kit.json`, or `$VOYAGER_HOME/web-pro-kit.json`.
Set `workspace` to the existing local workspace path and `redact` to a list of private terms.
JSON-relative paths resolve beside the config file. Environment-relative paths use the current directory.
`--config <file>` or `VOYAGER_WEB_PRO_CONFIG` selects another config;
`VOYAGER_WEB_PRO_WORKSPACE` overrides its workspace.

Discovery checks Windows drive letters and user-profile Drive folders for both official names,
and macOS `~/Library/CloudStorage/GoogleDrive-*/My Drive` or `我的云端硬盘`.
Choose an explicit workspace when several accounts exist.
On Linux, configure an rclone-mounted workspace, or export with `--out` and upload the files yourself.
The request writer and the mirror replace files in place, which needs rclone's write cache:

```sh
rclone mount gdrive: ~/gdrive --vfs-cache-mode writes --daemon
```

With write-back caching a file reaches Drive only after rclone uploads it, so wait for the upload
before dispatch. For manual transfer, also upload request changes and download task outputs before using the waiter.

## Choose what this project shares

The mirror exports committed `HEAD` through `git archive`. Commit the intended changes first;
uncommitted and untracked files stay local. Add exclusions to the project's committed `.gitattributes`:

```gitattributes
private/ export-ignore
private/** export-ignore
local-settings.json export-ignore
build/ export-ignore
build/** export-ignore
```

Use `export-ignore` for private/generated paths and the config's `redact` list for private terms.
The text layer applies home-path, identity, email and credential patterns, including quoted and unquoted
values of keys such as `API_KEY=` or `password:`, and records locations in `_mirror/redactions.tsv`.
UTF-16 text is redacted like UTF-8. Your login name and Git name/email are found automatically only
when at least five characters long; add shorter ones to `redact`.
Inspect the first export with `--out`; review paths and binary content too.
Use `--assets` for images, audio or other binaries; matching identity terms exclude a whole binary file.
Binary volumes group roughly 200 MB of input. Symbolic links and submodules are skipped; prepare them
and external assets separately.

When a file cannot be redacted safely it is not uploaded, and the rest of the export continues:
a path containing a private term, an unclosed private key, a binary with an identity, or a non-UTF-8
text file (such as GBK) containing a private term or credential pattern. Other non-UTF-8 files upload
unchanged with a warning; convert them to UTF-8 to have them redacted. The terminal lists every file
kept back, and `MIRROR.json` records them under `excluded_files` with the rule name, never the matched
text; a path that contains a private term appears there only as `<path withheld: ...>`. `--report <file>`
writes the full local list and must point outside the mirror folder. Names that differ only by case or
Unicode normalization produce a warning, since they overwrite each other on Windows and macOS.
The export stops if the repository has its own top-level `INDEX/` or `_mirror/` (any case).

## Publish the mirror

```sh
python3 contrib/web-pro-kit/scripts/drive_mirror.py push --repo . --name sample --out ./mirror-preview
python3 contrib/web-pro-kit/scripts/drive_mirror.py push --repo . --name sample --assets
python3 contrib/web-pro-kit/scripts/drive_mirror.py status --repo . --name sample
```

The default destination is `<workspace>/repos/<project>`; `--out` selects the exact output directory.
`--name` must be one folder name that is valid on Windows, macOS and Linux.
It contains `MIRROR.json`, `<project>-text.zip` and optional `<project>-bin*.zip`.
The text ZIP includes `INDEX/` and `_mirror/`. Each project uses its own destination; keep task files
in the task folder. The publisher writes each archive beside its target, checks it, replaces the old one,
removes obsolete volumes and writes `MIRROR.json` last.
Layers whose SHA-256 still matches are reused; `--force` rewrites every layer it publishes. After changing redaction terms, use
`--assets` to refresh binaries too. Wait for Drive sync before dispatch.
Ask the receiver to verify ZIP hashes and the full commit in both `MIRROR.json` and `_mirror/STAMP.json`,
then extract into a new directory. Fetch binaries when needed and check `same_as_text_commit`.
Voyager's `--drive <file|folder>` remains the rclone upload path for individual question inputs.

## Prepare and steer a task

Copy `request-channel/` to Drive's `tools/request-channel/`. Choose a fresh task ID such as `review-alpha`.
Create its initial request, then append later changes using the same command:

```sh
python3 contrib/web-pro-kit/scripts/drive_request.py review-alpha "Review the parser."
python3 contrib/web-pro-kit/scripts/drive_request.py review-alpha --file additional-request.md
python3 contrib/web-pro-kit/scripts/drive_request.py review-alpha --show
```

One writer appends entries and increments `Version: N`; Drive sync carries them to the next checkpoint.
If `REQUEST.md` stays locked by another program, the writer says the request was not published; retry it.
Adapt `templates/task-header.md` and the blank `templates/project-header.md` to the project.
Paste `request-channel/PROMPT-BLOCK.md` into the indicated slot.
Set `{{WORKSPACE}}` to the Drive-visible task folder and `{{TOOLS}}` to its shared request-channel folder.
The channel README covers sandbox installation and activation in an existing shell or kernel.
The header asks for an initial empty `test.txt`, all available subagent slots including a reviewer,
and a ZIP plus `NOTES.md` saved to Drive before writing `DONE.txt` last.

## Submit and collect

```powershell
$prompt = Get-Content -Raw -Encoding UTF8 ./PROMPT.md
voyager ask --json --no-wait --timebox 70 $prompt
voyager job wait <job-id> --timeout 10m --json
```

On macOS and Linux, pass the prompt as one argument:

```sh
prompt="$(cat ./PROMPT.md)"
voyager ask --json --no-wait --timebox 70 "$prompt"
voyager job wait <job-id> --timeout 10m --json
```

Voyager supplies the 70-minute wrap-up instructions. Continue waiting on the same job after a timeout.
Use its `--approve-apps once|always` when authorized; otherwise handle the reported approval card.
Run the waiter in the local agent's background-job facility:

```sh
python3 contrib/web-pro-kit/scripts/drive_wait.py "<local-workspace>/review-alpha/DONE.txt"
```

Exit 0 reports the marker once it has content; an empty or still-syncing marker keeps the waiter polling.
Exit 2 reports new output followed by ten quiet minutes without it; system files such as `.DS_Store`,
`desktop.ini`, Office `~$` locks and sync `*.tmp` files do not count as output.
Review the conversation, ZIP and `NOTES.md` on either result. Extract the result ZIP into a new folder;
names that differ only by case collide when extracted on Windows or macOS. `--quiet 0` disables the fallback;
`--every` sets polling seconds. Reusing a task folder requires removing its previous marker first.

## Run tasks side by side

With **Run jobs in parallel** on in the Voyager popup, several agents can dispatch at once
(`voyager status` shows how many jobs may run). The kit keeps working when they do:

- Give each job its own task ID, so each has its own `REQUEST.md`, `DONE.txt` and waiter. A waiter
  watches only its task folder; never share one task folder between jobs, or one task's outputs
  would end another's quiet timer.
- `drive_request.py` and `drive_mirror.py push` hold a lock on this computer for the file or mirror
  they publish (under `$VOYAGER_HOME/locks/`, never in Drive). A second writer waits for the first
  instead of overwriting it.
- A mirror holds one commit at a time. Jobs on the same commit share it; for jobs on different
  commits, publish each to its own `--name`, such as `<project>-<task-id>`: a later push replaces
  what an earlier job is reading.
- Two asks into one conversation never run together. Follow up with `--chat` and the conversation
  id that job's own `ask` returned.

## Adapt and check

For a different environment, locate its Drive root and Python/Git executables, set explicit paths,
run the selftests, inspect a local export, and try a small task. Adapt discovery or sandbox hooks as needed.
Python tooling stays in this directory; its checks are each script's `--selftest`.

```sh
python3 contrib/web-pro-kit/scripts/kit_config.py --selftest
python3 contrib/web-pro-kit/scripts/secret_patterns.py --selftest
python3 contrib/web-pro-kit/scripts/safe_files.py --selftest
python3 contrib/web-pro-kit/scripts/redaction.py --selftest
python3 contrib/web-pro-kit/scripts/code_index.py --selftest
python3 contrib/web-pro-kit/scripts/mirror_build.py --selftest
python3 contrib/web-pro-kit/scripts/mirror_manifest.py --selftest
python3 contrib/web-pro-kit/scripts/drive_mirror.py --selftest
python3 contrib/web-pro-kit/scripts/drive_request.py --selftest
python3 contrib/web-pro-kit/scripts/drive_wait.py --selftest
python3 contrib/web-pro-kit/scripts/local_lock.py --selftest
python3 contrib/web-pro-kit/request-channel/channel.py --selftest
bunx --no-install oxfmt --check contrib/web-pro-kit
```
