# Grove

_A project manager for Claude Code agents._

Grove is for one person running a big project with several Claude Code agents doing the work. It shows what the agents
ask of you and what they decided, with or without you, and keeps all of it so you can look it up later. Agents and new
sessions read and write the same record, so a session that starts tomorrow knows what was settled today.

In the repo:

- the app (`apps/desktop`, Electron, macOS) - projects, the inbox, cards and conclusions, opening and starting agents
- the record (`packages/record`) - the files a project's cards and conclusions are kept in, and the MCP server and CLI
  agents write them with
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
   it. The prompt tells the agent to read the record, then to create and claim cards toward the goal
5. Watch the **Inbox**: questions to you, what agents decided on their own, cards they finished. **Open in VS Code** on
   a row lands on that agent's conversation, which is where you answer. **Reviewed** clears a row

## A project is a folder

A project has a name, a one-line goal, a card prefix (`AUTH`, so its cards are `AUTH-1`, `AUTH-2`, ...) and the repos
the work needs. It owns a directory, `~/claude-ws/<project>/`. That directory - not any of your repos - is the primary
workspace folder, so it is Claude's working directory. It follows that:

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

The goal is one line, under 500 characters. An agent started from Grove is told to work toward it, `record_state`
prints it to every agent, and a changed goal reaches agents the next time a session starts. The card prefix comes from
the first four letters and digits of the name. The form only asks for one when another project already has it, and it
never changes afterwards, not even when the project is renamed. `D`, `F` and `V` cannot be prefixes: `D-1` is a
decision.

### The project's CLAUDE.md

Every session started in the project root loads its `CLAUDE.md`, forks and background agents included. The stub Grove
writes when the project is created says what the folder is (a set of git worktrees, and what a worktree implies), where
plans and generated artifacts go (`plans/`, `artifacts/` - never inside a working copy), and that the project record
is the memory sessions have in common, with `context/` for the longer notes the record points at. It is written once
and is yours after that.

### Long work in the background, as a switch

By default a project tells Claude to hand long autonomous work to a background agent, so the conversation stays free
to answer questions and plan. It takes these files:

- `.claude/agents/long-task.md` - an agent with `background: true` in its frontmatter. A subagent never sees the
  conversation that spawned it, which is what the plan file is for: the plan in `plans/` is its brief. It works under
  the card of the session that started it, and reports on that card
- `.claude/long-work.md` - the policy: background, or here in the conversation. The app owns this file
- `CLAUDE.md` only says "read `.claude/long-work.md` before long work, every time"

`CLAUDE.md` is read once, when a session starts, so a switch written there could never reach a session that is already
running. The policy file is read at the moment of decision, so flipping it takes effect on a running session's next
long task. Flip it from `⌘K` (**Run long work in the conversation** / **in the background**) or from the editor
(`Grove: Toggle Background Long Work`). Saying "do this one here" in the chat overrules it for a single task.

It is a default by instruction, not an enforcement: Claude still decides what counts as long.

A session whose turn ended while a background subagent it started is still working counts as running, not as waiting
on you. A background shell left running (a dev server) does not hold the turn open.

## The record

A project's record holds cards, the thread on each card, and conclusions.

| | what it is | id |
| --- | --- | --- |
| card | one sizeable piece of work, with a title and a brief. an agent claims it, works on it and marks it done. one session holds a card at a time | `AUTH-7` |
| comment, question, answer | the card's thread. a question is to you or to the agent on another card, and stays open until an answer closes it | `AUTH-7#3` |
| conclusion | something settled: a decision (what will be done), a finding (what turned out to be true) or a verdict (a judgement on an option, an approach or a piece of work). it says what, why, and whether it is the agent's or yours | `D-12`, `F-4`, `V-2` |

Agents are told to record conclusions at the moment something is settled, including the ones nobody announces (a
default, a timeout, a library picked over another, something taken as true without checking) and including yours: a
"go with that" or a bare "8h" in the chat is recorded with `by: person`. A conclusion can name an earlier one in
`replaces`, which then reads as superseded.

A conclusion also carries where it came from, for the agent that picks the work up later:

