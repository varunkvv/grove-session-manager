# Grove

_A session and workspace manager for Claude Code._

Named multi-repo workspaces ("combos") for Claude Code, and a search across every Claude Code session on the machine.

Two pieces:

- **the app** (`apps/desktop`, Electron) - the session finder, combos, worktree lifecycle, launching the editor
- **the companion extension** (`extension/`) - the few things that can only happen from inside VS Code or Cursor: landing a
  window on a session, syncing a combo's references, showing drift

The app never drives Claude. It owns directories on disk and hands off to the editor.

## How it works

A combo owns a directory, `~/claude-ws/<combo>/`. That directory - not any of your repos - is the primary workspace folder,
so it is Claude's working directory. Two things follow:

- sessions started there land in their own `~/.claude/projects/<slug>/`, so the combo's sessions are a directory listing,
  not a guess. sessions started by hand, from a terminal, or while the app was closed are picked up the same way
- the Claude Code panel's own history is already scoped to the combo

Folders in a combo are one of:

| mode | what it is | when |
| --- | --- | --- |
| working copy | a `git worktree` inside the combo folder. detached at HEAD by default, so two combos can hold the same repo | you will edit here |
| reference | your real clone, added as a second workspace root and to `permissions.additionalDirectories` | context to read |

The combo dialog lists the folders you use most as one-click chips: the repos your sessions ran in (a session started
in a subfolder counts toward its repo), and folders already in other combos, ranked by how often and how recently.
The file picker is still there for anything else.

A working copy starts clean. Your uncommitted changes, dev servers and editor state stay in the original clone.

### What a session in a combo is told

Every session started in the combo root loads its `CLAUDE.md`, forks and background agents included. The stub says
what the folder is (a combo of git worktrees, and what a worktree implies), where plans and generated artifacts go
(`plans/`, `artifacts/` - never inside a working copy), and how to leave word for other sessions: several can work in
one combo at once without sharing a conversation, so `context/` is the memory they have in common.

### Long work in the background, as a switch

By default a combo tells Claude to hand long autonomous work to a background agent, so the conversation stays free to
answer questions and plan. Three files do it:

- `.claude/agents/long-task.md` - an agent with `background: true` in its frontmatter. A subagent never sees the
  conversation that spawned it, which is what the plan file is for: the plan in `plans/` is its brief
- `.claude/long-work.md` - the policy: background, or here in the conversation. The app owns this file
- `CLAUDE.md` only says "read `.claude/long-work.md` before long work, every time"

The indirection is the point. `CLAUDE.md` is read once, when a session starts, so a switch written there could never reach
a session that is already running. The policy file is read at the moment of decision, so flipping it takes effect on a
running session's next long task. Flip it in the app (the switch in an open combo) or from the editor
(`Grove: Toggle Background Long Work`). Saying "do this one here" in the chat overrules it for a single task.

It is a default by instruction, not an enforcement: Claude still decides what counts as long.

### Needs you

Run a few sessions at once and the slow part is noticing that one of them stopped: it wants permission for a
command, or it finished its turn twenty minutes ago in a window you are not looking at. Grove pins those sessions to
the top of the list under **Needs you**, badges the combo and the dock icon, and sends a notification when a session
asks for permission or finishes a turn that ran for over a minute. Clicking the notification brings Grove forward on
that session: in the Inbox with the query cleared, its conversation open at the end where the question is - or, when a
subagent is the one asking for permission, that agent's detail. Answering is one click from there, with the pane's open
button (Terminal for a session running in the background). If it stopped waiting before the click, it lands in all
sessions instead. Looking is not answering: nothing is marked seen. A click that starts the app lands the same way,
once the page is up.
Running sessions show a quiet "Running".

**Inbox** (`⌘4`, first in the scope switch, with the count in the accent while anything waits) is the same set of
sessions on its own, each saying what it waits for: the command or file a permission prompt is about (`Bash  pnpm
test`), or the last paragraph of the message a turn stopped on - where the question almost always is (read from the end
of the transcript when the hook's copy was cut short). Every row keeps both ways out in sight: a click reads it in the
pane, and **Open in VS Code** (**Open in Terminal** for a session Claude Code runs in the background) goes to answer it,
as a double-click or `↵` does. `⌘D` marks it seen and it leaves the inbox; opening it to answer counts as seeing it.

The transcript cannot tell "running a tool" from "waiting on a permission prompt", so this comes from Claude Code
hooks. Every combo's `.claude/settings.local.json` gets a few async hooks (`UserPromptSubmit`, `PermissionRequest`,
`PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart`, `SubagentStop`) that drop the
hook's input into `~/claude-ws/.grove/events/`. Claude Code watches its settings files, so sessions that are already
running pick the hooks up too - and later write the copy they loaded at startup back over them, which silently drops
whatever was added since. So the app watches each combo's settings file and puts its own entries back when that happens.
Only the entries carrying its marker are touched. Sessions outside combos report only if you switch on **Track sessions
outside combos** in Settings, which adds the same hooks to Claude Code's own `settings.json`; switching it off takes
them out again. While it is on, that file is watched and repaired the same way - a session running outside any combo
can put its old copy back just like one inside - and both are checked again whenever the window comes forward.

