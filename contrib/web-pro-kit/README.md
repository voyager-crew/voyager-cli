# Web Pro kit

Tested only on Windows 11 + Google Drive for desktop + Python 3.12; macOS and Linux are untested.

For maintainers: this Python toolkit gives agents a persistent repository mirror and a request-file channel for ChatGPT web Pro with Google Drive.
It complements Voyager's existing `--timebox`, `--approve-apps`, and per-question `--drive` uploads with a shared repository folder across tasks.
Merge it as a self-contained directory under `contrib/`, keeping the npm package's file list unchanged.
If parts move into the CLI later, prioritize repository mirroring and versioned request files; keep sandbox hooks and prompt examples as optional recipes.

Start with [RUNBOOK.md](RUNBOOK.md) for setup, project sharing rules and the daily workflow.

- `scripts/`: mirror (`drive_mirror.py` with its redaction, archive, manifest and file helpers), code index,
  shared configuration and secret patterns, request writer, delivery waiter, and the local lock that keeps
  agents running side by side from publishing the same request or mirror at once.
- `request-channel/`: sandbox reminder script, usage notes and the prompt block.
- `templates/`: one suggested task header and a blank project header.
- `config.example.json`: local workspace and redaction settings.
