## 0.18

Grove tells you which Claude Code agents need you, and gets you to them. 0.18 works with Zed.

New:

- **Zed** is the third editor in Settings, next to VS Code and Cursor. a project opens as one new Zed window, with its
  references as extra folders
- opening a session in Zed lands on it, history and all, as in VS Code. it goes through **Claude (with Grove)**, an
  agent the banner adds to Zed's settings. it runs the Claude Code agent Zed installed and passes everything through,
  your model, effort and permission pickers included
- every Claude (with Grove) thread in a project's window runs in the project folder, so the project's CLAUDE.md and
  hooks load and the session is listed under the project. Zed on its own would pick a reference repo

Keep in mind:

- start one thread with Claude (with Grove) (**+** in Zed's agent panel) first. Grove opens the panel on the session,
  and Zed starts that thread with the agent you used last
- every open in Zed is a new window. Grove does not look for one already open
- the agent runs `node` from the PATH Zed sees, and the Claude Code agent from where Zed installed it. if you never
  opened a thread with Zed's own Claude Agent, do that once
- the VS Code extension's status bar, drift warning and find-session shortcut have no Zed version. Zed has no
  extension API for them

## 0.17

Grove tells you which Claude Code agents need you, and gets you to them. 0.17 names your sessions.

New:

- every session gets a **title** of its own, for the whole session rather than the first thing you asked, and a
  **description**: one line on what it is for and how far it reaches
- every row shows the description under its title, the rows under Needs you too. there, what the session asks is a
  third line, after a small arrow in its state's colour. a working row no longer shows its last prompt
- the panel opens with the title and the description. the recap under them drops its Goal, which said the same
- the description is searched like the title, in the lists and in `⌘K`
- names change rarely and get broader: a session is looked at again only when its prompts have doubled, or after a
  compaction, and never while it works. "same" is the usual answer
- **Rename sessions in Claude Code** hands each title to Claude Code at the session's next prompt or resume, as
  `/rename` would, so the VS Code tab and `/resume` show it too. a name you gave a session yourself always wins

Keep in mind:

- the first launch names the sessions of the last week and the ones still open, two at a time on your Claude login.
  about 50 calls on the machine it was built on, a few minutes. an older session is named when its row comes into sight
- the hooks in every project get one more, synchronous one on `UserPromptSubmit` and `SessionStart`. it costs about
  8ms per prompt over starting a shell
- **Write recaps, titles and descriptions with Claude** off: no calls, and the rows are as in 0.16. Rename sessions
  in Claude Code off: Grove keeps its titles to itself and the hook is taken out
- a session you are not typing in keeps its old tab title until you come back to it. Grove shows the new one at once
- not seen on a real VS Code tab yet: Claude Code's own code retitles the open tab when a hook sets a title

## 0.16

Grove tells you which Claude Code agents need you, and gets you to them. 0.16 knows what a session left running.

New:

- **Background tasks**: a command a session left in the background, a Monitor, a wake-up it scheduled (a cron, a
  `/loop`). one entry per task, however often it polls
- a session between turns with one of them is **Watching**: under Working, with a ring that does not pulse, what it
  left on its second line and how long it has watched
- the panel lists each task with one line of status: the last line a command wrote, `wakes at 14:07` for a wake-up
  that fires once, its cron for one that repeats
- the Mac stays awake while any session is watching, not only while a turn runs. the menu bar counts them,
  `Keeping the Mac awake · 2 working · 1 watching · for 1h 12m`, and lists them under the working ones
- a command shows once it is still there a minute after the turn that left it. a one-off script never shows. the Mac
  is kept awake from the turn's end, so a watcher a turn just started does not lose the hold in that minute
- a session whose process is gone holds nothing, and the list is kept across a restart of Grove

Keep in mind:

- every wake-up counts, however far off. a session left open with a daily cron keeps the Mac awake until you close
  it or the cron expires. the menu bar names it
- each wake-up of a `/loop` and each Monitor event is a turn, so that session is under Needs you again when it
  ends. Dismiss puts it back under Working as Watching
- the hooks in every project are rewritten once, on the first launch: an event is now kept up to 64KB, since the
  list comes after the turn's last message

Landing on a session needs the companion extension in VS Code or Cursor, or Claude (with Grove) in Zed's settings.
Grove offers to install either the first time you open it.

The [README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not
verified.