Hooks only cover the sessions that have them. Every live Claude Code process also keeps a file in
`~/.claude/sessions/<pid>.json`, which the app reads (never writes) to fill in sessions no hook covers and to retire a
"Running" whose process is gone. Anything a hook said wins: a permission prompt is something only a hook can see.

Landing on a session, or **Mark as seen** in its action menu, takes it out of the list until its next event.

### Sessions that keep going in the background

A session started in the Claude Code panel is a child of that VS Code window, so it ends when the window does.
Claude Code ships its own supervisor for sessions that should outlive every terminal and editor: `claude --bg`,
`claude agents`, and a daemon that runs them. Grove does not supervise anything itself. It is the bridge between the
two: it shows what the supervisor runs, lands on those sessions without breaking them, and hands a session over.

- **Seeing them.** A session the supervisor knows carries a quiet **Background** on its row, with its state
  (working, blocked, done, failed, stopped) and what it waits on in the tooltip. That comes from
  `claude agents --json --all`, asked at startup, when the window comes forward, when a background process comes,
  goes or changes in the live registry, and after anything Grove runs - never on a timer. A background session in
  a combo reports through its hooks like any other. One outside every combo that is blocked on you lands under
  **Needs you** from that list instead.
- **Landing on one.** While the supervisor holds a session, resuming it anywhere else is refused, so the row offers
  **Open in Terminal (attach)** first, then **Stop and open** in your editor (it asks first if the session is
  mid-turn), and **Stop background session**. The usual land actions are not offered on it.
- **Handing one over.** **Continue in background…** on a session nothing is running asks for the prompt to send
  (`continue where you left off` to start with), then runs `claude --resume <id> --bg` in the session's own folder.
  It carries on under the same id and transcript. It is not offered while a panel or terminal still has the session
  open: that would start a copy. **New background session…** in a combo's menu starts one in the combo root.
- **Interrupted.** A session that was running when its process went away (a window closed on it mid-turn, a crash,
  a reboot) keeps a quiet **Interrupted** marker, and **Continue in background…** becomes its first action. So does
  a background run that failed. The fact is kept in `.grove/interrupted.json`, so it is still there after a reboot,
  and it clears as soon as the session shows a sign of life.

What survives what: closing the terminal or the editor, yes. Sleep pauses it, and it picks up on wake. A reboot
stops it, and it comes back as interrupted - Grove never restarts anything on its own.

