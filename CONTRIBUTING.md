# Contributing to Voyager CLI

```sh
bun install
bun run build        # dist/cli.mjs, a single file with no runtime dependencies
bun run test         # vitest; test/cli/e2e.test.ts builds its own copy and spawns it
bun run typecheck
bun run lint:check
bun run format:check
```

Without building, run it from source with `bun src/cli/main.ts <command>`.

## The protocol package

`@voyager-crew/bridge-protocol` is the source of truth for wire types, validators and
golden fixtures. It lives in the Voyager repository (`packages/bridge-protocol`) and is
installed from npm. A protocol change lands there first: raising its version on Voyager's
`main` stages a release that a maintainer approves, then this package moves to the new
version. To try an unreleased protocol change, point the dependency at a local checkout
for a while (`"file:../gemini-voyager/packages/bridge-protocol"`) and run `bun install`.
The package ships TypeScript source: `bun build` bundles it, and Vitest inlines it
(`server.deps.inline`).

## Trying it by hand without the extension

```sh
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts serve --foreground   # terminal 1
VOYAGER_HOME=/tmp/vh bun src/cli/main.ts pair                 # terminal 2: prints the code
```

The extension side is the `FakeExtension` in `test/helpers/fakeExtension.ts`.
`test/cli/e2e.test.ts` shows it pairing and answering an `ask`.

## How it fits together

`voyager serve` listens on `127.0.0.1` only. The Voyager extension long-polls it for tasks and
runs neutral page ops (open a conversation, send, wait for the reply, read) in a ChatGPT tab it
opens itself. Plugins such as `ask` and `project` combine those ops; their `run()` executes
inside serve, so a job outlives the terminal that started it.

Jobs run one at a time unless the extension's polls report `maxTasks` above one (its parallel
switch is on). Then `src/jobs/admission.ts` decides whether one more job may start, each job holds
its own slot in `src/jobs/taskSlot.ts`, and ops that type, click, open or close a tab take turns in
`src/jobs/pageTurns.ts`, since the extension runs one of those at a time across all its tabs.

State lives in `~/.voyager/` (0700), or `$VOYAGER_HOME`: `config.json` (`{"port": 47321}`, and
optionally `driveRemote` and `maxParallelJobs`),
`serve.json`, `serve.lock`, `cli-token` and `pairings.json` (0600), `jobs/<id>/` (the reply in
`output/`, its downloaded files in `output/files/`, downloads still arriving in `incoming/`),
`last-conversation.json` (0600, what `--continue` uses), `plugin-state/` (each plugin's JSON, 0600) and `logs/serve.log`.
