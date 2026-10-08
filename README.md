# Grove

_Tells you which Claude Code agents need you, and gets you to them._

Grove is for one person running many Claude Code sessions across several projects. It watches every session, says
which ones are waiting on you (a permission prompt, a finished turn, a failure, a session that stopped mid-turn), and
opens the one you pick in VS Code or Cursor.

In the repo:

- the app (`apps/desktop`, Electron, macOS) - the sidebar of projects, the inbox, a project's sessions, opening and
  starting agents
- the core (`packages/core`) - the reader of Claude Code's transcripts and live status, the project model, the git
  layer
- the companion extension (`extension/`) - the few things that can only happen from inside VS Code or Cursor: landing a
  window on a session, starting a conversation with a prompt waiting, syncing a project's references, showing drift

Grove never types into a running session. It keeps files on disk, starts a session with one prompt when you ask for
one, and hands off to the editor. You answer an agent in the agent's own chat.

## First run

Needs macOS on Apple Silicon, git, VS Code or Cursor with the Claude Code extension, and the `claude` CLI for agents in
the background. Checked against Claude Code 2.1.286 and 2.1.287.

1. [Install it](#install-it) and open it. With no project yet, the window is the **New project** form
2. Give the project a name, a one-line goal and the repos the work needs, then **Create project**. Grove makes the
   project's folder under `~/claude-ws/`, with a working copy of each repo
3. If a banner offers to install the Grove extension into your editor, take it: landing on a session and starting a
   conversation both go through it
4. **Start an agent in VS Code** opens the project on a new Claude conversation with a prompt in the input box. Send
   it. The prompt tells the agent to work toward the project's goal and to read `context/` first
5. Watch the **Inbox**: every session that needs you, in any project. A click opens it in a panel beside the list, a
   double-click opens it in the editor, which is where you answer. **Dismiss** clears a row

## A project is a folder

A project has a name, a one-line goal and the repos the work needs. It owns a directory, `~/claude-ws/<project>/`. That
directory - not any of your repos - is the primary workspace folder, so it is Claude's working directory. It follows
that:

- sessions started there land in their own `~/.claude/projects/<slug>/`, so the project's sessions are a directory
  listing, not a guess. sessions started by hand, from a terminal, or while the app was closed are picked up the same way
- the Claude Code panel's own history is already scoped to the project

Earlier versions called a project a combo. The file that lists them is still `combos.json`, and the generated
`CLAUDE.md` and the extension's commands still say combo.

Repos in a project are one of:

| mode | what it is | when |
| --- | --- | --- |
| working copy | a `git worktree` inside the project folder. detached at HEAD by default, so two projects can hold the same repo | agents will edit here |
| reference | your real clone, added as a second workspace root and to `permissions.additionalDirectories` | context to read |

The project form lists the folders you use most as one-click chips: the repos your sessions ran in (a session started
in a subfolder counts toward its repo), and folders already in other projects, ranked by how often and how recently.
**Add folder...** opens the file picker for anything else. A folder that is not the top level of a git repository can
only be a reference.

A working copy starts clean. Your uncommitted changes, dev servers and editor state stay in the original clone.

The goal is one line, under 500 characters. An agent started from Grove is told to work toward it.

### The project's CLAUDE.md

Every session started in the project root loads its `CLAUDE.md`, forks and background agents included. The stub Grove
writes when the project is created says what the folder is (a set of git worktrees, and what a worktree implies), where
plans and generated artifacts go (`plans/`, `artifacts/` - never inside a working copy), and that `context/` is the
memory sessions have in common: read it before a task, add a short dated entry when something is decided or learned.
It is written once and is yours after that.

### Long work in the background, as a switch

By default a project tells Claude to hand long autonomous work to a background agent, so the conversation stays free
to answer questions and plan. It takes these files:

- `.claude/agents/long-task.md` - an agent with `background: true` in its frontmatter. A subagent never sees the
  conversation that spawned it, which is what the plan file is for: the plan in `plans/` is its brief, and it writes
  what it decides to `context/`
- `.claude/long-work.md` - the policy: background, or here in the conversation. The app owns this file
- `CLAUDE.md` only says "read `.claude/long-work.md` before long work, every time"

`CLAUDE.md` is read once, when a session starts, so a switch written there could never reach a session that is already
running. The policy file is read at the moment of decision, so flipping it takes effect on a running session's next
long task. Flip it from `⌘K` (**Run long work in the conversation** / **in the background**) or from the editor
(`Grove: Toggle Background Long Work`). Saying "do this one here" in the chat overrules it for a single task.

It is a default by instruction, not an enforcement: Claude still decides what counts as long.

A session whose turn ended while a background subagent it started is still working counts as running, not as waiting
on you. A background shell left running (a dev server) does not hold the turn open.

## The screens

The **sidebar** on the left has **Inbox** with the count of sessions that need you, over every project, then the
projects in `combos.json` order. Each project has its own colour and, when any of its sessions needs you, their count.
The order never changes with the counts. **+** beside Projects opens the new project form.

**Inbox** is every session that needs you, newest first, whichever project it is in. A row has the session's title,
what it is at, its project, where it runs and when, then a line of what it asks.

| row | when | the line under it |
| --- | --- | --- |
| Needs permission | the session stopped on a permission prompt | the tool, and what it would act on |
| Your turn | its turn finished and you have not looked | the end of its last message |
| Failed | it stopped on an API error | the error |
| Stopped | it went away mid-turn: its window closed, it crashed, the machine rebooted, or its background run failed | what it was working on |

Each state keeps one colour everywhere: orange for permission, the accent for your turn, red for failed and stopped,
green for working. **Dismiss** takes a row out. Opening the session in the editor does the same for Needs permission,
Your turn and Failed, which come back on that session's next event. A Stopped row stays until it is dismissed, the
session runs again, or a week has passed.

A click on a project shows **its sessions**, all of them: Needs you first, then Working, then the rest under Today,
Yesterday and Earlier, newest first. A row has the title, the state, where it runs, the branch and the time. The list
is the sessions started in the project's folder, plus any started in a subfolder or a working copy that needs you or is
running now. A finished session in a subfolder is found from `⌘K`. The filter in the top bar narrows the rows to the
ones whose title, prompt or branch has every word typed. The top bar also has **Start in VS Code**, **Start in
background**, **Open in VS Code** for the project's window, and **Edit**. The list follows the sessions as they change,
with no refresh.

**The panel.** A click on a row, in either list, opens that session in a panel on the right half of the window. It
shows the state, the title, the project, the branch, where it runs, what you last said to it (the first 4,000
characters) and what it has said since (the last 20,000). It has **Open in VS Code** and, for a session that needs you,
**Dismiss**. While it is open it follows the arrow keys, and when its row leaves the list it moves to the row that took
its place. `Esc` closes it. A double-click on a row opens the session in the editor. The panel reads the end of the
transcript, at most 8MB back, and never the whole file.

**New project** and **Edit project** are one form: name, goal, repos. Edit project also shows drift per repo and, when
Grove could not write the project's files, why.

`⌘K` opens the palette: go to the inbox or a project, start an agent, switch long work, repair working copies, delete
the project, settings. Typing also searches every Claude Code session on the machine, in a project or not: titles and
prompts first, then everything that was said in each session and by its subagents. `↵` on a session opens it in the
editor.

The **menu bar** item shows how many sessions need you across all projects. Its menu lists the three newest, then
**Open Grove** and **Quit**. A click on one opens the window on its inbox row, with the panel open. Closing the window
hides it: the app stays in the menu bar until it is quit.

What an agent wrote is not trusted. It is rendered as markdown without any HTML (a `<script>` shows as text), images
show their description, and only `http(s)` links open - in your browser, never in the app.

## Notifications

Grove notifies when:

- a session asks for permission
- a session stops on an API error
- a session in a project goes away mid-turn. several within five seconds fold into one
- a turn that ran for over a minute finishes. one session notifies for this at most once in two minutes

Nothing notifies about what the focused window already shows: on the inbox that is every project, on a project's
sessions that project. What stopped while Grove was closed shows in the inbox and does not notify.

A click opens the window on that session with its panel open: its inbox row when it has one, else its row in its
project's sessions. A session that is in neither list, or in no project, opens in the editor. The dock badge carries
the same count as the menu bar. **Notifications** in Settings switches them off.

## Opening and starting agents

**Open in VS Code** (or Cursor, per Settings) depends on where the agent runs, which each row says in a chip:

| chip | what Open does |
| --- | --- |
| `VS Code`, `Closed` | opens the project's window and lands on the session, resuming it if it was closed. A session that ran inside a working copy opens that folder instead |
| `Background` | a session Claude Code's supervisor runs (`claude --bg`). resuming it anywhere else is refused while the supervisor holds it, so Grove runs `claude stop <id>` first, then lands. It asks before stopping one that is mid-turn |
| `Terminal` | does not land: a second process on a live conversation would be a copy of it. The project opens, and Grove says to quit the agent in its terminal first |
| `Headless` | `claude -p` or an SDK app. The same: the project opens, and it can be opened once it has finished |

Landing needs the companion extension in that editor. Without it the window opens and Grove says it could not land.

**Start an agent** is in a project's top bar, on a project with no sessions, and in `⌘K`:

| where | what happens |
| --- | --- |
| VS Code (or Cursor) | the project opens on a new conversation in the Claude panel, the prompt waiting in its input box - you send it. The panel takes a prompt from outside but cannot be made to send it |
| Background | `claude --bg -- <prompt>` in the project root |

The prompt tells the agent to work toward the project's goal and to read `context/` first. Grove does not start what it
knows will fail: no goal, or a missing project folder. The new session shows in the project's list once it runs.

Starting a conversation in the editor needs Grove Companion 0.3.0 or later. With an older one, or none, the project
still opens and the prompt is put on the clipboard to paste into a new conversation.

A background session keeps the environment it was dispatched with for good, and an app opened from Finder has almost
none (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`: no node, no pnpm, no gh). So every `claude` Grove runs itself gets your
login shell's environment, read once per app run.

Since Claude Code 2.1.281, a folder has to have passed the CLI's trust prompt once before anything can be sent to the
background there, and a project only ever opened from VS Code has not. The first time, Grove offers **Start in
Terminal**, which runs the same command in Terminal where the prompt can be answered. Grove never writes that trust
itself.

Grove only ever calls Claude Code's own commands: `claude agents --json --all` (asked at startup, when the window comes
forward and when a background process comes or goes, never on a timer), `claude --bg -- <prompt>` and `claude stop
<id>`. Never `claude rm`, never `claude daemon`, and no permission flag - a background agent that stops on a permission
prompt shows up as a Needs permission row.

## Files Grove writes

### In a project folder

```
~/claude-ws/<project>/
  CLAUDE.md                   written once when the project is created. yours after that
  plans/  artifacts/  context/  made once, with the root. where sessions keep what outlives them
  .claude/agents/long-task.md written once. `background: true`, so long work never blocks the conversation
  <project>.code-workspace    generated. only `folders` is ours, the rest is preserved
  .claude/long-work.md        generated. whether long work goes to that agent. flips mid-session
  .claude/settings.local.json only our entries are touched. see below
  <repo>/                     working copies
```

In `.claude/settings.local.json` Grove owns its entries in `permissions.additionalDirectories` (the project's
references) and the hook groups marked `# grove-status`. It never writes `defaultMode`. A file that is not valid JSON
is left alone, and the project says so.

The hooks are kept current when Grove starts, when its window comes forward, on `⌘R`, and when a project is created or
edited. The workspace file and the references are written when the project is opened in the editor.

### Outside it

```
~/claude-ws/
  combos.json       the projects. source of truth. hand-editable. unknown keys and formatting are preserved
  reviewed.json     what you dismissed, as `<project>/<key>`. hand-editable, same treatment
  settings.json     optional: editor, binary paths, appearance, notifications
  .grove/           cache and runtime - safe to delete
    events/         where session status hooks write
    interrupted.json  sessions whose process went away mid-turn, kept for a week
```

What you dismissed is a decision, not a cache, so it sits beside `combos.json` and not in `.grove/`. Entries the app
does not understand are left alone when it writes. Deleting `.grove/` loses the Stopped markers.

The app never writes inside `~/.claude` (the one exception is the opt-in status hooks below, and only in
`settings.json`), never writes Claude Code's folder trust, never copies a transcript, never deletes a branch, and never
passes `--force` to `git worktree remove`: a working copy with uncommitted work is kept and reported.

Drift is normal: people run `git worktree remove` and `rm -rf` behind the app's back, and Claude Code expires
transcripts. Folder states are `ok`, `reference`, `absent`, `stale`, `foreign` (left alone) and `missing-origin`.
**Repair working copies** in `⌘K` recreates the ones it can.

### Session status hooks, and how they are repaired

A transcript cannot tell "running a tool" from "waiting on a permission prompt", so that comes from Claude Code hooks.
Every project's `.claude/settings.local.json` gets async hooks on `UserPromptSubmit`, `PermissionRequest`,
`PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart` and `SubagentStop` that drop the
hook's input into `~/claude-ws/.grove/events/`. Claude Code watches its settings files, so sessions that are already
running pick the hooks up too - and later write the copy they loaded at startup back over them, which silently drops
whatever was added since. So the app watches each project's settings file and puts its own entries back when that
happens. Only the entries carrying its marker are touched.

Hooks only cover the sessions that have them. Every live Claude Code process also keeps a file in
`~/.claude/sessions/<pid>.json`, which the app reads (never writes) to fill in sessions no hook covers, to say where an
agent runs, and to notice a process that is gone. Anything a hook said wins: a permission prompt is something only a
hook can see.

Sessions outside every project report only when **Track sessions outside projects** is on in Settings. Grove then adds
the same status hooks to Claude Code's own `settings.json`, and watches and repairs that file the same way. Turning the
switch off takes them out again. Use the switch: setting `trackAllSessions` to `false` by hand in
`~/claude-ws/settings.json` leaves the hooks (the groups marked `# grove-status`) where they are. A session outside
every project notifies and is found from `⌘K`. It is in no list.

## After a restart

Quitting Grove changes nothing for the agents. The hooks keep writing events into `.grove/events/`, and Grove reads
what it missed when it starts. Sessions that went away mid-turn while it was closed are Stopped rows in the inbox,
without a notification. What you dismissed is in `reviewed.json`.

Closing VS Code ends the sessions in its tabs. One that was between turns shows as `Closed`, and opening it resumes
it. One that was mid-turn is Stopped.

A reboot stops everything, background sessions included. Sessions that were mid-turn come back as Stopped rows, and
that marker is kept for a week. Grove never restarts an agent on its own.

## Upgrading from 0.10

0.10 was a project manager: agents kept a record of cards, questions and conclusions through an MCP server Grove
installed into every project. 0.11 drops that. The first launch takes out of every project what 0.10 put in, and only
that:

- `mcpServers.grove` in `.mcp.json`, when its command is Grove's launcher. The file goes too when that entry was all
  it held
- in `.claude/settings.local.json`: the `SessionStart` hook marked `# grove-record`, `grove` in
  `enabledMcpjsonServers`, and the allow rules `mcp__grove` and `Bash(<launcher>:*)`. The status hooks stay
- `.claude/rules/grove-record.md`, when it is the file Grove generated
- the record paragraphs in `CLAUDE.md` and `.claude/agents/long-task.md`, swapped back to the `context/` text, only
  where they are still exactly what Grove wrote
- `~/claude-ws/.grove/bin/record` and `record.cjs`

Your data stays where it is: `cards/`, `conclusions/` and `.claude/grove-project.json` are not touched, and nothing
reads them any more. A `grove` server of your own in `.mcp.json` is yours and stays, with its approval. `prefix` in
`combos.json` is left as an unknown key. A project where none of this is present is not written to.

`reviewed.json` keyed its marks by the project's card prefix (`AUTH/...`). They are renamed to the project's folder
name (`auth-sso/...`) once, so what you dismissed stays dismissed.

A session that is open during the upgrade still has the record's tools and rules loaded. Restart it. An unpackaged
build removes nothing from real projects unless it runs under `GROVE_ROOT`.

What is gone from the app:

- the Cards and Conclusions screens, the card page, and inbox rows for questions on cards, decisions, findings, new and
  finished cards
- starting an agent on a card, and "Waiting for it to claim a card"
- the notification for a question on a card
- **Mark all reviewed**. **Reviewed** is **Dismiss**
- the project switcher in the top bar. The sidebar has the projects
- the card prefix on the project form, and the record's self-check with its banner

0.10.17 has all of it, if you want it back.

Coming from 0.5: nothing of the record was ever installed, so there is nothing to remove. The conversation pane, the
agent inspector, token counts, the archive and **New session...** went in 0.10 and are still gone. A project's sessions
are a screen again.

## Limits

What ran: the unit tests, and Playwright driving the built app against fixture projects under a temp root, with
stand-ins for `code` and `claude`. The packaged app was opened the same way, once. The cleanup of 0.10's files runs
against a fixture project written by 0.10's own code.

What did not run, or does not work:

- no test drives a real editor tab, and the double-click was only driven by Playwright's mouse
- you cannot answer from Grove, and Grove cannot wake an agent. you answer in the agent's chat
- the panel shows the last exchange, not the conversation
- a session whose last prompt is more than 8MB from the end of its transcript shows only the first 500 characters of
  that prompt
- a session started in a subfolder that has finished is not in its project's list, only in `⌘K`
- two quick VS Code starts in one project leave one conversation
- a project's colour is one of nine. past nine projects two share one, and deleting a project can change the colour
  of a later one
- starting an agent was only run against the stand-ins in 0.11, in the editor and in the background
- what a session left open across the upgrade from 0.10 does when it calls a record tool was not tried
- macOS on Apple Silicon only

## Keyboard

No single letter is a shortcut: a letter only ever types, in the filter or a form.

| | |
| --- | --- |
| `⌘K` | the palette: go to, project commands, find a session |
| `⌘1` `⌘2` | Inbox / the sessions of the project last on screen |
| `⌥↑` `⌥↓` | step through the sidebar: Inbox, then the projects |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` `⌘↑` `⌘↓` | move the active row |
| `↵` | open the active row's session in the panel beside the list |
| `⌘↵` | open it in the editor |
| `⌘D` | dismiss the active row |
| `⌘F` | filter the project's sessions. from the inbox it goes to the project last on screen |
| `Esc` | close the panel, then clear the filter, then go back |
| `⌘N` `⌘O` `⌘E` `⌘R` `⌘,` | new project, open the project in the editor, edit project, refresh, settings. `⌘O` and `⌘E` do nothing on the inbox |

No row looks active until a key says so: the first arrow or `↵` only shows which row the keyboard is on, and the next
one acts. With the panel open the arrows step from its row at once. `Esc` does not leave a project form that has
changes.

## Develop

Needs node >= 22.18, pnpm 10, git >= 2.36.

```bash
pnpm install
pnpm test               # core + extension + app logic (vitest, real throwaway git repos)
pnpm typecheck && pnpm lint

pnpm grove list            # every session on this machine, straight from the core
pnpm grove search queue
pnpm oracle --strict    # diff our index against the Agent SDK's listSessions() (cd tools/oracle && pnpm install --ignore-workspace --no-optional first)

GROVE_ROOT=/tmp/grove-dev pnpm app:dev      # the app, with hot reload
pnpm app:e2e            # Playwright drives the real built app against temp fixtures
pnpm ext:package && pnpm ext:install        # or ext:install:cursor
pnpm app:package        # apps/desktop/dist/*.dmg, ad-hoc signed
pnpm app:packaged       # smoke test the packaged app
```

`pnpm app:dev` refuses to start without `GROVE_ROOT`. A dev build beside the installed app would read the same
`~/claude-ws/.grove/events/` and take hook events away from it. Point `GROVE_ROOT` at any folder: it stands in for
`~/claude-ws`, and projects are created under it. `CLAUDE_CONFIG_DIR` moves Claude's config dir the same way, and the
e2e tests isolate themselves with both.

Under `GROVE_ROOT` the app behaves as a test root: no menu bar item unless `GROVE_TRAY=1`, notifications are recorded
and not shown, your shell's rc files are not run, and the real `claude` is never run (`GROVE_CLAUDE_BIN` names a
stand-in). `apps/desktop/scripts/dev.mjs` takes `--real-root` to use `~/claude-ws` anyway.

After `pnpm app:build`, `node apps/desktop/scripts/screenshots.ts <outDir>` saves every screen from the real app, in
light and dark, at 1280x800 and 880x600, against fixture projects.

The icon is [apps/desktop/resources/icon.svg](apps/desktop/resources/icon.svg); `node apps/desktop/scripts/make-icon.mjs`
re-renders the PNG that electron-builder turns into the `.icns`.

Layout: `packages/core` is pure Node TypeScript with no runtime dependencies, and is the only implementation of the
transcript parser, the project model and the git layer. The app's main process and the extension both bundle core from
source.

## Install it

Download the latest `.dmg` from [Releases](https://github.com/varunkvv/grove-session-manager/releases/latest), open it,
and drag **Grove** onto Applications. Apple Silicon only. Every merge to `main` publishes one: the workflow in
[.github/workflows/ci.yml](.github/workflows/ci.yml) runs the tests, builds the DMG on a clean macOS runner, and tags it
`v<major>.<minor>.<run number>`. The five newest releases are kept.

Or build it yourself:

```bash
pnpm app:package
open apps/desktop/dist
```

It is ad-hoc signed, which is enough to run on the machine that built it. A DMG that travels through
a browser, Slack or AirDrop is quarantined by macOS, and needs
`xattr -dr com.apple.quarantine "/Applications/Grove.app"` once.

It follows the macOS appearance, light or dark, and switches with it. **Appearance** in Settings pins it to one.

## Things people will report as bugs

- **a row came back after Dismiss** - a Needs permission, Your turn or Failed row is marked as seen, and returns on
  that session's next event. a Stopped row stays dismissed
- **a session says Closed but nothing went wrong** - Closed means its process is not running, which is what a closed
  VS Code tab looks like. Open resumes it
- **a session says Stopped after its tab was closed** - it was mid-turn when the tab went
- **a session is missing from its project's list** - it was started in a subfolder and has finished. it is in `⌘K`
- **a session is missing from `⌘K`** - Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`). the VS Code
  panel also archives sessions after 14 days idle (`claudeCode.archiveInactiveSessions`). those still show here
- **an agent says the grove tools are gone** - it was open across the upgrade from 0.10. restart it
- **the app does not open from a download** - it is ad-hoc signed. `xattr -dr com.apple.quarantine "Grove.app"`
- **landing opened a fresh conversation** - the companion extension is not installed in that editor (the app shows a banner
  and can install it), or the transcript expired

The transcript format is internal to Claude Code and changes between releases. What this project relies on, and how it was
verified, is in [docs/claude-code-facts.md](docs/claude-code-facts.md).

## License

MIT. Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
