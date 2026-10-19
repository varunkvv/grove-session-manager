## 0.21

Grove tells you which Claude Code agents need you, and gets you to them. 0.21 makes grove chat windows easy to tell
apart, and to switch between.

New:

- a chat window's header takes its project's colour: a soft band with a thin line in the project's colour under it,
  and the project's name before the title (`ingest / fix the retry loop`). a window in no project keeps the plain header
- with windows stacked, the band shows in the strip each one leaves visible, and in Mission Control
- **⌘K** in a chat window lists your other open chat windows on top, the one you were in last first, each with its
  project, its state and what it is for. ⌘K then Enter takes you back to the last one, so two windows flip like ⌘Tab.
  **All sessions** (⌘1) ends the list
- typed, ⌘K finds a window by a word of its title, project or description, then the actions, then any session, which
  opens in a window of its own
- the main window's ⌘K lists the open chat windows too, and its sessions show their project's colour
- a chat window is named `title · project` in the Window menu, the Dock, Mission Control and screen sharing

Keep in mind:

- ⌘K then Enter in a chat window used to run Open in VS Code. with other chat windows open it switches window now.
  ⇧⌘↩ still opens VS Code
- there are nine project colours. with more projects than that two share one, and the name in the header and in ⌘K
  tells them apart

## 0.20

Grove tells you which Claude Code agents need you, and gets you to them. 0.20 adds two themes.

New:

- **Theme** sits next to Appearance in Settings: **Grove** (as before), **Rosé Pine** or **Solarized**. each one has a
  light and a dark side, so System still follows macOS at sunset
- Rosé Pine is Dawn in light and the main palette in dark. Solarized is its own light and dark. the violet accent,
  the fonts and the layout stay Grove's
- in a chat, code is coloured with the theme's own colours and mermaid diagrams draw in them

Keep in mind:

