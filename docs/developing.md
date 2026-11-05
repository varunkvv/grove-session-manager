# developing grove

this page is for the one person who builds grove. the app's users never need it.

## in the repo

In the repo:

- the app (`apps/desktop`, Electron, macOS) - the sidebar of projects, every session on one screen with the ones that
  need you on top, a project's sessions, search, opening and starting agents
- the core (`packages/core`) - the reader of Claude Code's transcripts and live status, the project model, the git
  layer
- the companion extension (`extension/`) - the few things that can only happen from inside VS Code or Cursor: landing a
  window on a session, starting a conversation with a prompt waiting, syncing a project's references, showing drift
- the Zed agent (`apps/desktop/src/acp-proxy`) - Zed has no extension API, so landing there goes through a small ACP
  proxy between Zed and Claude Code's agent. It turns the first new thread in the project's window into the session
  Grove handed over


## Files Grove writes

### In a project folder

```
~/claude-ws/<project>/
  CLAUDE.md                   written once when the project is created. yours after that
  plans/  artifacts/  context/  made once, with the root. where sessions keep what outlives them
  <project>.code-workspace    generated. only `folders` is ours, the rest is preserved
  .claude/settings.local.json only our entries are touched. see below
  <repo>/                     working copies
```

In `.claude/settings.local.json` Grove owns its entries in `permissions.additionalDirectories` (the project's
references) and the hook groups marked `# grove-status` and `# grove-title`. It never writes `defaultMode`. A file that is not valid JSON
is left alone, and the project says so.

The hooks are kept current when Grove starts, when its window comes forward, on `⌘R`, and when a project is created or
edited. The workspace file and the references are written when the project is opened in the editor.

### Outside it

```
~/claude-ws/
  combos.json       the projects. source of truth. hand-editable. unknown keys and formatting are preserved
  reviewed.json     what you dismissed, as `<project>/<key>`. hand-editable, same treatment
  settings.json     optional: editor, binary paths, appearance, notifications, recaps, renaming, keep awake
  .grove/           cache and runtime - safe to delete
    events/         where session status hooks write, each event cut at 64KB
    interrupted.json  sessions whose process went away mid-turn, kept for a week
    live-tasks.json  what each session left running at its last turn's end
    recaps.v1.json  the recaps, by transcript. deleting it has them written again
    titles.v1.json  the titles and descriptions, and every title handed to Claude Code, by session
    titles/pending/ a title waiting for its session's next prompt, one small file each
    session-index.v1.json  the sessions as last read, with each one's usage by day. rebuilt from the transcripts
    usage-retired.json  the usage of sessions whose transcript is gone. this one cannot be rebuilt
    acp.log         what Claude (with Grove) did in Zed: each request and each landing, never what was said. emptied past 1MB
~/Library/Sounds/
  Grove.wav         the notification chime, about 40KB. written at launch, and again whenever it differs from Grove's own
```