- `sources`: what the agent was shown or read. A Slack thread, a Figma frame, a doc, a PR, or a file in the project
  such as a digest under `artifacts/`, each with a line on what in it mattered. Up to 12, each an http(s) url or a path
  from the project root. Grove stores the reference, never the content, so agents are told to put the part that
  mattered into `why` and to save a digest for anything bigger: a later session may not have Slack or Figma connected,
  and threads get edited
- `said`: the last thing you typed in that session before it was recorded, cut to 2,000 characters. The record looks it
  up in the session's transcript when the conclusion is written, because Claude Code deletes transcripts after about
  30 days and one agent cannot read another's. Something typed while the agent was working counts, and so does a
  slash command with its arguments. Tool results, hook output and other agents' messages do not
- the conversation it was recorded in: your message before the call and what the agent wrote before making it. This
  is not stored. It is read from the transcript when someone asks, for as long as the transcript exists

An agent reads all of that for one conclusion with `conclusion_search` and its id. The rules tell agents to do so
before relying on a conclusion for something that matters, and always before overruling one.

It lives in the project folder as plain files:

```
~/claude-ws/<project>/
  cards/
    AUTH-7/
      card.md                 the title and the brief, and who created it
      comments/0001.md        comments, questions and answers, in order
      claims/0001.md          claim, release, takeover, done, cancel. the newest entry is the state
  conclusions/
    D-12.md  F-4.md  V-2.md   one file each, one counter per kind
    INDEX.md                  one line per conclusion, only ever appended to
```

Each file is markdown under a small frontmatter block:

```
---
v: 1
id: AUTH-7
title: "Log out everywhere when the okta session ends"
by: agent
session: 6f2c1b7e-...
agent: "session store"
at: 2026-10-02T18:24:11.402Z
---
The brief, in markdown.
```

A conclusion is all frontmatter:

```
---
v: 1
id: D-12
kind: decision
what: "Sessions move to redis, on the server."
why: "A cookie cannot be revoked, and SSO logout needs revoke."
by: person
session: 6f2c1b7e-...
agent: "session store"
at: 2026-10-04T18:24:11.402Z
tool_use_id: toolu_01JY1zva9dRYFViLwar442mK
card: AUTH-2
sources: [{"ref":"https://acme.slack.com/archives/C01/p1727890123","note":"ops: a cookie cannot be revoked"},{"ref":"artifacts/logout-thread.md"}]
said: "no, use redis. the thread says why"
---
```

`sources` and `said` are optional, and a conclusion written before they existed reads as it always did.

A card, a comment, a claim and a conclusion are each written once and never changed or deleted. Everything else is
derived when the files are read:

- a card is todo while nobody holds it, in progress once claimed, done or canceled when its newest claim entry says so
- a question is open until an answer to it exists
- a conclusion is superseded once a later one replaces it

Grove adds two display statuses from what it knows about the sessions. **Waiting on you** is a card with an open
question to you, or whose agent wants permission, has finished its turn or failed on an API error. **Stopped** is a
card whose agent's process went away in the middle of a turn. An agent whose process went away between turns is not
stopped: a VS Code tab's process goes with its window, so that card stays in progress with a `Closed` chip.

Conclusions count per kind (`D-1`, `F-1`, `V-1`) because one shared counter could not be made atomic: `D-42.md` and
`F-42.md` are different names, and both would publish.

Reading these files is fine, by hand or with `grep`. Writing them by hand is not: ids and claims are only safe through
the tools below.

## Agents write it through tools

Grove puts a `.mcp.json` in each project that declares a stdio MCP server named `grove`, so a session in the project
has these as `mcp__grove__<tool>`:

| tool | what it does |
| --- | --- |
| `record_state` | the goal, every card with its status and holder, open questions, the newest conclusions, which session is asking |
| `my_cards` | the cards this session holds, what is new on them, questions left for it. refreshes its claims after a resume |
| `card_show` | one card in full: brief, holder, thread, conclusions with their sources, linked cards |
| `card_create` | a new card, todo and unclaimed |
| `card_claim` | take a card before working on it. refused when another session holds it |
| `card_release` | give it back unfinished, with a note on where it stopped |
| `card_done` | finish it, with a summary of what was and was not done |
| `card_cancel` | it should not be done, with the reason |
| `card_takeover` | take a card another session holds. only when you said so |
| `comment_add` | a note on a card, with what was made: a file, a branch, a PR, a link |
| `question_ask` | a question on a card, to you or to the agent on another card |
| `question_answer` | the answer, which closes it |
| `conclusion_record` | a decision, a finding or a verdict, the agent's or yours, with the sources it came from |
| `conclusion_search` | what is already settled, with the why, the sources and what you said. with an id, that one conclusion in full, with the conversation it was recorded in |

Claude Code defers MCP tools by default: a session sees their names and has to search for a schema before its first
call. `record_state`, `my_cards`, `card_claim`, `question_ask` and `conclusion_record` are marked `alwaysLoad`, so their
schemas are in every request. The other nine stay deferred, so a session that never writes does not carry all
fourteen.

An agent learns to use them from:

- `.claude/rules/grove-record.md`, generated from the tool list. It says when to claim, what counts as a conclusion,
  how to ask you something (on the card, then in the chat), and what a subagent does (it shares its parent's session
  and cards, and passes `as` with a name of its own). Claude Code loads rules files into sessions at the project root,
  sessions started inside a working copy, and general-purpose subagents, so this file is what the rest leans on. The
  hook below does not fire for a session inside a working copy, and its print never reaches a subagent. The
  instructions reach a subagent only after its first tool call
- a `SessionStart` hook that prints the project's state before the first prompt: the same text `record_state` returns,
  from the same function
- the server's own instructions, a few sentences that reach the main session's first request

The state print is kept under 9,000 characters, because above 10,000 Claude Code swaps a hook's output for a file path
and a 2KB preview. It opens with a line like `# record AUTH rev 41 - auth-sso`, and the revision goes up with every
record added and every change to the project's name or goal. That line is there because on a resume Claude Code drops
a `SessionStart` output it has already shown: with a revision in the text, a changed state always arrives, and an
unchanged one is not repeated. For the same reason the text holds no clock and no process checks. A conclusion that
has sources carries a mark like `[2 sources]` on its line, so a new session knows there is more to read. When the hook
cannot run, it prints one line (`record unavailable: <reason>. open Grove once`) and exits 0, so the session is told why it
has no state.

When the tools are missing (a session started with `--strict-mcp-config`, say), the rules teach the same tools
through Bash:

```bash
~/claude-ws/.grove/bin/record call card_claim '{"card":"AUTH-3"}' --root ~/claude-ws/auth-sso
~/claude-ws/.grove/bin/record state --root ~/claude-ws/auth-sso
~/claude-ws/.grove/bin/record tools        # every tool with its arguments
~/claude-ws/.grove/bin/record doctor --root ~/claude-ws/auth-sso
```