- some of the original colours are moved a little lighter or darker, where they fell under Grove's contrast rules
  (Solarized's greys most of all), so every word stays readable on every background
- there are no custom themes

Fixed:

- labels on a diagram's arrows no longer sit on a black box in dark

## 0.19

Grove tells you which Claude Code agents need you, and gets you to them. 0.19 lets you talk to them in Grove, as a beta.

New:

- **Grove chat (beta)** is a switch at the bottom of Settings, off by default. with it on, opening a session
  (double-click, a second Enter, a notification) opens it in a Grove window of its own instead of your editor
- the chat streams Claude's answer as it comes. Esc stops the turn, and what you type while it runs waits for it.
  the mode pill and model picker work as in Claude Code, Shift-Tab changes the mode
- Claude's questions and plans show as cards you answer with a click
- **Open in VS Code** (Cmd-Shift-Enter, or the button in the header) moves a session to your editor. if a turn is
  running, Grove asks whether to stop it or move when it finishes
- closing a chat window does not stop the session. a running turn keeps going, and Grove still tells you when it
  needs you

Keep in mind:

- Grove runs your own `claude`, with your login, settings, hooks and MCP servers. the session is the same one your
  editor and the terminal see, so it moves between them
- a session open in VS Code, a terminal or Zed shows read-only. close it there to talk to it in Grove
- Claude starts when you start typing, not when the window opens

New since 0.19.32:

- code in a chat is coloured, and mermaid diagrams draw as pictures
- images, SVGs, Markdown and HTML pages the session writes show as cards in the turn. click one to open it in a viewer
  beside the chat, which reloads when the file changes. the files button in the header lists everything the
  session wrote, plus a project's `plans/` and `artifacts/`
- HTML pages run in a sandbox. they can load scripts, fonts and images from the web, and cannot reach Grove or
  send anything
- `/` lists Claude's commands and skills, `@` finds a file in the session's folders. paste or drop images into the
  message box
- Cmd-N starts a new session in a chat window for the project on screen. New Project moves to Cmd-Shift-N
- Ctrl-Opt-Cmd-G brings Grove forward from any app. change it in Settings
- chat windows open a step down from the last one, at the size you last left one, and follow the appearance setting
- long answers are no longer cut in the chat
- the mode and model controls move to a toolbar under the message box. the mode is a menu with a line on what each
  one does. the model menu holds effort (the levels that model offers) and an **Ultracode** switch for the session
- attach any file with **+**, by dropping it anywhere on the window, or by pasting. images, PDFs and text or code
  files go to Claude as attachments, anything else goes in as its path
- while a turn runs, send turns into a stop button, the header counts the time, and a line says what Claude is doing
- thinking and steps are folded under each answer ("Thought for 6s", "5 steps · 38s"). click to see them
- subagents show in a side panel from the header or the turn, each with its state, a stop, and its own transcript
- what `/context`, `/usage` and `/mcp` print shows in the chat, and the window follows `/clear` to the new session

Fixed since 0.19.32:

- chat sessions run with Claude Code's own system prompt. 0.19.32 started them with an empty one

New since 0.19.33:

- with Grove chat on, the main window's side panel is a **session card**: the recap, what the session waits on
  (answer it right there), the end of its last answer, a reply box (R goes to it), what it made and what runs for it
- several questions from Claude come as tabs, one at a time, with multi-select, previews beside the options and a
  last tab to look over your answers. 1-9 picks, the arrows move, Enter sends
- approve a plan into a mode ("Approve, accept edits"), turn a permission down with what to do instead, and see what
  an edit changes, on its card and on each finished step
- workflows show in the agents panel as one row with their agents under it, and stop as one
- **Cmd-K** runs any chat action by name and **Cmd-/** lists every key. the header's **…** menu holds the session's
  own: rename (or click the title), fork, copy or export the conversation as Markdown, output style, MCP servers,
  Open in VS Code
- hover a message to copy it, edit and send it again in a new session, fork from it, or rewind the files Claude
  changed since it. code blocks copy on hover too
- a ring by the send button shows how full the conversation is once it is half full, and compacts it on a click
- Up and Down walk what you said. Cmd-F finds in the conversation, Cmd-Down jumps back to the latest
- take back a queued message before Claude gets to it, send a long command to the background (Ctrl-B), and ask a
  side question with `/btw`
- a long paste becomes a chip, an attached image opens full size, and a file from the project goes in as an
  `@` mention instead of an attachment
- the files panel lists what is not committed, each with its diff
- fast mode on models that have it, thinking off on the 4.x models, and older turns on asking
- a refusal and an MCP server's form come as cards to act on, a turn that died on an API error can be tried again,
  and a usage limit close to its end shows by the send button
- `/model`, `/effort` and `/plan` open Grove's own menus, and commands meant for a terminal are left out of `/`

Fixed since 0.19.34:

- the chat reads calmer: the `/` and `@` menu looks like the other menus, plan and permission cards share one
  layout, the model menu says once that its settings are for this session, and one dot breathes in the header
- the session card says "Working 0:12" with what Claude is doing under it, as the chat window does
- a card that takes another's place scrolls into view, and a fork into a window that was still opening keeps its words
- the first arrow key in a list starts from its top row, not from a row the pointer happened to rest on

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
- the agent runs the Claude Code agent from where Zed installed it. if you never opened a thread with Zed's own
  Claude Agent, do that once
- the VS Code extension's status bar, drift warning and find-session shortcut have no Zed version. Zed has no
  extension API for them

Fixed since 0.18.30:

- Claude (with Grove) runs on the node built into Grove, so it starts in a Zed opened from the Dock. the banner says
  a 0.18.30 entry is out of date, and **Update** moves it over
- a Zed window Grove opens gets your shell's environment, PATH and all, as from a terminal
- a VS Code window on the same project no longer takes a session meant for Zed. no extension update needed
- a Zed window that opens with its agent panel showing lands on the session, not on the thread it restored
- a session open in VS Code or Cursor is not opened a second time in Zed. Grove opens the project and says to close
  it there first

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