A background session keeps the environment it was dispatched with for good, and an app opened from Finder has
almost none (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`: no node, no pnpm, no gh). So every `claude` Grove runs for this
gets your login shell's environment, read once per app run.

Since Claude Code 2.1.281, a folder has to have passed the CLI's trust prompt once before anything can be sent to the
background there, and a combo only ever opened from VS Code has not. The first time, **Continue in Terminal** runs
the same command in Terminal, where the prompt can be answered. Every later hand-over there works directly. Grove
never writes that trust itself.

Grove only ever calls Claude Code's own commands for all of this: `claude agents --json --all`,
`claude --resume <id> --bg -- <prompt>`, `claude --bg --name=<name> -- <prompt>`, `claude attach <id>` in Terminal
and `claude stop <id>`. Never `claude rm`, never `claude daemon`, and never a permission flag - a background session
that stops on a permission prompt shows up under **Needs you**, and attach is where it gets answered.

### What is running inside a session

A session grinding away alone and a session with five agents fanned out look the same from the outside. Rows show
their subagents - how many, and for the running ones what kind and how long they have been at it. The row's tooltip
says what each agent was asked to do and the last tool it picked up, and the inspector (below) has the rest.

It comes from `~/.claude/projects/<slug>/<sessionId>/subagents/`, where each agent writes its own transcript next to an
`agent-<id>.meta.json` holding the label its parent gave it. Nothing there records when an agent ended, so the exact
times come from the `SubagentStart` / `SubagentStop` hooks, and an agent that started before the app was watching falls
back to a guess: quiet for two minutes counts as finished, and nothing of a session whose process is gone is still
running. Every session is scanned, not only the live ones - what the agents of last Tuesday's session did is worth
a look, and reading the whole machine's takes a few milliseconds.

The tooltip also carries one line per running agent saying what it is actually doing, written by Claude Haiku reading
the tail of that agent's own transcript - the session doing the work is never interrupted and never asked, because
asking it would cost a whole turn on its full context. It runs every 30 seconds per agent, only while the window is
open, only when the transcript has moved since the last one, two at a time. It spends your own Claude auth, so
**Summarise what each running agent is doing** in Settings switches it off.

A finished agent gets one line too, on what it found or did, the first time it is on screen - its row in the
inspector, or its detail. Its transcript will never change again, so the line is asked for once, ever, and kept in
`.grove/agent-lines.v1.json`. Nothing is summarised that nobody looked at: history is not worth anyone's tokens until
someone opens it. The same switch turns it off.

### Reading a session

A click on a session reads it: a pane opens beside the list with the session's whole conversation, and it follows the
selected row like a mail app's reading pane. Going to the session is the deliberate act - a double-click, `↵`, the
**Open in VS Code** button at the top of the pane, or the quiet **Open** a row shows in place of its time while the
pointer is on it. All four do what `↵` always did: a session at a combo's root opens its combo and lands on it, a
session Claude Code runs in the background opens where it runs (so the button says **Open in Terminal**), anything else
takes the first way in. `⋯` beside the button has every other way in. The pane's first opening waits out a
double-click, so the list moving under the pointer never turns a double-click into two things.

The conversation reads as turns: what was asked, in a raised block exactly as it was typed (a slash command in mono, a
background task finishing as one quiet line, pasted images as a count), then one quiet line for the work - how long,
how many steps, files edited, agents started - and the answer. Open the work line for every step, drawn the way an
agent's steps are. What is the conversation rather than the work stays in sight without opening anything: a plan it
proposed and whether it was taken, a question it asked and what was picked, what you typed while it worked, a
compaction, an interrupt, an error it ended on. Days get headers when a session spans more than one. It opens at the
end; while the session runs its newest turn is open and follows what it writes, with **Jump to live** when you scroll
away. `Tab` moves into it, `↑` `↓` step through prompts, work lines and open steps, `↵` opens and closes, `←` goes back
to the list. With a search in the box it opens at the turn that said it, with the words marked. The transcript is
folded in the main process and kept in `.grove/conversations.v1/` - the 107MB one on this machine opens in about a
quarter of a second the first time and a tenth after that - and only the part appended since is ever read again.

An opened step shows what the tool did rather than its JSON: an edit or a new file as a diff (line numbers, added and
removed lines on a faint tint - taken from Claude Code's own patch, never from the file), a command as `$ command`
with its output and its stderr apart, a todo list as a checklist, a question with every option and the one picked, a
plan in full. A result too big for the transcript says where Claude Code saved it, without reading it. The JSON input
is one quiet click away on every step, and an agent's detail draws its steps the same way. An `Agent` step goes to that
agent's detail, and back (or `Esc`) returns to the conversation exactly where it was, open steps and all.

The header says where the session ran, its branch, the model of its last response, how long it went on and how many
tools it called. A session with agents gets **Conversation · Agents** under it. The pane starts at half of what the
rail leaves (at least 480px, at most 960px, and the list always keeps 420px); drag its left edge to change that - the
width is remembered - and double-click the edge to go back to half. A window too narrow for both gets the pane over
the list instead.

### What the agents did

`⌘I`, a click on a row's agents, or **Inspect agents** in its action menu opens a pane beside the list with what that
session's agents did. It follows the selected row like a mail app's reading pane: open it once, then move through the
list. At the top is one lane per agent, from its start to its end. The axis spans the agents' own window - first start
to last end - so a session open for two days whose agents ran in a twenty-minute burst does not come out as slivers.
Under it, one row per agent: what it was for and how long it ran, its type, tool calls and tokens, and what it came
back with (while it runs, what it is doing). An agent that died on an API error is the only colour in the pane.
`Tab` moves into the pane and the arrows move there, `Esc` steps back out, and the next `Esc` closes it. A window too
narrow for both gets the pane over the list instead of a crushed list.

The numbers come from each agent's own transcript, read when you look - never for every row. Tokens are what Claude
Code itself reports for an agent: the context its last response ran with, not a sum over every response. A finished
agent's reading is kept in `.grove/`, keyed by its file's size and time, so the next look is one file read.

Click an agent (or `↵` on it) for everything it did, in place of the list. Its result comes first - it is the answer
to "what did it do" - then what it was asked, then every step: one quiet line per tool call with what it was about and
how far into the agent's life it came, and the agent's own words between them, where it explains itself. A failed step
says how (`exit 1`, `rejected`) in the pane's one colour. Runs of the same tool fold into one line (`Read ×6`), and
thinking stays hidden behind **show thinking**. A step opens in place to its whole input and what came back, read
from the transcript at that moment - the pane never holds a tool's output until you ask for it. An `Agent` step goes
to the agent it started. `Esc` or `←` goes back to the list.

An agent that is still running keeps writing while you look. Its steps arrive as it writes them - only the part of
its transcript appended since the last look is read, at most four times a second, and only for the agent on screen -
and the list follows the newest one. Scroll up and it stays where you put it, with **Jump to live** to get back. What
it is doing now stays pinned under its name.

**Agents** (`⌘3`, beside a combo's sessions and all of them) is every agent on the machine in one list: the ones still
running first, then by the day they last did something, each with the session it ran in under its name. Selecting one
opens the inspector on it, so `↑` `↓` walk through what every agent did without opening a single session. A workflow's
agents carry no label of their own, so they go by the first line of what they were asked.

What an agent wrote is not trusted: a result quotes web pages and files. It is rendered as markdown without any HTML
(a `<script>` in a result shows as text), images show their description, and only `http(s)` links open - in your
browser, never in the app.

### Search reaches the whole conversation

Typing filters titles and prompts instantly. A moment later the app also looks through everything that was said in
each session (what you typed, what Claude wrote back, and the files and commands its tools touched), and those
matches join the list with the line that matched. Tool output and thinking are left out: they are most of the bytes
and almost none of what people remember. The text is kept in `.grove/text/`, built by the same pass that counts
tokens, and only the appended part of a transcript is read after the first time.

It reaches what a session's agents said too: what each was asked, what it wrote, the files and commands it used, and
what it came back with - never the output of its tools, which is other people's file contents and would drown every
query. A session found that way says so on its second line (`in Explore: …what it said…`); clicking that line, or
`⌘I`, opens the inspector on that agent at the step that matched. In **Agents** the agent itself is the match. An
agent still writing after its session went quiet is read again as it writes, from where it stopped.

### Archive

A session you are done with but do not want deleted: **Archive** in its action menu, or `⌘⇧A`. It leaves the list and
the search, and `is:archived` in the search box brings the archive back - on its own, or next to any other words.

Nothing is hidden without saying so. When a search would have matched archived sessions, the line under the list says
how many, beside the count of matches outside the current combo. Clicking it shows them.

An archived session that needs you still appears under **Needs you**, still badges the dock and still sends its
notification. Archiving is about noise, not muting: a permission prompt nobody sees is worse than a row nobody wanted.

The decision lives in `~/claude-ws/archived.json`, keyed by session id rather than by transcript path - a path moves
when Claude Code relocates a transcript, and one conversation can sit in more than one project dir. It is a decision
and not a cache, so it sits beside `combos.json`, is hand-editable, and entries the app does not understand are left
alone when it writes. This is Grove's own archive. The Claude Code panel has one too, and the two are unrelated.

### Tokens per model

Every row shows what the session spent, per model (the two biggest on the row, all of them in the action menu), subagents
included. The counts come from `message.usage` on each response in the transcript. That is the one thing that needs the
whole file, so it is read once in a background pass after the list is up, then only what was appended. Cache reads and
writes match Claude Code's own `/cost`. Its input and output run a bit higher, because it also counts side calls (titles,
compaction) that are never written to the transcript.

## Keyboard

The search field keeps focus while the arrows move the active row, so a bare letter always types.
Every shortcut carries a modifier.

| | |
| --- | --- |
| `↵` / `⌘↵` | open the active session (the offer list, or the first offer without showing it). A click reads it in the pane, a double-click opens it |
| `↑` `↓` `PgUp` `PgDn` `⌘↑` `⌘↓` | move the active row |
| `⌥↑` `⌥↓` | step through combos |
| `⌘1` `⌘2` `⌘3` | this combo's sessions / all sessions / every agent |
| `⌘4` | the inbox: everything waiting on you |
| `⌘K` | the active row's actions |
| `⌘I` | the pane: the active session's conversation, or what its agents did. `Tab` moves into it, `Esc` steps back out |
| `⌘D` | mark the active row as seen |
| `⌘⇧D` | mark everything under **Needs you** as seen |
| `⌘⇧A` | archive the active session, or bring it back |
| `⌘⇧C` | copy its resume command |
| `⌘F` / `/` | search |
| `Esc` | close what is open, then clear the query |
| `⌘N` `⌘O` `⌘E` `⌘R` `⌘⇧R` `⌘,` | new / open / edit combo, refresh, repair, settings |

`⌘D` and `⌘⇧D` do nothing on a row that is not asking for anything, and neither moves the selection.
The action menu shows the key next to the action that does the same thing.

## On disk

```
~/claude-ws/
  combos.json                   source of truth. hand-editable. unknown keys and formatting are preserved
  archived.json                 sessions you put away, by session id. hand-editable, same treatment
  settings.json                 optional: editor, binary paths
  .grove/                       cache only - safe to delete. events/ is where session status hooks write
  <combo>/
    <combo>.code-workspace      generated. only `folders` is ours, the rest is preserved
    CLAUDE.md                   written once when the combo is created. yours after that
    plans/  artifacts/  context/  made once, with the root. where sessions keep what outlives them
    .claude/agents/long-task.md written once. `background: true`, so long work never blocks the conversation
    .claude/long-work.md        generated. whether long work goes to that agent. flips mid-session
    .claude/settings.local.json only our entries in permissions.additionalDirectories are touched
    <repo>/                     working copies
```

The app never writes inside `~/.claude` (the one exception is the opt-in status hooks above, and only in
`settings.json`), never copies a transcript, never deletes a branch, and never runs
`git worktree remove --force` unless you confirm it for one specific folder. The `claude -p` the agent summariser
spawns is Claude Code keeping its own house: it holds a `sessions/<pid>.json` while it runs and removes it on the way
out, and writes no transcript at all.

Drift is normal: people run `git worktree remove` and `rm -rf` behind the app's back, and Claude Code expires transcripts.
Folder states are `ok`, `reference`, `absent`, `stale`, `foreign` (left alone) and `missing-origin`.

## Develop

Needs node >= 22.12, pnpm 10, git >= 2.36.

```bash
pnpm install
pnpm test               # core + extension + app logic (vitest, real throwaway git repos)
pnpm typecheck && pnpm lint

pnpm grove list            # every session on this machine, straight from the core
pnpm grove search queue
pnpm oracle --strict    # diff our index against the Agent SDK's listSessions() (cd tools/oracle && pnpm install --ignore-workspace --no-optional first)

pnpm app:dev            # the app, with hot reload
pnpm app:e2e            # Playwright drives the real built app against temp fixtures
pnpm ext:package && pnpm ext:install        # or ext:install:cursor
pnpm app:package        # apps/desktop/dist/*.dmg, ad-hoc signed
pnpm app:packaged       # smoke test the packaged app
```

The icon is [apps/desktop/resources/icon.svg](apps/desktop/resources/icon.svg); `node apps/desktop/scripts/make-icon.mjs`
re-renders the PNG that electron-builder turns into the `.icns`.

Layout: `packages/core` is pure Node TypeScript with no runtime dependencies, and is the only implementation of the
transcript parser, the combo model and the git layer. The app's main process and the extension both bundle it from source.

`GROVE_ROOT` and `CLAUDE_CONFIG_DIR` move the app root and Claude's config dir. The e2e tests isolate
themselves with them.

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

It follows the macOS appearance, light or dark, and switches with it. Settings → Appearance pins it
to one.

## Things people will report as bugs

- **a session disappeared** - Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`). the VS Code panel also
  archives sessions after 14 days idle (`claudeCode.archiveInactiveSessions`). those still show here - only the ones
  you archived yourself are hidden, and `is:archived` brings them back
- **"2d ago" does not match the file's date** - rows sort by the last message, not the file's mtime. Claude Code appends
  title records to old transcripts long after the conversation ended
- **the app does not open from a download** - it is ad-hoc signed. `xattr -dr com.apple.quarantine "Grove.app"`
- **landing opened a fresh conversation** - the companion extension is not installed in that editor (the app shows a banner
  and can install it), or the transcript expired

The transcript format is internal to Claude Code and changes between releases. What this project relies on, and how it was
verified, is in [docs/claude-code-facts.md](docs/claude-code-facts.md).

## License

MIT. Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