Same code, same checks. The arguments are one single-quoted JSON object, and the CLI exits with a code per outcome (3
held by another agent, 4 the holder's process is gone, 8 the record is unavailable).

### Design choices

- Publishing is atomic without a lock. A record is written whole to a hidden temp file, then given its real name with
  `link(2)`, which fails when the name is taken. So a name is either absent or complete, exactly one writer gets it,
  and a writer that loses looks again and takes the next number. The test suite races 30 server processes for ids,
  claims and takeovers, kills half of them mid-write, and runs the same race against a look-then-write publish and a
  rename publish, which both have to fail
- There is one implementation. `packages/record` has one tool registry (name, description, arguments, handler). The MCP
  server, the CLI, the rules file and the server instructions are all generated from it, and the app reads the record
  with the same library. Adding an operation is one entry and one function
- It works with Grove closed. Each session runs its own server process, started by Claude Code from
  `~/claude-ws/.grove/bin/record`, a small `sh` launcher that runs the record bundle with Grove's own binary as node
  (`ELECTRON_RUN_AS_NODE=1`), or with a `node` 22 or newer on `PATH` when Grove has moved. The server never talks to the
  app. An HTTP server hosted by the app was tried first: with the app closed, every running session lost the tools
  within about 17 seconds and never got them back
- A session left open across an update does not write with an old build. The server checks the bundle on disk on
  every call, and once it has been replaced it runs each call through the new one
- Who wrote a record comes from the server, not from the agent: the session id from Claude Code's own registry
  (`~/.claude/sessions/<pid>.json`, the server's parent process), else `CLAUDE_CODE_SESSION_ID` from its environment.
  A record written over MCP also stores the id of the tool call that wrote it
- A claim records the Claude process and its start time. Another agent's `card_claim` is refused while that process is
  running, and told so when it is gone. Taking the card then is `card_takeover`, which the rules reserve for when you
  say so

When Grove starts, and on `⌘R`, it runs the launcher for each project the way a session would (`initialize`,
`tools/list`, one `record_state`) and shows a banner when the server cannot answer. **Edit project** has the reason and
the end of the server's error output.

## Files Grove writes

### In a project folder

```
~/claude-ws/<project>/
  CLAUDE.md                   written once when the project is created. yours after that
  plans/  artifacts/  context/  made once, with the root. where sessions keep what outlives them
  .claude/agents/long-task.md written once. `background: true`, so long work never blocks the conversation
  <project>.code-workspace    generated. only `folders` is ours, the rest is preserved
  .claude/long-work.md        generated. whether long work goes to that agent. flips mid-session
  .claude/rules/grove-record.md   generated. the record's rules. edits are overwritten
  .claude/grove-project.json  generated. the name, the prefix and the goal, where agents can read them
  .mcp.json                   only `mcpServers.grove` is ours. other servers and keys are kept
  .claude/settings.local.json only our entries are touched. see below
  cards/  conclusions/        the record. written by agents through the tools
  <repo>/                     working copies
```

In `.claude/settings.local.json` Grove owns:

- its entries in `permissions.additionalDirectories` (the project's references)
- `"grove"` in `enabledMcpjsonServers`, which approves the server. If `grove` is in `disabledMcpjsonServers` you said
  no in Claude Code's own dialog: both lists are left alone and the project says the server is turned off
- two entries in `permissions.allow`: `mcp__grove`, and `Bash(<launcher>:*)` for the CLI fallback
- hook groups carrying its markers: async status hooks marked `# grove-status`, and the sync `SessionStart` hook marked
  `# grove-record`

It never writes `defaultMode` or `enableAllProjectMcpServers`. A file that is not valid JSON is left alone, and the
project says so. Under `cards/` Grove writes one thing itself: when you mark an open question to you **Reviewed**, it
records "answered in the agent's chat" as your answer, so the card does not sit in Waiting on you after an agent
forgot to write the answer down.

Grove also warns, and changes nothing, when a working copy has its own `.mcp.json` that declares a server called
`grove`: sessions started inside it may use that one.

The record's files and the hooks are kept current when Grove starts, when its window comes forward, on `⌘R`, and when
a project is created or edited. The workspace file and the references are written when the project is opened in the
editor.

### Outside it

```
~/claude-ws/
  combos.json       the projects. source of truth. hand-editable. unknown keys and formatting are preserved
  reviewed.json     what you marked reviewed, as `<PREFIX>/<key>`. hand-editable, same treatment
  settings.json     optional: editor, binary paths, appearance, notifications
  .grove/           cache and runtime - safe to delete. Grove puts back what it needs at its next start
    bin/record      the launcher sessions run
    bin/record.cjs  the record bundle, copied out of the app. a newer Grove's copy is never overwritten by an older one
    events/         where session status hooks write
    interrupted.json  sessions whose process went away mid-turn, kept for a week
```

What you reviewed is a decision, not a cache, so it sits beside `combos.json` and not in `.grove/`. Entries the app
does not understand are left alone when it writes. Deleting `.grove/` loses the Stopped markers, and until Grove next
starts, new sessions cannot reach the record.

The app never writes inside `~/.claude` (the one exception is the opt-in status hooks below, and only in
`settings.json`), never writes Claude Code's folder trust, never copies a transcript, never deletes a branch, and never
passes `--force` to `git worktree remove`: a working copy with uncommitted work is kept and reported.

An unpackaged build writes no record file into a project unless it runs under `GROVE_ROOT`.

Drift is normal: people run `git worktree remove` and `rm -rf` behind the app's back, and Claude Code expires
transcripts. Folder states are `ok`, `reference`, `absent`, `stale`, `foreign` (left alone) and `missing-origin`.
**Repair working copies** in `⌘K` recreates the ones it can.

### Session status hooks, and how they are repaired

A transcript cannot tell "running a tool" from "waiting on a permission prompt", so that comes from Claude Code hooks.
Every project's `.claude/settings.local.json` gets async hooks on `UserPromptSubmit`, `PermissionRequest`,
`PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart` and `SubagentStop` that drop the
hook's input into `~/claude-ws/.grove/events/`. Claude Code watches its settings files, so sessions that are already
running pick the hooks up too - and later write the copy they loaded at startup back over them, which silently drops
whatever was added since, the record's approval, allow rules and hook included. So the app watches each project's
settings file and puts its own entries back when that happens. Only the entries carrying its markers are touched.

Hooks only cover the sessions that have them. Every live Claude Code process also keeps a file in
`~/.claude/sessions/<pid>.json`, which the app reads (never writes) to fill in sessions no hook covers, to say where an
agent runs, and to notice a process that is gone. Anything a hook said wins: a permission prompt is something only a
hook can see.

Sessions outside every project report only when **Track sessions outside projects** is on in Settings. Grove then adds
the same status hooks to Claude Code's own `settings.json`, and watches and repairs that file the same way. Turning the
switch off takes them out again. Use the switch: setting `trackAllSessions` to `false` by hand in
`~/claude-ws/settings.json` leaves the hooks (the groups marked `# grove-status`) where they are.

## The screens

The top bar has the project switcher, then **Inbox** with its count, **Cards** and **Conclusions**. The switcher shows
each project's count of things waiting on you, and carries a dot while another project has one, so a question in
project B is not invisible while the window is on A.

**Inbox** is what in this project wants a look, one row each, two lines: what it is, the card, the agent, where the
agent runs and when, then the summary at full width.

| row | when |
| --- | --- |
| Asked | a card has an open question to you, or a session in the project wants permission, has finished its turn or failed on an API error |
| Stopped | a session in the project went away mid-turn: its window closed, it crashed, the machine rebooted, or its background run failed |
| Decided, Verdict | an agent recorded a decision or a verdict of its own |
| Found | an agent recorded a finding flagged `changes_plan`. other findings never enter the inbox |
| New card | an agent created a card |
| Finished | a card was marked done. its summary is the row |

Asked and Stopped sort above everything else, so a burst of decisions from a busy agent cannot push a waiting question
down the list. A click opens the card. Each row has **Open in VS Code** and **Reviewed**, which takes the row out. Your
own conclusions and the cards you created never make a row, and neither do superseded conclusions or canceled cards.

**Cards** lists the project's cards in groups: Waiting on you, In progress, Todo, Done, Canceled, with who holds each
and where that agent runs. A project with no cards shows its goal and the buttons to start an agent on it.

A **card** page has the brief and the thread in order: comments, questions with their answers, the conclusions recorded
on it, takeovers, and how it finished. Ids in the text are links to the card or conclusion they name. The side panel
has the agent (name, where it runs, model, what it is doing, its subagents), the artifacts agents attached, the cards
it needs or was created from, and its conclusions. A file artifact is shown in Finder, never opened. A GitHub pull
request or a web link opens in the browser. Anything else is copied. The header has one button: **Open in VS Code** for
a card with an agent, **Start an agent in VS Code** for one nobody holds.

**Conclusions** is every decision, finding and verdict in the project, newest first, with a search over what, why,
card, agent and area (`you` finds your own) and a filter by kind. A row opens in place to who settled it ("Decided by
session store without asking", "Decided by you in idp config's chat"), what it replaces and what it relates to. Under
that are its sources, each with its note (a web link opens in the browser, a file in the project is shown in Finder),
and the conversation it was recorded in: your message and what the agent wrote before recording it. The app gets that
turn from the same reader `conclusion_search` answers an agent with, when the row opens. Once Claude Code has deleted
the transcript, the row shows what you said, which the record kept. A superseded one stays in the list, struck
through, with a link to what replaced it. Marking one reviewed here and in the inbox is the same mark.

**New project** and **Edit project** are one form: name, goal, repos. Edit project also shows drift per repo and, when
the record's check failed, why.

`⌘K` opens the palette: go to a screen, switch project, start an agent, switch long work, repair working copies,
**Mark all reviewed** (never the Asked or Stopped rows), delete the project, settings. Typing also searches every
Claude Code session on the machine, in a project or not: titles and prompts first, then everything that was said in
each session and by its subagents. `↵` on a session opens it in the editor.

The **menu bar** item shows how many Asked and Stopped rows there are across all projects. Its menu lists the first
three inbox rows, each with its project, then **Open Grove** and **Quit**. A click on a row lands on its card, or on
its project's inbox when it has none. Closing the window hides it: the app stays in the menu bar until it is quit.

What an agent wrote is not trusted. It is rendered as markdown without any HTML (a `<script>` shows as text), images
show their description, and only `http(s)` links open - in your browser, never in the app.

## Notifications

Grove notifies when:

- an agent puts a new question to you on a card
- a session asks for permission
- a session stops on an API error
- a session in a project goes away mid-turn. several within five seconds fold into one
- a turn that ran for over a minute finishes

A decision does not notify: it waits in the inbox. One session notifies at most once in two minutes for questions and
finished turns together. Permission, failures and stops are never held back by that.

Nothing notifies about the project you are looking at while the window has focus. A row in another project still does.
What stopped while Grove was closed shows in the inbox and does not notify.

A click lands on the card when there is one, else on the project's inbox. A session in no project opens in the editor.
The dock badge carries the same count as the menu bar. **Notifications** in Settings switches them off.

## Opening and starting agents

**Open in VS Code** (or Cursor, per Settings) depends on where the agent runs, which each row says in a chip:

| chip | what Open does |
| --- | --- |
| `VS Code`, `Closed` | opens the project's window and lands on the session, resuming it if it was closed. A session that ran inside a working copy opens that folder instead |
| `Background` | a session Claude Code's supervisor runs (`claude --bg`). resuming it anywhere else is refused while the supervisor holds it, so Grove runs `claude stop <id>` first, then lands. It asks before stopping one that is mid-turn |
| `Terminal` | does not land: a second process on a live conversation would be a copy of it. The project opens, and Grove says to quit the agent in its terminal first |
| `Headless` | `claude -p` or an SDK app. The same: the project opens, and it can be opened once it has finished |

Landing needs the companion extension in that editor. Without it the window opens and Grove says it could not land.

**Start an agent** is on an empty project, on a card nobody holds, and in `⌘K`:

| where | what happens |
| --- | --- |
| VS Code (or Cursor) | the project opens on a new conversation in the Claude panel, the prompt waiting in its input box - you send it. The panel takes a prompt from outside but cannot be made to send it |
| Background | `claude --bg -- <prompt>` in the project root |

The prompt tells the agent to call `record_state` first, then to work toward the project's goal, or to claim the card
it was started on. Grove does not start what it knows will fail: no goal, a missing project folder, a record server
that does not answer, a card that is done or canceled, a card whose agent is still running.

After a start, Grove shows "Waiting for it to claim a card" until a claim appears in the record, because that is the
only way it learns which session a VS Code start became. A start nobody claimed from within 30 minutes is dropped. While
one is waiting the start buttons give way to **Start another in the background**: two quick VS Code starts in one
folder lose one of the prompts.

A card whose agent stopped mid-turn offers **Open in VS Code**, which resumes it where it ran, and **Start a new agent
instead**, which starts a background agent told to take the card over. A card whose agent is closed for
good gets the same from `⌘K` (**Start a new agent on AUTH-5**), after a confirm. Grove never hands a card away from an
agent that is still running.

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
prompt shows up as an Asked row.

## After a restart

Quitting Grove changes nothing for the agents. Each session has its own record server, the hooks keep writing events
into `.grove/events/`, and Grove reads what it missed when it starts. Sessions that went away mid-turn while it was
closed are Stopped rows in the inbox, without a notification. What you marked reviewed is in `reviewed.json`. Only the
"waiting for it to claim a card" rows are forgotten, and the agent's claim still shows on the card when it comes.

Closing VS Code ends the sessions in its tabs. A card whose agent was between turns stays in progress, `Closed`.
Opening it resumes the session, and the agent's next `my_cards` moves its claims to the new process. One that was
mid-turn is Stopped.

A reboot stops everything, background sessions included. Sessions that were mid-turn come back as Stopped rows, and
that marker is kept for a week. Grove never restarts an agent on its own. The record is files, so nothing in it is
lost, and the next session's `SessionStart` print carries the state as it stands.

## Limits

What ran: the record's own tests (races between real processes included), the app's unit tests, and Playwright driving
the built and the packaged app against fixture projects, with stand-ins for `code` and `claude`. 21 real `claude -p`
sessions on Haiku and Sonnet worked a toy project through the files Grove installed. The mechanism (a project
`.mcp.json` server on the Grove binary, the hook's print, the rules file, no permission prompt in ask mode) was checked
by hand in a VS Code tab on Claude Code 2.1.287, with a prototype of the server. No automated test drives a real
editor tab.

What did not run, or does not work:

- recording is by instruction. nothing sends back a turn that changed files and wrote no record
- a weaker model records less. in the trial Sonnet recorded 4 of 5 implicit choices and Haiku 1 of 5, and Haiku never
  asked about a value it could default (0 of 3)
- a session started below the project root, inside a working copy, finds the server and the rules but none of the
  project's settings: no state at start, no approval, no allow rule. under `claude -p` its record calls were denied.
  an interactive one was not tried
- a session that was already open when Grove first set the project up gets the tools only after it is restarted
- a background agent using the record was never run. `claude --bg` refused the test folder as untrusted, and **Start
  in Terminal** was only tested against a stand-in `claude`
- `/clear` gives a session a new id in the same process. the server looks the id up on every call for that reason,
  which was only tested against a fake registry
- `said` is only found when your last message is within 8MB of the end of the transcript. in 303 transcripts on one
  machine that covered 99% of tool calls. past it the conclusion has no `said`, and the write still lands
- a conclusion a subagent recorded has no conversation to show: its call is in the subagent's own transcript, which
  is not read. `said` is still your last message in the parent session
- reading one conclusion in full finds its call by reading the transcript from the start, about 1ms a MB
- an Explore subagent does not load the rules file. the rules tell its parent to put the card, `record_state` and `as`
  into the brief. Sonnet did, Haiku did not
- you cannot answer from Grove, and Grove cannot wake an agent. a question is answered in the agent's chat
- two quick VS Code starts in one project leave one conversation
- a running session that writes its start-up copy of `settings.local.json` back while Grove is quit drops the record's
  approval, allow rules and hook until Grove runs again
- macOS on Apple Silicon only, and one machine per project: a claim made on another host is never seen as gone

## Upgrading from 0.5

The first launch of 0.10 changes these files, once:

- `~/claude-ws/combos.json` gets a `prefix` for every project, derived from its folder name. Two that would share one
  get a digit: `DATA`, `DAT2`
- `~/claude-ws/.grove/bin/record` and `record.cjs` are installed
- every project gets `.mcp.json`, `.claude/rules/grove-record.md` and `.claude/grove-project.json`, and in
  `.claude/settings.local.json` the `grove` entry in `enabledMcpjsonServers`, the two allow rules and the
  `SessionStart` hook. A project that already has a `.mcp.json` keeps everything in it and gains the `grove` server

An existing `CLAUDE.md` is not touched. Where it tells sessions to write to `context/in-progress.md`, the rules file
says the record replaces that. Sessions that are open during the upgrade need a restart to get the tools.

What is gone:

- the conversation pane and its search within a conversation
- the agent inspector, the Agents view, and the Haiku lines that summarised what each agent was doing
- the session list as a screen, its token counts and its archive. Sessions are found from `⌘K`. `archived.json` is no
  longer read, and is left where it is
- **New session...** with its model, permission mode and effort settings, and **Continue in background...**. Starting
  an agent takes no settings: the project's own decide
- attaching to a background session in Terminal. Open stops it and lands in the editor

`.grove/conversations.v1`, `.grove/agent-timelines.v2` and `.grove/agent-lines.v1.json` are caches of the removed
screens. Nothing reads them any more, and they can be deleted.

## Keyboard

No single letter is a shortcut, so on Conclusions a letter goes straight to the search.

| | |
| --- | --- |
| `⌘K` | the palette: go to, switch project, project commands, find a session |
| `⌘1` `⌘2` `⌘3` | Inbox / Cards / Conclusions |
| `⌥↑` `⌥↓` | step through projects |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` `⌘↑` `⌘↓` | move the active row |
| `↵` | open the active row: its card, or a conclusion in place |
| `⌘↵` | open the row's agent in the editor. on a card, the same as its Open button |
| `⌘D` | mark the active inbox row or conclusion reviewed |
| `⌘F` | search conclusions, from any screen. `/` does the same on Conclusions |
| `Esc` | close what is open, clear the search, then go back |
| `⌘N` `⌘O` `⌘E` `⌘R` `⌘,` | new project, open the project in the editor, edit project, refresh, settings |

No row looks active until a key says so: the first arrow or `↵` only shows which row the keyboard is on, and the next
one acts. `Esc` does not leave a project form that has changes.

## Develop

Needs node >= 22.18, pnpm 10, git >= 2.36.

```bash
pnpm install
pnpm test               # core + record + extension + app logic (vitest, real throwaway git repos, real processes racing for ids)
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
stand-in). `apps/desktop/scripts/dev.mjs` takes `--real-root` to use `~/claude-ws` anyway. Even then an unpackaged
build writes no record files into real projects, only status hooks.

`STRESS=1 pnpm vitest run packages/record/test/stress.test.ts` runs the id and claim races for 20 rounds of 30
processes, where `pnpm test` runs 3. After `pnpm app:build`, `node apps/desktop/scripts/screenshots.ts <outDir>` saves
every screen from the real app, in light and dark, against fixture projects.

The icon is [apps/desktop/resources/icon.svg](apps/desktop/resources/icon.svg); `node apps/desktop/scripts/make-icon.mjs`
re-renders the PNG that electron-builder turns into the `.icns`.

Layout: `packages/core` is pure Node TypeScript with no runtime dependencies, and is the only implementation of the
transcript parser, the project model and the git layer. `packages/record` is the only implementation of the record:
node builtins only, bundled into the one `record.cjs` the app installs. The app's main process and the extension both
bundle core from source.

The app runs sessions' record servers on its own binary, so the packaged app must keep Electron's `RunAsNode` fuse on.
`pnpm app:packaged` checks it.

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

- **an agent says the record is unavailable** - the launcher or the bundle under `~/claude-ws/.grove/bin/` is missing,
  or Grove was moved and no `node` is on the session's `PATH`. open Grove once: it puts both back. **Edit project**
  says what its own check found, and `⌘R` checks again
- **a session has no `mcp__grove__` tools** - it was open before Grove first set the project up. restart it
- **a card says Closed but nothing went wrong** - Closed means the agent's process is not running, which is what a
  closed VS Code tab looks like. the card stays in progress, and Open resumes it
- **an Asked row came back after Reviewed** - a row that comes from a session's live state, not from a question on a
  card, is only marked as seen. it returns on that session's next event
- **a session is missing from `⌘K`** - Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`). the VS Code
  panel also archives sessions after 14 days idle (`claudeCode.archiveInactiveSessions`). those still show here
- **the app does not open from a download** - it is ad-hoc signed. `xattr -dr com.apple.quarantine "Grove.app"`
- **landing opened a fresh conversation** - the companion extension is not installed in that editor (the app shows a banner
  and can install it), or the transcript expired

The transcript format is internal to Claude Code and changes between releases. What this project relies on, and how it was
verified, is in [docs/claude-code-facts.md](docs/claude-code-facts.md).

## License

MIT. Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