What you dismissed is a decision, not a cache, so it sits beside `combos.json` and not in `.grove/`. Entries the app
does not understand are left alone when it writes. Deleting `.grove/` loses the Stopped markers, and the
[usage](../README.md#usage) of every session whose transcript Claude Code has since deleted.

In `combos.json` a project with `"archived": true` is [archived](../README.md#archiving-and-deleting-a-project). Set it or take it
out by hand and the app follows. Only `true` means anything: the app never writes `"archived": false`, and drops any
other value the next time it saves the file. No other key of the project moves when it is archived.

Outside `~/claude-ws` and the projects' own folders the app writes two things: `Grove.wav`, and the opt-in status hooks below, which are the one thing it writes inside `~/.claude`, and only in `settings.json`. With Zed as the editor it also
keeps one entry, `agent_servers["Claude (with Grove)"]`, in `~/.config/zed/settings.json`. Comments and your other entries are
preserved, and a file that is not valid JSON is left alone. It never writes Claude Code's
folder trust, never copies a transcript, never deletes a branch, and never passes `--force` to `git worktree remove`:
a working copy with uncommitted work is kept and reported. The folder of a project you delete goes to the Trash,
never straight off the disk.

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

Claude Code's own session files (`~/.claude/sessions/<pid>.json`) fill in around the hooks. A session no hook covers
(one started in a project's subfolder or working copy loads no project hooks) shows as working while its file says
`busy`, and under Needs you while it says it waits on a permission prompt or a question. An approved permission prompt
leaves Needs you when the file flips to `busy` at the approval, not when the command ends: no hook fires in between.

While both title switches are on, the same files get one more hook, marked `# grove-title`, on `UserPromptSubmit` and
`SessionStart`. It is not async: Claude Code only reads what a hook prints when it waits for it. It is shell builtins
and one `cat` until there is a title to hand over, about 8ms more than starting a shell at all (18ms in all on a busy
machine, against 10ms for `sh -c 'exit 0'`). Grove before 0.17 and its extension only strip `# grove-status`, so they
leave this hook alone.

Hooks only cover the sessions that have them. Every live Claude Code process also keeps a file in
`~/.claude/sessions/<pid>.json`, which the app reads (never writes) to fill in sessions no hook covers, to say where an
agent runs, and to notice a process that is gone. Anything a hook said wins: a permission prompt is something only a
hook can see.

Sessions outside every project report only when **Track sessions outside projects** is on in Settings. Grove then adds
the same status hooks to Claude Code's own `settings.json`, and watches and repairs that file the same way. Turning the
switch off takes them out again. Use the switch: setting `trackAllSessions` to `false` by hand in
`~/claude-ws/settings.json` leaves the hooks (the groups marked `# grove-status`) where they are. A session outside
every project is in All sessions either way, under Working while its process is busy and under its day after. It is
never under Needs you: with the switch on it notifies, and its notification opens it in the editor.

## After a restart

Quitting Grove changes nothing for the agents. The hooks keep writing events into `.grove/events/`, and Grove reads
what it missed when it starts. What each session had left running is kept too, and the ones whose process is gone
are dropped. Sessions that went away mid-turn while it was closed are Stopped rows under Needs you,
without a notification. What you dismissed is in `reviewed.json`.

Closing VS Code ends the sessions in its tabs. One that was between turns shows as `Closed`, and opening it resumes
it. If what it ended on still needed you, its row stays under Needs you until you answer or dismiss it. One that was
mid-turn is Stopped.

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
- the record paragraphs in `CLAUDE.md`, swapped back to the `context/` text, only
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

Coming from 0.5: nothing of the record was ever installed, so there is nothing to remove. The agent inspector, token
counts, the archive of sessions and **New session...** went in 0.10 and are still gone. A project's sessions are a
screen again, and the conversation is back in the panel as turns, without the steps, the outline and the search it
had. The one-line summaries of subagents are not back: the model is asked for a session's recap instead.

## Limits

What ran: the unit tests, and Playwright driving the built app against fixture projects under a temp root, with
stand-ins for `code` and `claude`. The packaged app was opened the same way, once. The cleanup of 0.10's files runs
against a fixture project written by 0.10's own code.

What did not run, or does not work:

- no test drives a real editor tab, and the double-clicks (a row, a project) were only driven by Playwright's mouse
- no test drives a real Zed window. the Zed agent was run headless against Zed's Claude Code agent 0.91.0, and the
  rest of Zed's side is read from its source and its log
- you cannot answer from Grove, and Grove cannot wake an agent. you answer in the agent's chat
- no test runs the real `claude`. the recap prompt was tried by hand on six real sessions (13 calls): a short one, a
  60MB one compacted four times, one that ended on a question, one stopped mid-turn, one cut at a permission prompt and
  one with background tasks after its last message. Goal and Done were right in all six. Needs you was exact for the
  question and the permission prompt, and listed later work as well in the long ones
- a recap is a model's reading of a digest, and it can be wrong. the conversation under it is the session's own words
- the title prompt was tried by hand on 8 real sessions, from 3 to 85 prompts, at each point Grove would look at them
  (35 calls). no session changed its title more than once after the first: five changed once and three kept theirs.
  four of the five changes were broader (a TOCTOU check in one PR to every connector, a GCS fix to GCS and S3, a
  deploy-order question to the whole production rollout, recent-sessions search to the project manager). one went
  sideways, from the analysis a session began with to the design it turned into. descriptions changed more often than
  titles. 9 of the 35 calls took over 30 seconds (the longest 43), so a title call waits up to 60
- a title or a description is haiku's too, and can be wrong. `/rename` puts yours in its place for good
- that Claude Code retitles an open VS Code tab when a hook sets a title is read from its code, not seen. the
  transcript line and the `/resume` name were seen, with `claude -p` on 2.1.296
- a session no Grove hook covers gets its title in Grove only
- the title waits in a file until the session's next prompt or resume. one never resumed keeps it for 30 days
- the conversation has no steps, no thinking, no search, and at most the last 100 turns
- a working session's panel shows a new turn when the turn starts and ends, and otherwise catches up twice a minute
- the panel folds the whole transcript each time it reads it: 90ms for a 60MB one
- the notification with a recap's line was only run in unit tests
- a session started in a subfolder that has finished is not in its project's list or in All sessions, only in `⌘K`.
  the same goes for a scripted session outside every project
- a session outside every project never shows under Needs you, whatever it waits on
- a list comes from the main process whole, and Older is paged in the page. built on a machine with 326 sessions, not
  tried with thousands
- the search asks what was said once per query, up to 200 sessions. one that says the words later shows when you type
  again
- typing in the search closes the panel when its session is not found by title, prompt or branch, even if what was
  said in it still matches
- two quick VS Code starts in one project leave one conversation
- a project's colour is one of nine. past nine projects two share one, and deleting a project can change the colour
  of a later one. archiving one changes none
- no test moves anything to the real Trash. under `GROVE_ROOT` a deleted project's folder is moved into
  `.grove/trash/` under that root, and that path is the one that ran
- archiving from the Edit project form leaves the form, and changes typed there that were not saved are lost
- Archived in the sidebar is closed again every time Grove starts
- starting an agent was only run against the stand-ins in 0.11, in the editor and in the background
- what a session left open across the upgrade from 0.10 does when it calls a record tool was not tried
- the Usage screen's cost is Grove's own pricing of the transcripts, not a bill. haiku is under by what Claude Code
  does not write down (19% of haiku 4.5 on the machine it was checked on, $4 of $5,658)
- haiku 5.5 is priced at its rate for prompts under 100K tokens, whatever the prompt
- fast mode would be priced as standard. no response on that machine was a fast one
- agent time is read from timestamps. a tool that really ran over 15 minutes counts for nothing, and a parent waiting
  on its own subagent counts in both (1.1% of the total there)
- usage from before 0.15 first ran is only there for the transcripts Claude Code had not deleted yet
- the extension's **Find session**, in a copy installed before 0.15, can drop the usage of transcripts that were
  deleted while the app was closed. the extension's own version did not change, so the app does not offer the newer
  copy
- past six projects or models in a range, the smallest are one row and one grey part of a bar, `Other`
- the Usage screen was run against fixture transcripts by Playwright, and its numbers against one real machine
- **Actual** was checked against one metered account's file. a plan account's windows were built from Claude Code's own
  schema and fixtures, never a real plan's file
- background tasks were checked on the built app with hand-written hook events: the hold, the menu bar, the row and
  the panel. no real `/loop` or Monitor session was watched through Grove from start to end
- a `/loop`'s wake-up was read in Claude Code's hook schema, not seen in a run. a cron was
- a task you stop from Claude Code's own task list while the session is idle stays in Grove until that session's
  next turn ends: nothing tells Grove before then
- a turn whose closing message is longer than 64KB loses the list in its hook, and Grove keeps the one from before
- a command counts a minute after the turn that left it ended, not a minute after it started
- a session with a `/loop` or a Monitor is under Needs you again each time a wake-up's turn ends, and notifies when
  that turn ran over a minute
- macOS on Apple Silicon only

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

`pnpm app:build` also builds the Zed agent, `apps/desktop/out/acp-proxy/grove-acp.cjs`, which the banner registers
from a checkout. `pnpm app:dev` does not.

`pnpm app:dev` refuses to start without `GROVE_ROOT`. A dev build beside the installed app would read the same
`~/claude-ws/.grove/events/` and take hook events away from it. Point `GROVE_ROOT` at any folder: it stands in for
`~/claude-ws`, and projects are created under it. `CLAUDE_CONFIG_DIR` moves Claude's config dir the same way, and the
e2e tests isolate themselves with both.

Under `GROVE_ROOT` the app behaves as a test root: no menu bar item unless `GROVE_TRAY=1`, notifications are recorded
and not shown, your shell's rc files are not run, and the real `claude` is never run (`GROVE_CLAUDE_BIN` names a
stand-in). A deleted project's folder is moved to `.grove/trash/` under that root and not to the Trash, so it frees
no disk until you empty that folder. `apps/desktop/scripts/dev.mjs` takes `--real-root` to use `~/claude-ws` anyway.

After `pnpm app:build`, `node apps/desktop/scripts/screenshots.ts <outDir>` saves every screen from the real app, in
light and dark, at 1280x800 and 880x600, against fixture projects.

The icon is an Icon Composer package, [apps/desktop/resources/Grove.icon](../apps/desktop/resources/Grove.icon). A build
on a Mac with Xcode 26 compiles it into the app, so macOS draws the glass and the dark, clear and tinted styles
itself: CI builds that way, and `pnpm app:package` does when it finds Xcode 26. Without it the app gets
[apps/desktop/resources/icon.png](../apps/desktop/resources/icon.png), one picture of the default style.
`node apps/desktop/scripts/make-icon.mjs` re-renders that PNG from the package, and needs
[Icon Composer](https://developer.apple.com/icon-composer/) installed.

Layout: `packages/core` is pure Node TypeScript with no runtime dependencies, and is the only implementation of the
transcript parser, the project model and the git layer. The app's main process and the extension both bundle core from
source.
