# Grove

_Tells you which Claude Code agents need you, and gets you to them._

Grove is for one person running many Claude Code sessions across several projects. It watches every session, says
which ones are waiting on you (a permission prompt, a finished turn, a failure, a session that stopped mid-turn), and
opens the one you pick in VS Code or Cursor.

In the repo:

- the app (`apps/desktop`, Electron, macOS) - the sidebar of projects, every session on one screen with the ones that
  need you on top, a project's sessions, search, opening and starting agents
- the core (`packages/core`) - the reader of Claude Code's transcripts and live status, the project model, the git
  layer
- the companion extension (`extension/`) - the few things that can only happen from inside VS Code or Cursor: landing a
  window on a session, starting a conversation with a prompt waiting, syncing a project's references, showing drift

Grove never types into a running session. It keeps files on disk, starts a session with one prompt when you ask for
one, and hands off to the editor. You answer an agent in the agent's own chat. The one thing it asks a model for is a
[recap](#recaps) of a session, through your own `claude`.

## First run

Needs macOS on Apple Silicon, git, VS Code or Cursor with the Claude Code extension, and the `claude` CLI for agents in
the background. Checked against Claude Code 2.1.286 and 2.1.287.

1. [Install it](#install-it) and open it. With no project yet, the window is the **New project** form
2. Give the project a name and the repos the work needs, then **Create project**. Grove makes the project's folder
   under `~/claude-ws/`, with a working copy of each repo
3. If a banner offers to install the Grove extension into your editor, take it: landing on a session and starting a
   conversation both go through it
4. **New session** opens the project in your editor on a new Claude conversation. Say there what it should do
5. Watch **All sessions**: the ones that need you are on top, from any project. A click opens one in a panel beside
   the list, a double-click opens it in the editor, which is where you answer. **Dismiss** clears a row

## A project is a folder

A project has a name, a line about what it is for and the repos the work needs. It owns a directory, `~/claude-ws/<project>/`. That
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

**About** is one line on what the project is for, under 500 characters. It opens the project's `CLAUDE.md` when the
project is made. A session does not start from it: a project is the folders work happens in, and each session has its
own ask.

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

### Archiving and deleting a project

**Archive** puts a project away. **Delete** gets its disk space back. They are different on purpose: use Archive for a
project you are done looking at, and Delete only when you want the space.

| | Archive | Delete |
| --- | --- | --- |
| the project folder, with its `CLAUDE.md`, `plans/`, `artifacts/`, `context/` and `.claude/` | kept | moved to the Trash |
| working copies | kept | removed with `git worktree remove`, never forced |
| the entry in `combos.json` | kept, with `"archived": true` | removed |
| your original clones, their branches, and Claude Code's transcripts | not touched | not touched |
| its sessions in Grove | on the project's own screen, and in `⌘K` | on All sessions, as sessions in no project |
| undo | **Unarchive** | none in Grove. the folder is in the Trash until you empty it |

Archiving changes nothing on disk. Grove keeps treating an archived project as a project: its hooks stay current, its
sessions are still read, and one that needs you still shows on All sessions, still counts in the sidebar, the menu bar
and the dock, and still notifies. What changes is what the lists show. The project moves under **Archived** in the
sidebar, and its quiet sessions leave All sessions. Its own screen still lists every one of them. **Unarchive** in its
top bar brings all of it back.

Archive is `⌘⇧A` on a project's screen, in `⌘K` (**Archive project**), at the foot of the Edit project form, and in
the delete dialog as **Archive instead**. Archiving the project on screen takes you to All sessions.

Delete removes the clean working copies first. A working copy with uncommitted work, or a locked one, stops it: nothing
is deleted, the dialog names the working copy, and you delete again once the work is committed or discarded. Then the
project leaves `combos.json` and its folder goes to the Trash. If the Trash refuses the folder, Grove says so and names
where the folder still is.

## The screens

The **sidebar** on the left has **All sessions** with the count of sessions that need you, over every project, and
[**Usage**](#usage) under it, then the projects in `combos.json` order. Each project has its own colour and, when any of its sessions needs you, their
count. The order never changes with the counts. A click on a project shows its sessions, a double-click also starts a
new session in it. **+** beside Projects opens the new project form.

Under the projects is **Archived**, when any project is [archived](#archiving-and-deleting-a-project): a row with how
many there are, closed until you click it. It opens by itself while an archived project is on screen. Open, it lists
them in a quieter grey, each with its colour and its count, and a click shows that project's sessions. Closed, the row
shows how many sessions in the archived projects need you. Archiving a project never changes another project's colour.

**All sessions** is the screen Grove opens on: every session, whichever project it is in, in groups.

- **Needs you** - the sessions waiting on you, newest first. Two lines each: the title, what it is at, its project,
  where it runs and when, then what it asks. Only these are counted in the sidebar, the menu bar and the dock
- **Working** - the sessions in a turn now. A second line says what each was last asked, and the time says how long
  the turn has run (`for 12m`)
- **Today**, **Yesterday**, then the two days before by their weekday - the rest by the day they last moved, newest
  first, one line each: the title, its project, where it runs, when
- **Older** - what last moved before the start of the day three days ago. It is closed, with its count, until you
  click it. Open, it draws 50 rows, and 50 more each time you scroll near its end. It is closed again whenever the
  screen comes up

A group with nothing in it is not there: when nothing needs you, the screen starts at Working or Today. The sessions
of a project are the ones a project's own screen lists (below). Sessions in no project are here too, with their
folder's name where the others have a project. A scripted one (`claude -p`, an SDK app) is listed only while it runs.
So is a session of an archived project: it is here while it needs you or is running, and on its project's own screen
after that.

The rows under Needs you:

| row | when | the line under it |
| --- | --- | --- |
| Needs permission | the session stopped on a permission prompt | the tool, and what it would act on |
| Your turn | its turn finished and you have not looked | the end of its last message |
| Failed | it stopped on an API error | the error |
| Stopped | it went away mid-turn: its window closed, it crashed, the machine rebooted, or its background run failed | what it was working on |

Once a session has a [recap](#recaps), the line under Your turn, Failed and Stopped is what the recap says you have to
do. A Needs permission row keeps the tool: that is exact, and it is what you answer.

Each state keeps one colour everywhere: orange for permission, the accent for your turn, red for failed and stopped,
green for working. **Dismiss** takes a row out of Needs you. Opening the session in the editor does the same for Needs
permission, Your turn and Failed, which come back on that session's next event. A Stopped row stays until it is
dismissed, the session runs again, or a week has passed. A dismissed session is still listed, under the day it last
moved, and the panel goes on to the next row that needs you.

A click on a project shows **its sessions**, all of them, in the same groups. A row has the title, the state, the
branch, where it runs and the time, and here Dismiss leaves the panel on the session. The list is the sessions started
in the project's folder, plus any started in a subfolder or a working copy that needs you or is running now. A
finished session in a subfolder is found from `⌘K`. The top bar also has **New session**, **Open in VS Code** for the
project's window, and **Edit**. An archived project's screen is the same list, with `Archived` after its name and
**Unarchive** where New session is. Both lists follow the sessions as they change, with no refresh.

**Search** is the field in the top bar, on both screens: every session on All sessions, the project's on a project's
screen. Typing narrows the rows at once to the ones whose title, prompt or branch has every word typed (on All
sessions the project's name counts too). A moment later Grove adds the sessions where the words are in what was said,
by you, the agent or its subagents. One found that way has a second line with the words around the match, marked.
One found by its branch has the branch marked on its row, and on All sessions, where a row shows no branch, on a
second line. While something is typed Older is not folded: its matches are listed. What is typed is cleared when you go to another
screen. `⌘K` still searches everything, including the sessions no list has.

**The panel.** A click on a row, in either list, opens that session in a panel on the right half of the window. Its
head has the state, the title, **Open in VS Code**, the project, the branch, where it runs, and the session's
[recap](#recaps): Goal, Done, Now, Needs you. Under that is the conversation, opened at its end. A turn is what you
typed, one line for the work (`12 steps · 3 files edited · 4m`) and the message the turn ended on. A compaction, an
interrupt and an API error are a line each. The steps inside a turn, its thinking and its tools' output are not shown:
those are in the editor. The panel gets the last 100 turns, with a prompt cut at 4,000 characters and a message at
8,000 (20,000 for the last one), and says how many older turns there are. It reads the transcript again when the
session's state changes, so a new turn shows when it starts and when it ends. A session that needs you has **Dismiss**
at the end. While the panel is open it follows the arrow keys, and when its row leaves the list it moves to the row
that took its place. `Esc` closes it. A double-click on a row opens the session in the editor.

**Usage** is one screen for the whole machine: what your agents used over a week, a month or a year. Three tiles
have the totals for the range, each with its change against the range before: **API-equivalent cost**, **Agent time**
and **Tokens**. A click on a tile picks what the chart under them measures. The chart is bars, a day each for `1W` and
`1M` and a week each for `1Y`, stacked by project in the project's own colour, with the sessions in no project as one
grey part. Pointing at a bar says its period, its total and its split, and the arrow keys walk the bars when the chart
has the keyboard. Under it are the same range **By project** and **By model**, and one line of smaller numbers:
sessions, subagents, cache hit rate, the most agents working at once, and the longest single turn. None of these
numbers is shown anywhere else in the app. [Usage](#usage) says where they come from.

**New project** and **Edit project** are one form: name, about, repos. Edit project also shows drift per repo and, when
Grove could not write the project's files, why. At its foot, away from Save, are **Archive** (or **Unarchive**) and
**Delete...**.

`⌘K` opens the palette: go to All sessions, Usage or a project, start a session there or in the background, switch long work,
repair working copies, archive or unarchive the project, delete it, settings. Archived projects are not in its list
of projects. They are a section of their own, **Archived**, once you type part of a name. Typing also searches every
Claude Code session on the machine, in a project or not: titles and prompts first, then everything that was said in
each session and by its subagents. `↵` on a session opens it in the editor.

The **menu bar** item shows how many sessions need you across all projects. Its menu lists the three newest, then what
is working, then **Open Grove** and **Quit**. A click on one that needs you opens the window on its row in All
sessions, with the panel open. Closing the window hides it: the app stays in the menu bar until it is quit.

What is working starts with one line that says whether Grove is keeping the Mac awake, how many sessions are working
and for how long it has held: `Keeping the Mac awake · 3 working · for 1h 12m`, `The Mac can sleep · nothing working`,
or `Keep awake is off · 2 working` with the switch off. Under it are the sessions that are mid-turn, up to five, each
with its project and how long its turn has run. They are what keeps the Mac awake. A click on one opens the window on
it. The times are to the minute: the menu is drawn again once a minute while something works.

What an agent wrote is not trusted. It is rendered as markdown without any HTML (a `<script>` shows as text), images
show their description, and only `http(s)` links open - in your browser, never in the app. A recap is plain text: it
is never markdown and never a link.

## Recaps

You run many sessions and forget what each one was for. A recap is four short lines Grove keeps for a session:

- **Goal** - what you wanted from it
- **Done** - what the agent did
- **Now** - where it stands: finished, blocked, waiting, stopped half way through what
- **Needs you** - what you have to do or decide, or nothing

It is written by the haiku model through your own `claude`, on your Claude login:

```
claude -p --model claude-haiku-4-5-20251001 --no-session-persistence --restricted --strict-mcp-config --permission-prompts none --tools ""
```

run from an empty temp folder with the prompt on stdin. Nothing is left on disk, no settings file is read (so Grove's
own status hooks do not fire for it), no MCP server starts, and the call has no tool: it can only answer. At most two
run at once, each for at most 30 seconds. A call takes 8 to 20 seconds.

What it is written from is a digest of the session, about 12KB at most: the title, the first three and the last eight
things you typed, Claude Code's own summary of the part it compacted away, the names of the files edited, the last
turn's tool calls by name and target, the message the last turn ended on, and what Grove knows about where the session
stands. A tool's output is never in it.

When one is written:

- when a session's turn ends, when it fails and when it stops mid-turn, so it is there when you look
- when you open the panel on a session that has none, or whose conversation has moved on since
- when you press **Write again** under it
- never while a session is working. its recap is from before the turn, and the panel says so

A recap is kept in `.grove/recaps.v1.json` with where the conversation ended when it was written, the newest 500. It
is old when the conversation has moved, not when the file has grown: Claude Code appends bookkeeping to a transcript
long after a turn is over. While a new one is being written the panel keeps the old lines and says so, and the row
goes back to the end of the last message.

**Write recaps with Claude** in Settings switches all of it off. With it off, with no `claude` to run, or when a call
fails or answers anything but the four lines, there is no recap and the panel is the conversation alone. A failed call
says nothing. It is made again when the conversation moves, when you open the panel a minute later, or on Write again.

The digest is an agent's words, file names and commands, so it is not trusted, and neither is what comes back. The
worst a session can do through it is get a wrong recap written about itself.

## Usage

Grove reads every transcript under Claude Code's projects folder, in a project or not, and counts three things per
day, by your machine's calendar.

- **API-equivalent cost** is what the same tokens would cost on the API at list prices. Grove prices it itself, from
  the token counts and a price table in the app: input, output, cache reads, and cache writes kept five minutes or an
  hour, each at its own rate, per model. If you are on a plan you are not billed this way, and Grove knows nothing
  about plans. A model the table has never heard of is priced as the newest of its family. One of no family is not
  priced at all: its tokens still count, and the screen says how many are left out of the cost
- **Agent time** is the time agents spent working, and every agent counts: three subagents working ten minutes at once
  is thirty minutes. It is not wall clock. It is counted from the times in the transcript: the wait for a response is
  the agent's, the wait for your next prompt is yours. A wait over 15 minutes, a wait on a question the agent asked
  you, and anything after a turn ended count for nothing. Durations are written in the unit that fits, the two largest:
  `52m`, `7h 12m`, `3d 4h`, `5w 6d`. A day there is 24 hours of agent work, a week 7 of those, a year 365
- **Tokens** is input + output + cache read + cache write, the advisor's included

**Peak agents at once** is the most transcripts with work in the same five minutes of a day, subagents counted.
**Longest run** is the longest single turn: from one of your prompts to the last thing the agent did before your next
one, as working time. **Cache hit rate** is cache read tokens over every input token.

The numbers outlive the transcripts. Claude Code deletes old transcripts (after 30 days unless you changed it). When
a transcript goes, Grove keeps its days in `.grove/usage-retired.json`, so the year view fills in as the year passes.
The usage of a project you delete from Grove is still counted, under **No project**. It only knows what it has read: usage from before Grove 0.15 first ran is there
for as long as the transcript still was.

The first time 0.15 runs it reads every transcript whole once, which takes a moment on a machine with many. The screen
is there meanwhile with what is counted so far, and says `Counting 120 of 330 sessions`. After that only what was
appended is read.

Checked against Claude Code's own `cost-state` record on the machine this was built on (297 sessions that have a
usable one): the cost is within 1.7% overall, opus 5.5 within 0.9%, fable 5.1 within 3.0%, and agent time within 1.8%
of its API and tool durations. Haiku is the exception: Claude Code makes haiku calls it never writes to a transcript,
so haiku 4.5 comes out 19% under ($16.53 against $20.42). `cost-state` itself is too low for the sessions where it
reset on a resume, which is why Grove does not use it.

## Notifications

Grove notifies when:

- a session asks for permission
- a session stops on an API error
- a session in a project goes away mid-turn. several within five seconds fold into one
- a turn that ran for over a minute finishes. one session notifies for this at most once in two minutes. it says
  what the session's recap says you have to do when the recap is there within 15 seconds, else the start of the last
  message. the other three are never held back

Nothing notifies about what the focused window already shows: on All sessions that is every project, on a project's
sessions that project. What stopped while Grove was closed shows under Needs you and does not notify.

A click opens the window on that session with its panel open: its row under Needs you in All sessions when it has
one, else its row in its project's sessions. A session that is in neither, or in no project, opens in the editor. The
dock badge carries the same count as the menu bar. **Notifications** in Settings switches them off.

A notification plays a short chime of Grove's own. macOS decides whether it sounds: System Settings, Notifications,
Grove.

## Staying awake

While any session Grove can see is mid-turn, Grove keeps the Mac and its display from going to sleep on their own, and
lets them go when the last turn ends. It is what `caffeinate -d -i` takes, held by Grove itself: no terminal and no
extra process. A laptop on battery with its lid shut still sleeps. A session waiting on you does not count. It holds
only while Grove is running: closing the window keeps Grove in the menu bar, quitting lets go. The menu bar's menu
says whether it holds, for how long and for which sessions. **Keep the Mac awake while agents work** in Settings
switches it off.

## Opening and starting agents

**Open in VS Code** (or Cursor, per Settings) depends on where the agent runs, which each row says in a chip:

| chip | what Open does |
| --- | --- |
| `VS Code`, `Closed` | opens the project's window and lands on the session, resuming it if it was closed. A session that ran inside a working copy opens that folder instead |
| `Background` | a session Claude Code's supervisor runs (`claude --bg`). resuming it anywhere else is refused while the supervisor holds it, so Grove runs `claude stop <id>` first, then lands. It asks before stopping one that is mid-turn |
| `Terminal` | does not land: a second process on a live conversation would be a copy of it. The project opens, and Grove says to quit the agent in its terminal first |
| `Headless` | `claude -p` or an SDK app. The same: the project opens, and it can be opened once it has finished |

Landing needs the companion extension in that editor. Without it the window opens and Grove says it could not land.

**New session** is in a project's top bar, on a project with no sessions, in `⌘K`, and a double-click on the project
in the sidebar. The project opens in VS Code
(or Cursor) on a new conversation in the Claude panel, and what the session should do is typed there. Grove asks
nothing first: a project is the folders work happens in, and each session has its own ask.

**Start a background session…** is in `⌘K` only. It asks what the session should do and runs `claude --bg -- <what you
typed>` in the project root, with nothing added. It needs something typed: a background session has no window, so you
cannot type to it later, and it has nothing else to start from. Grove shows it in the project's list and tells you when
it needs you. A double-click moves it into the editor (see the table above).

Grove does not start what it knows will fail: a missing project folder. A new session shows in the project's list once
it runs.

Starting a conversation in the editor needs Grove Companion 0.3.0 or later. With an older one, or none, the project
still opens and Grove says to start the conversation there.

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
  settings.json     optional: editor, binary paths, appearance, notifications, recaps, keep awake
  .grove/           cache and runtime - safe to delete
    events/         where session status hooks write
    interrupted.json  sessions whose process went away mid-turn, kept for a week
    recaps.v1.json  the recaps, by transcript. deleting it has them written again
    session-index.v1.json  the sessions as last read, with each one's usage by day. rebuilt from the transcripts
    usage-retired.json  the usage of sessions whose transcript is gone. this one cannot be rebuilt
~/Library/Sounds/
  Grove.wav         the notification chime, about 40KB. written at launch, and again whenever it differs from Grove's own
```

What you dismissed is a decision, not a cache, so it sits beside `combos.json` and not in `.grove/`. Entries the app
does not understand are left alone when it writes. Deleting `.grove/` loses the Stopped markers, and the
[usage](#usage) of every session whose transcript Claude Code has since deleted.

In `combos.json` a project with `"archived": true` is [archived](#archiving-and-deleting-a-project). Set it or take it
out by hand and the app follows. Only `true` means anything: the app never writes `"archived": false`, and drops any
other value the next time it saves the file. No other key of the project moves when it is archived.

Outside `~/claude-ws` and the projects' own folders the app writes two things: `Grove.wav`, and the opt-in status hooks
below, which are the one thing it writes inside `~/.claude`, and only in `settings.json`. It never writes Claude Code's
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
what it missed when it starts. Sessions that went away mid-turn while it was closed are Stopped rows under Needs you,
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
- you cannot answer from Grove, and Grove cannot wake an agent. you answer in the agent's chat
- no test runs the real `claude`. the recap prompt was tried by hand on six real sessions (13 calls): a short one, a
  60MB one compacted four times, one that ended on a question, one stopped mid-turn, one cut at a permission prompt and
  one with background tasks after its last message. Goal and Done were right in all six. Needs you was exact for the
  question and the permission prompt, and listed later work as well in the long ones
- a recap is a model's reading of a digest, and it can be wrong. the conversation under it is the session's own words
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
- macOS on Apple Silicon only

## Keyboard

No single letter is a shortcut: a letter only ever types, in the search or a form.

| | |
| --- | --- |
| `⌘K` | the palette: go to, project commands, find a session |
| `⌘1` `⌘2` `⌘3` | All sessions / the sessions of the project last on screen / Usage |
| `⌥↑` `⌥↓` | step through the sidebar: All sessions, then the projects that are not archived. Usage is not a stop |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` `⌘↑` `⌘↓` | move the active row |
| `↵` | open the active row's session in the panel beside the list |
| `⌘↵` | open it in the editor |
| `⌘D` | dismiss the active row |
| `⌘F` | search the sessions of the screen you are on. from a form it goes back to the form's list first |
| `Esc` | close the panel, then clear the search, then go back |
| `⌘N` `⌘O` `⌘E` `⌘R` `⌘,` | new project, open the project in the editor, edit project, refresh, settings. `⌘O` and `⌘E` do nothing on All sessions |
| `⌘⇧A` | archive the project on screen, or unarchive it. does nothing on All sessions or in a project's form |
| `←` `→` `Home` `End` | on Usage, with the chart focused: read the bar before, after, first, last |

No row looks active until a key says so: the first arrow or `↵` only shows which row the keyboard is on, and the next
one acts. After the mouse, `↵`, `⌘↵` and `⌘D` act at once on a row that already shows it is the one: the row under the
pointer, else the row open in the panel. With the panel open the arrows step from its row at once. The arrows only
ever land on rows that are drawn: not in Older while it is closed, and past the last row an open Older has drawn they
draw its next 50. In the search field the arrows and `↵` are still the list's. `Esc` does not leave a project form
that has changes.

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
stand-in). A deleted project's folder is moved to `.grove/trash/` under that root and not to the Trash, so it frees
no disk until you empty that folder. `apps/desktop/scripts/dev.mjs` takes `--real-root` to use `~/claude-ws` anyway.

After `pnpm app:build`, `node apps/desktop/scripts/screenshots.ts <outDir>` saves every screen from the real app, in
light and dark, at 1280x800 and 880x600, against fixture projects.

The icon is an Icon Composer package, [apps/desktop/resources/Grove.icon](apps/desktop/resources/Grove.icon). A build
on a Mac with Xcode 26 compiles it into the app, so macOS draws the glass and the dark, clear and tinted styles
itself: CI builds that way, and `pnpm app:package` does when it finds Xcode 26. Without it the app gets
[apps/desktop/resources/icon.png](apps/desktop/resources/icon.png), one picture of the default style.
`node apps/desktop/scripts/make-icon.mjs` re-renders that PNG from the package, and needs
[Icon Composer](https://developer.apple.com/icon-composer/) installed.

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
- **a project is missing from the sidebar** - it is archived. it is under Archived, at the foot of the projects
- **a session is missing from its project's list** - it was started in a subfolder and has finished. it is in `⌘K`
- **a session is missing from All sessions** - it last moved more than three days ago and is under Older, which is
  closed until you click it (search finds it without that). or its project is archived and it needs nothing: it is
  on that project's own screen. or it is one no list has: a finished one from a subfolder, or a scripted run outside
  every project. those are in `⌘K`
- **Delete project moved the folder to the Trash** - it always does now. Archive is what keeps everything
- **"Nothing needs you" is gone** - the screen that said it lists every session now. when nothing needs you there is
  no Needs you group, and the menu bar still says it
- **a session has no recap** - it is working, the switch is off, `claude` was not found (set its path in Settings), you
  are not logged in to Claude Code, or the call failed. a failed one is tried again a minute later
- **a recap says something the session did not** - it is haiku's reading of a digest. Write again asks once more
- **`claude -p` runs show up in Activity Monitor** - those are the recap calls, two at most
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
