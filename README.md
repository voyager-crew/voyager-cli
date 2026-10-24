<div align="center">
  <img src="https://raw.githubusercontent.com/voyager-crew/voyager-cli/main/assets/logo.svg" alt="Voyager CLI logo" width="96" height="96">
  <h1>Voyager CLI</h1>
  <p>Ask ChatGPT from your terminal, or let your coding agent do it,<br>through the ChatGPT you are already signed in to in your browser.</p>
  <p>
    <a href="https://www.npmjs.com/package/@voyager-crew/cli"><img src="https://img.shields.io/npm/v/@voyager-crew/cli?style=flat-square" alt="npm version"></a>
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  </p>
  <p><b>English</b> • <a href="README_ZH.md">简体中文</a></p>
</div>

```sh
voyager ask "Review this design" --attach ./docs/design.md
```

Voyager CLI is the reference client for the **ChatGPT Local Bridge** in the
[Voyager](https://github.com/voyager-crew/voyager) browser extension. The bridge lets programs on
your computer work with ChatGPT on the web: open a chat, send a prompt with files, wait for the
reply and read it, manage project files. Voyager CLI puts that in your terminal and saves each
reply as `response.md`. Everything stays on your machine: the CLI listens on `127.0.0.1` only,
and ChatGPT sees an ordinary chat from your own browser.
[More about the bridge →](https://voyager.nagi.fun/en/guide/local-bridge)

## Setup

1. Install Voyager CLI (Node.js 20.3 or later):

   ```sh
   npm install -g @voyager-crew/cli
   ```

2. Install the Voyager extension, version 2.1.0 or later (2.2.0 for `--approve-apps` and for saving the
   files a reply offers):
   [Chrome](https://chromewebstore.google.com/detail/iifacdnjakkhjjiengaffnegbndgingi) ·
   [Edge](https://microsoftedge.microsoft.com/addons/detail/voyager/gibmkggjijalcjinbdhcpklodjkhhlne) ·
   [Firefox](https://addons.mozilla.org/firefox/addon/gemini-voyager/). In its popup, open
   **Plugins**, turn on **ChatGPT · Local Bridge** and allow access to chatgpt.com.
3. Pair them once:

   ```sh
   voyager pair
   ```

   Open the Voyager popup on a ChatGPT tab and enter the eight-character code it prints in the
   Local Bridge settings.

## Asking

```sh
voyager ask "Explain this stack trace" --attach crash.log
voyager ask "Look over the repo" --attach ./src     # folders go up as a zip, secrets left out
voyager ask --model high "Quick sanity check"       # pro (default), extra-high, high, medium, instant
voyager ask --chat <link|id> "And the edge cases?"  # follow up in a conversation
voyager read <link|id>                              # save a conversation's latest reply
```

Every ask uses GPT-6 Pro in chat mode unless you pick another effort, and leaves it selected.
Voyager never switches ChatGPT to Work mode. The reply lands in `~/.voyager/jobs/<id>/output/`,
and `--json` prints its path along with the conversation link.

Files the reply offers (a CSV, a chart, a zip ChatGPT made) are saved beside it in `files/`,
with `-2`, `-3`… added when a name repeats; `--no-files` leaves them in ChatGPT. A file that
cannot be downloaded is reported without failing the command, since the reply itself was
saved: `voyager read <link>` tries again later.

### Long answers

Pro can think for hours. `ask` waits as long as ChatGPT is still working on the reply, and
only gives up after 20 minutes with no sign of life. To get your terminal back, submit and
collect later:

```sh
voyager ask --no-wait "…"            # prints a job id
voyager job wait <id> --timeout 10m  # exit 4 means still running: wait again, never resend
```

A Pro turn that builds, runs or renders things in ChatGPT's sandbox can lose its connection
after about 80 minutes, and then delivers nothing. `--timebox 70` asks it to wrap up at 70
minutes and hand over what it has, finished and unfinished work apart, in one ZIP.

## Projects

A ChatGPT project keeps files that every chat in it can read, so a codebase or a paper goes
up once instead of with every question.

```sh
voyager project create "Thesis"
voyager project upload "Thesis" ./thesis           # replaced when it changes, skipped when it hasn't
voyager ask --project "Thesis" "Where is the argument weakest?"
voyager project files "Thesis"
voyager project remove "Thesis" old-notes.md       # immediate and permanent; asks first
```

## Google Drive and GitHub

ChatGPT's own Google Drive and GitHub apps can read your files directly, with no upload through the page. Connect them in ChatGPT first.

```sh
voyager ask --drive ./paper.pdf "Summarize the method"   # puts it on Drive and links it in the prompt
voyager ask --repo owner/name "Why does CI fail?"         # ChatGPT's GitHub app reads the repository
```

`--drive` packs like `--attach` but has no 64 MiB limit (files over 20 MiB inside a folder are still left out), and uploads with [rclone](https://rclone.org/drive/):
set `VOYAGER_DRIVE_REMOTE` (or `"driveRemote"` in `~/.voyager/config.json`) to a folder on a Google Drive
remote, such as `gdrive:Voyager`, on the same Google account ChatGPT's Drive app uses. The files stay there.

`--repo` asks ChatGPT to commit only to a new `chatgpt/*` branch, so you review before merging. That is a request, not
a restriction: the app writes wherever its GitHub installation allows, without asking. If it cannot reach the
repository, voyager stops with exit code 3; add the repository at
[github.com/settings/installations](https://github.com/settings/installations).

Before some app actions, such as writing a file to Drive, ChatGPT stops the reply on a card that asks
"Allow ChatGPT to use Google Drive?". voyager then stops with exit code 3 and the conversation link, where
you answer it. With Voyager 2.2.0 or later, pass `--approve-apps always` to have the extension click "Always allow" for you, or
`--approve-apps once` for "Allow once". The card can come back after "Always allow".

## Using it from an agent

Claude Code, Codex and any other agent that can run shell commands can use Voyager CLI. Install
the skill that teaches them how:

```sh
npx skills add voyager-crew/voyager-cli
```

[`skills/voyager/SKILL.md`](skills/voyager/SKILL.md) is written for them: JSON output, what each
exit code means, how to wait for a long job without sending the prompt twice, and how to follow
up with `--chat` and the conversation id it got rather than `--continue`.

One job runs at a time, unless you turn on **Run jobs in parallel** in the **Local bridge** card of
the Voyager popup (a Voyager release later than 2.2.1) and choose there how many run at once, from
2 to 10. Then that many jobs run side by side, each in its own ChatGPT tab, so several agents can
ask at once and their replies are awaited together; typing and clicking still take turns. A job
waits for its turn as long as the other job's step may take (a large upload, up to 10 minutes),
and stops as busy (exit 5) before its own step only when that job is stuck past it. Two asks
into the same conversation, or two project changes, never run together: the later one is refused
as busy (exit 5). `"maxParallelJobs": 2` in `~/.voyager/config.json` keeps it to fewer jobs; each
running job is a Pro request of its own. `voyager status` says how many jobs may run now and which
one is acting on its page.

Every result also names your ChatGPT plan (`Pro Lite ($100)`, `Pro ($200)`, …) as the page last
reported it.

## Good to know

- `ask`, `read` and every `project` command open their own ChatGPT tab and close it when they
  end, also after a failure; pass `--keep-tab` to leave it open. If ChatGPT asks you to sign in
  or solve a challenge, Voyager CLI stops, leaves that tab open and says so (exit 3); it never
  works around it.
- `voyager update` updates everything it can: the CLI (when npm installed it globally),
  `voyager serve` (restarted unless a job is running) and the extension's page data, fetched now
  instead of at its next check. Your browser's store updates the extension itself.
- Commands: `voyager --help`. State lives in `~/.voyager` (or `$VOYAGER_HOME`), private to
  your user.
- Tested in Chrome. Edge and Firefox builds of Voyager include the bridge too; Safari does not.

## Disclaimer

- Voyager and Voyager CLI are community open-source projects. They are not affiliated with or
  endorsed by OpenAI.
- The bridge automates ChatGPT on the web in your own signed-in browser. OpenAI's
  [Terms of Use](https://openai.com/policies/terms-of-use/) restrict extracting output by automated or programmatic means, so decide
  for yourself whether your use complies before you rely on it. Any limits placed on your account
  as a result are your own risk.
- Similar tools take the same line: [oracle](https://github.com/steipete/oracle), for example, makes its browser mode an opt-in
  experimental feature and points people who want to avoid the risk to the API. If you need a
  supported route, use the OpenAI API.
- The bridge is for your own convenience on your own computer: connect only your own account, do not use it to serve other people, share an account or resell usage, and use it only for lawful purposes.

## License

MIT. Development notes are in [CONTRIBUTING.md](CONTRIBUTING.md).
