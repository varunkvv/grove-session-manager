# Grove

_Tells you which Claude Code agents need you, and gets you to them._

[![ci](https://github.com/varunkvv/grove-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/varunkvv/grove-session-manager/actions/workflows/ci.yml)

Grove is for one person running many Claude Code sessions across several projects. It watches every session, says
which ones are waiting on you (a permission prompt, a finished turn, a failure, a session that stopped mid-turn), and
opens the one you pick in VS Code, Cursor or Zed.

Grove never types into a running session. It keeps files on disk, starts a session with one prompt when you ask for
one, and hands off to the editor. You answer an agent in the agent's own chat. The one thing it asks a model for is a
[recap](#recaps) of a session, through your own `claude`.

## First run

Needs macOS on Apple Silicon, git, VS Code or Cursor with the Claude Code extension (or Zed with its Claude Code agent),
and the `claude` CLI for agents in the background. Checked against Claude Code 2.1.286 and 2.1.287.

1. [Install it](#install-it) and open it. With no project yet, the window is the **New project** form
2. Give the project a name and the repos the work needs, then **Create project**. Grove makes the project's folder
   under `~/claude-ws/`, with a working copy of each repo
3. If a banner offers to install the Grove extension into your editor, take it: landing on a session and starting a
   conversation both go through it
4. **New session** opens the project in your editor on a new Claude conversation. Say there what it should do
5. Watch **All sessions**: the ones that need you are on top, from any project. A click opens one in a panel beside
   the list, a double-click opens it in the editor, which is where you answer. **Dismiss** clears a row, and so does
   opening it

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

A turn that ends while a background subagent it started is still working is your turn: what it ended on (often a
question) is under Needs you. The subagent keeps the Mac awake while its tool calls keep coming in, and once you have
answered or dismissed that row the session is under Working while it does. When it finishes, its result starts a short
turn of its own. The question stays under Needs you through that turn, and the turn's end notifies however short it was.

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

- **Needs you** - the sessions waiting on you, newest first. Three lines each: the title, what it is at, its project,
  where it runs and when, then its [description](#titles-and-descriptions), then what it asks after a small arrow in
  the state's colour. Only these are counted in the sidebar, the menu bar and the dock
- **Working** - the sessions in a turn now, with their description under the title. The time says how long the turn
  has run (`for 12m`). With them are the sessions that are **Watching**: between turns, with a
  [background task](#background-tasks) left running. Under the description they say what they left and what it last
  wrote, and the time says how long they have watched
- **Today**, **Yesterday**, then the two days before by their weekday - the rest by the day they last moved, newest
  first: the title, its project, where it runs, when, and the description under it
- **Older** - what last moved before the start of the day three days ago. It is closed, with its count, until you
  click it. Open, it draws 50 rows, and 50 more each time you scroll near its end. It is closed again whenever the
  screen comes up

A session with no description yet is a line shorter: a working one says what it was last asked in its place, and a
row under Needs you gives what it asks two lines. A session gets one once a turn of it has done some work, so a
"hey" never does.

A group with nothing in it is not there: when nothing needs you, the screen starts at Working or Today. The sessions
of a project are the ones a project's own screen lists (below). Sessions in no project are here too, with their
folder's name where the others have a project. A scripted one (`claude -p`, an SDK app) is listed only while it runs
or watches. So is a session of an archived project: it is here while it needs you, is running or is watching, and on
its project's own screen after that.

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
green for working and for watching. Working is a dot that pulses, watching a ring that does not. A Needs permission,
Your turn or Failed row stays until you answer it, **Dismiss** it or open it from the main window. Answering is a prompt
you send (in a chat window, the editor or the terminal), an answer to a card in a chat window, or approving or denying
a permission anywhere. Opening it from the main window (a double-click, **Open**, `⌘K`, `↵`) does what Dismiss does,
a Stopped row too. Landing on it from a notification or the menu bar, or its chat window having the keyboard, does not
take it out.
Nor does Claude starting a turn of its own: a background command or agent ending, a Monitor event, a cron or a `/loop`
firing. Its row stays under Needs you with the working dot beside what it is at, and that turn's end takes its place.
Closing the session's editor tab or terminal does not take it out either, and it does not age out. A dismissed row
comes back on what that session needs next. A Stopped row stays until it is dismissed or opened, the session runs again,
or a week has passed. A dismissed session is still listed, under the day it last
moved, and the panel goes on to the next row that needs you.

A click on a project shows **its sessions**, all of them, in the same groups. A row has the title, the state, the
branch, where it runs and the time, and here Dismiss leaves the panel on the session. The list is the sessions started
in the project's folder, plus any started in a subfolder or a working copy that needs you, is running now or is
watching. A finished session in a subfolder is found from `⌘K`. The top bar also has **New session**,
**Open in VS Code** for the project's window, and **Edit**. An archived project's screen is the same list, with
`Archived` after its name and **Unarchive** where New session is. Both lists follow the sessions as they change, with
no refresh.

**Search** is the field in the top bar, on both screens: every session on All sessions, the project's on a project's
screen. Typing narrows the rows at once to the ones whose title, description, prompt or branch has every word typed (on All
sessions the project's name counts too). A moment later Grove adds the sessions where the words are in what was said,
by you, the agent or its subagents. One found that way has the words around the match, marked, where its
description was.
One found by its branch has the branch marked on its row, and on All sessions, where a row shows no branch, on a
second line. While something is typed Older is not folded: its matches are listed. What is typed is cleared when you go to another
screen. `⌘K` still searches everything, including the sessions no list has.

**The panel.** A click on a row, in either list, opens that session in a panel on the right half of the window. Its
head has the state, the title, **Open in VS Code**, the session's description, the project, the branch, where it
runs, and its [recap](#recaps): Done, Now, Needs you. The recap's Goal is there only while the session has no
description: the description says the same, and is not written again every turn. A session that left something running has **Background tasks** above
the recap, whatever it is at: each task, how long Grove has seen it, and one line of status. Under that is the
conversation, opened at its end. A turn is what you
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

A switch beside the title picks what the screen shows: **API-equivalent** is all of the above, **Actual** is your
account's own usage limits and how much of each is used, the numbers Claude Code's `/usage` shows. On a usage-based
(metered) account that is what was spent against the cap. On a plan it is each window, 5-hour and weekly, with when it
starts over. A bar there is grey, orange close to its limit and red at it. Grove keeps the choice. With none made, a
metered account opens on Actual and any other on API-equivalent. [Actual usage](#actual-usage) says where it comes from.

**New project** and **Edit project** are one form: name, about, repos. Edit project also shows drift per repo and, when
Grove could not write the project's files, why. At its foot, away from Save, are **Archive** (or **Unarchive**) and
**Delete...**.

`⌘K` opens the palette: go to All sessions, Usage or a project, start a session there or in the background,
repair working copies, archive or unarchive the project, delete it, settings. Archived projects are not in its list
of projects. They are a section of their own, **Archived**, once you type part of a name. Typing also searches every
Claude Code session on the machine, in a project or not: titles and prompts first, then everything that was said in
each session and by its subagents. `↵` on a session opens it in the editor.

The **menu bar** item shows how many sessions need you across all projects. Its menu says the count again, `2 need
you`, and lists the three newest by title, each with its project and what it asks under it. A row that is not a
finished turn says so first: `Needs permission`, `Failed` or `Stopped`. Then what is working, then **Open Grove** and
**Quit**. A click on one that needs you opens the window on its row in All sessions, with the panel open, and
`and 2 more` opens All sessions. Closing the window hides it: the app stays in the menu bar until it is quit.

While the Usage screen is on **Actual** and the account has a limit, the menu bar shows how much of it is used beside
the count: `2  21%`, or `21%` with nothing waiting. On a plan that is the window nearest its limit. The tooltip and a
line above **Open Grove** say it in words, `21% of your $2,000 limit used`, with how long ago Claude Code fetched it, and
on a plan when that window resets: `63% of your weekly limit used · resets in 2d 4h`. A number Claude Code fetched
more than a day ago leaves the title, and the tooltip and the menu still say it with its age. The share is rounded
down, as `/usage` rounds it. On **API-equivalent** the menu bar says nothing of usage.

What is working starts with one line that says whether Grove is keeping the Mac awake, how many sessions are working
or watching and for how long it has held: `Keeping the Mac awake · 3 working · 1 watching · for 1h 12m`,
`The Mac can sleep · nothing working`, or `Keep awake is off · 2 working` with the switch off. Under it are the
sessions that are mid-turn, each with its project and how long its turn has run, then the ones watching, each with
its project and the first thing it left running. Up to five in all. They are what keeps the Mac awake. A click on one
opens the window on it. The times are to the minute: the menu is drawn again once a minute while something works or
watches.

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

What it is written from is a digest of the session, about 12KB at most: the title and the description, the first three and the last eight
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

**Write recaps, titles and descriptions with Claude** in Settings switches all of it off. With it off, with no `claude` to run, or when a call
fails or answers anything but the four lines, there is no recap and the panel is the conversation alone. A failed call
says nothing. It is made again when the conversation moves, when you open the panel a minute later, or on Write again.

The digest is an agent's words, file names and commands, so it is not trusted, and neither is what comes back. The
worst a session can do through it is get a wrong recap written about itself.

## Titles and descriptions

Claude Code names a session after the first thing you asked it, and keeps that name. A session that started as "fix
the flaky watch test" and turned into a release is still called after the test. So Grove gives each session its own
title, three to seven words for the whole session, and a description, one line on what it is for and how far it
reaches. The description is how the lists tell sessions apart, and it is searched like the title.

Both come from one call to haiku through your own `claude`, the same call as a [recap](#recaps) and in the same two
slots (a recap goes first). It is sent the recap's digest, ten of the prompts from the middle of a long session, the
project, the branch, the title and description it has now, and what the project's other sessions of the last week are
called, so a new title is not one of theirs.

They change rarely, and when they change they get broader:

- the first look is at the end of the first turn that did some work
- after that a session is looked at again only when its prompts have doubled (about 1, 3, 6, 12, 24, 48, 96), and
  after a compaction. a 100-prompt session gets about seven looks
- each look is told to keep both unless the work has clearly outgrown them, and "same" is the usual answer
- never while a session is working: the look waits for the turn to end
- the first launch of 0.17 names the sessions of the last week and the ones still open, about 50 calls on the machine
  it was built on, two at a time. an older one is named when its row comes into sight

**Rename sessions in Claude Code** sends the title on to Claude Code, so the VS Code tab, `/resume`, the terminal and
claude.ai show it too. Grove never writes into a transcript. It leaves the title in a file, and a hook prints it at the
session's next prompt or resume, which Claude Code applies as it would `/rename`. A session you are not typing in keeps
its old tab title until you come back to it, while Grove shows the new one at once. A session no Grove hook covers (in
no project, with Track sessions outside projects off) gets the title in Grove only.

A name you gave a session yourself, with `/rename` or the tab's menu, always wins. Grove keeps every title it handed
out, and a custom title that is none of them is yours: Grove stops titling that session for good, and goes on writing
its description. The hook also checks the session's current title before it prints anything, which covers a rename
Grove has not seen yet.

**Write recaps, titles and descriptions with Claude** in Settings switches all of it off: no calls, and the rows are
as they were in 0.16. **Rename sessions in Claude Code** (on) is its own switch, since it writes into your sessions.
Off, Grove keeps its titles to itself and the hook is taken out. Titles, descriptions and the titles handed out are
in `.grove/titles.v1.json`, the newest 2,000. Deleting it is safe, but a session Grove had already renamed then reads
as one you named yourself, and keeps that name.

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

### Actual usage

**Actual** is what Claude Code last fetched of your account's limits, the same call its `/usage` makes. Claude Code
keeps the answer in its state file, `~/.claude.json` (inside `CLAUDE_CONFIG_DIR` when that is set), and Grove reads it
from there: once on launch, then whenever the file changed, looked at once a minute and when the window comes forward.
Grove never asks for it itself and never writes the file, so the screen says how old the numbers are, and they can be
hours old. Running `/usage` in Claude Code fetches them again. A cache that belongs to another account than the one
signed in is not shown, as Claude Code drops it too.

A metered account's numbers say what was spent and the cap, not when the period ends, so Grove does not say how many
days are left. Nothing documents the file: Grove reads the fields it knows and leaves the rest.

## Notifications

Grove notifies when:

- a session asks for permission. in a chat window that includes an MCP server's form or sign-in page and a paused
  session's dialog, which claude raises no hook for. asks from one session within a minute of the last one told are
  one notification, and its row under Needs you still says the newest
- a session stops on an API error
- a session in a project goes away mid-turn. several within five seconds fold into one
- a turn that ran for over a minute finishes. one session notifies for this at most once in two minutes. it says
  what the session's recap says you have to do when the recap is there within 15 seconds, else the start of the last
  message. the other three are never held back
- a turn that a background command or agent ending started finishes, however short. it says what the recap or the
  last message says, and two of them are never folded into one

Nothing notifies about what the focused window already shows: on All sessions that is every project, on a project's
sessions that project. What stopped while Grove was closed shows under Needs you and does not notify.

A click opens the window on that session with its panel open: its row under Needs you in All sessions when it has
one, else its row in its project's sessions. With grove chat on it opens the session's chat window, in front. A session
that is in neither, or in no project, opens in the editor. Landing on a session does not take it out of Needs you
(opening it from the main window does). The dock badge carries the same count as the menu bar, never the usage. **Notifications** in
Settings switches them off.

A notification plays a short chime of Grove's own. macOS decides whether it sounds: System Settings, Notifications,
Grove.

## Background tasks

A session can leave something running when its turn ends: a command in the background, a Monitor, or a wake-up it
scheduled (a cron, a `/loop`). Claude Code lists them in the hook that ends each turn, and Grove keeps that list per
session. One task is one entry however often it polls. A `/loop` is one too, counted from its first wake-up, though it
schedules a new one each time.

- a wake-up counts as soon as it is listed
- a command or a Monitor shows once it is still there a minute after the turn that left it. A one-off script that
  finishes sooner is never shown. Neither is one that starts and ends inside a turn. It keeps the Mac awake from
  that turn's end, so the hold has no gap between the turn and the row
- a subagent is not a task here: a turn that waits on one is still Working

A session with a task that counts is **Watching** once its turn has ended and its row is answered or dismissed. Until
then its row is under Needs you like any finished turn, and its panel already lists the tasks. Each wake-up of a
`/loop` and each Monitor event is a turn of Claude's own: what was under Needs you stays there while it runs, and its
end is what the row says next.

The line of status under a task is the last line the command wrote, read from the file Claude Code keeps its output
in (`/tmp/claude-<uid>/<project folder>/<session id>/tasks/<task id>.output`), every ten seconds. That path is
observed, not documented: when the file is not there the task has no status line and nothing else changes. A wake-up
says `wakes at 14:07` when it fires once, and `repeats ·` with its cron when it repeats.

A task goes when the session's next turn ends without it, when the session ends, or when its process has been gone for half a minute. The list
is kept across a restart of Grove.

## Staying awake

While any session Grove can see is mid-turn, has a background subagent at work, or is watching a
[background task](#background-tasks), Grove keeps the Mac and its display from going to sleep on their own, and lets
them go when the last of them is done. A subagent counts until 45 minutes pass with nothing heard from its session. It
is what `caffeinate -d -i` takes, held by Grove itself: no terminal and no extra process. A laptop on battery with its
lid shut still sleeps. A session waiting on you with nothing left running does not count. It holds only while Grove is
running: closing the window keeps Grove in the menu bar, quitting lets go. The menu bar's menu says whether it holds,
for how long and for which sessions. **Keep the Mac awake while agents work** in Settings switches it off.

Every scheduled wake-up counts, however far off: a Mac that sleeps does not fire it. So a session left open with a
daily cron keeps the Mac awake until the session is closed or the cron expires, which Claude Code does to a recurring
one after seven days. The menu bar names that session.

## Opening and starting agents

**Open in VS Code** (or Cursor, per Settings) depends on where the agent runs, which each row says in a chip:

| chip | what Open does |
| --- | --- |
| `VS Code`, `Closed` | opens the project's window and lands on the session, resuming it if it was closed. A session that ran inside a working copy opens that folder instead |
| `Background` | a session Claude Code's supervisor runs (`claude --bg`). resuming it anywhere else is refused while the supervisor holds it, so Grove runs `claude stop <id>` first, then lands. It asks before stopping one that is mid-turn |
| `Terminal` | does not land: a second process on a live conversation would be a copy of it. The project opens, and Grove says to quit the agent in its terminal first |
| `Headless` | `claude -p` or an SDK app. The same: the project opens, and it can be opened once it has finished |

Landing needs the companion extension in that editor. Without it the window opens and Grove says it could not land.

**Zed** is the third editor in Settings. Grove opens the project as one new Zed window, `cli -n <root> <references>`,
and when it lands on a session, opens that window's agent panel (`zed://agent`) a few seconds later. That starts a
new thread with the agent Zed last used, and with **Claude (with Grove)** the thread is the session, with its history.
Claude (with Grove) is Grove's entry in Zed's `agent_servers`, which the banner adds. Zed runs it with Grove's own
binary as node, so it needs no node on Zed's PATH. It runs Claude Code's own agent, the one Zed installed, and passes
everything through as it is but two things: in a project's window the project folder is the agent's folder (Zed
hands a window's folders over alphabetically), and a new thread in a folder the app has just handed a session to
becomes that session. Start one thread with Claude (with Grove) (**+** in the agent panel) once, so
that it is the agent Zed last used. **New session** opens the project, and you start the thread there.

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
login shell's environment, read once per app run. Zed gets it too, read again on each open: started by its CLI, Zed
keeps the CLI's environment for its terminals, git and agents, and does not look up your shell's itself.

Since Claude Code 2.1.281, a folder has to have passed the CLI's trust prompt once before anything can be sent to the
background there, and a project only ever opened from VS Code has not. The first time, Grove offers **Start in
Terminal**, which runs the same command in Terminal where the prompt can be answered. Grove never writes that trust
itself.

Grove only ever calls Claude Code's own commands: `claude agents --json --all` (asked at startup, when the window comes
forward and when a background process comes or goes, never on a timer), `claude --bg -- <prompt>` and `claude stop
<id>`. Never `claude rm`, never `claude daemon`, and no permission flag - a background agent that stops on a permission
prompt shows up as a Needs permission row.

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

Every release is signed with the same self-signed certificate, so the screen recording and microphone permissions you
give Grove survive its updates. If you gave them to a release before 0.24.48, remove Grove with - under Screen &
System Audio Recording and under Microphone and add it back once: switching it off and on keeps the old grant. macOS
only trusts an Apple Developer ID, so a DMG that travels through a browser, Slack or AirDrop is still quarantined, and
needs `xattr -dr com.apple.quarantine "/Applications/Grove.app"` once. A build of your own is ad-hoc signed, which is
enough to run on the machine that built it.

It follows the macOS appearance, light or dark, and switches with it. **Appearance** in Settings pins it to one.

## Things people will report as bugs

- **a row came back after Dismiss** - a Needs permission, Your turn or Failed row is marked as seen, and returns on
  that session's next event. a Stopped row stays dismissed
- **a session says Closed but nothing went wrong** - Closed means its process is not running, which is what a closed
  VS Code tab looks like. Open resumes it
- **a session says Stopped after its tab was closed** - it was mid-turn when the tab went
- **a project is missing from the sidebar** - it is archived. it is under Archived, at the foot of the projects
- **a session is missing from its project's list** - it was started in a subfolder and has finished. it is in `⌘K`
- **the Mac did not sleep overnight** - a session left open has a wake-up scheduled or a command still running. the
  menu bar's menu counts it as watching and names it. close that session, or switch off Keep the Mac awake
- **a session with a /loop keeps coming back under Needs you** - each wake-up is a turn, and a turn that ends is
  your turn. Dismiss puts it back under Working as Watching
- **a background task has no status line** - its output file was not where Grove looks, or it has written nothing
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
- **a session has no description** - none of its turns has done any work yet, it is older than a week and its row has
  not come into sight, the switch is off, or the call failed. a failed one is tried again when the session moves
- **a session's tab in VS Code changed its name** - that is Rename sessions in Claude Code. `/rename` gives it yours
  for good, or switch it off in Settings
- **the VS Code tab still has the old name** - it changes at the session's next prompt, or when it is resumed
- **a title did not change after a lot of work** - it is looked at again only when the prompts double, and "same" is
  the usual answer
- **`claude -p` runs show up in Activity Monitor** - those are the recap and title calls, two at most. the first
  launch of 0.17 makes about one per session of the last week
- **a session is missing from `⌘K`** - Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`). the VS Code
  panel also archives sessions after 14 days idle (`claudeCode.archiveInactiveSessions`). those still show here
- **an agent says the grove tools are gone** - it was open across the upgrade from 0.10. restart it
- **the app does not open from a download** - its certificate is self-signed, and macOS only trusts an Apple Developer
  ID. `xattr -dr com.apple.quarantine "Grove.app"`
- **landing opened a fresh conversation** - the companion extension is not installed in that editor, or, in Zed, the
  Grove agent is not registered (the app shows a banner and can do either), or the transcript expired
- **Zed opened the project but not on the session** - the agent Zed last used is not Claude (with Grove), so the panel
  opened a thread with that one. Press **+** and start a thread with Claude (with Grove) within five minutes. The same
  when Zed was not running: the panel can open before the new window does
- **every open of a project in Zed is a new window** - Grove opens it with `-n`, and does not look for one already
  open
- **Claude (with Grove) does not start in Zed** - it runs Claude Code's agent from where Zed installed it. Open a thread
  with Zed's own Claude agent once, so Zed installs that. An entry from 0.18.30 runs `node` from Zed's PATH, which a
  Zed started from the Dock may not have: the banner says it is out of date, and Update fixes it
- **Zed asks whether to trust the project** - Zed's own prompt, once per folder, unless `trust_all_worktrees` is on

The transcript format is internal to Claude Code and changes between releases. What this project relies on, and how it was
verified, is in [docs/claude-code-facts.md](docs/claude-code-facts.md).

## License

MIT. Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
