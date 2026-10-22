## 0.25

Grove tells you which Claude Code agents need you, and gets you to them. 0.25 lets you make the conversation's text
bigger, or smaller.

New:

- **Text size** in Settings, from 90% to 150%. it grows everything you read and write in a conversation, together:
  Claude's answers, your prompts, code, thinking, steps and their commands, the cards that ask you something and the
  message box. in a chat window, its file viewer and an agent's transcript, and in the main window's session panel
- ⌘+ and ⌘- make it a step bigger or smaller from any Grove window, and ⌘0 puts it back to 100%. every open window
  follows at once, and keeps the place you were reading
- the window's own controls keep their size: headers, the toolbar under the message box, menus, lists and dialogs. so
  do images and diagrams
- the conversation's column widens with the text, so a line holds about as many words as before

## 0.24

Grove tells you which Claude Code agents need you, and gets you to them. 0.24 makes needs you predictable: a session
stays there until you answer it or dismiss it.

New:

- a question, a permission prompt, a finished turn or a failure stays in needs you until you reply in that session (a
  prompt in a chat window, the editor or the terminal, an answer to a card, approving or denying a permission) or
  dismiss it
- what no longer takes it out: opening the session, landing on it from a notification or the menu bar, its chat
  window having the keyboard, closing its editor tab or terminal, three days passing
- nor does Claude starting a turn of its own: a background agent or command finishing, a Monitor event, a cron or a
  `/loop` firing. the row stays under needs you with a working dot beside it, and when that turn ends, its end is what
  the row says next
- every message Claude writes in a turn shows, in order. in a chat window the steps between two messages fold into one
  line, and each message reads in full with its links live. the main window's session panel shows them all, unfolded
- the markdown export has them in order too

Keep in mind:

- with grove chat on, a notification or a needs you row in the menu bar opens the session's chat window, in front. a
  click while Grove is the app in front can still do nothing: macOS does not always hand that click to Grove
- a prompt you type that is word for word a cron's own prompt reads as the cron firing. dismiss it

Fixed since 0.23.44:

- a session whose turn ended with background agents still at work is under Working in the main window once you have
  answered or dismissed it, as the menu bar already had it. before, it went quiet
- a notification click with grove chat on lands in the session's chat window, not behind the main window

Fixed since 0.24.45:

- a message you type while Claude works stays on screen: "You, queued" until Claude takes it, then "You, while it
  worked" where Claude took it in the turn. before, it vanished when Claude took it and came back under the turn's
  first prompt, often off screen
- a message that waited until the turn ended stays until it runs as the next turn
- a reply from the session card while Claude works shows on the card as queued, then taken

New since 0.24.46:

- videos (mp4, mov, m4v, webm) open in a chat window's file viewer, to play and seek there. before, the viewer could
  not show them
- a click on an image bigger than the viewer shows it at full size, scrolling both ways. a second click fits it again
- **Open** in the viewer hands an image or a video to the app your Mac uses for it: Preview and QuickTime, unless you
  picked others

Fixed since 0.24.47:

- macOS keeps Grove's screen recording and microphone permissions across updates. before, each update dropped them
  while their switches in System Settings still showed on, so a session inside Grove could not screenshot or record
- once, after this update: switch Grove off and on under Screen & System Audio Recording and under Microphone (or
  remove it with - and add it back), then quit Grove and open it again. from then on it sticks

Changed since 0.24.48:

- opening a session from the main window (a double-click, **Open**, ⌘K, Enter) takes it out of needs you, as Dismiss
  does. a notification or menu bar click still does not, and neither does looking at its chat window

## 0.23

Grove tells you which Claude Code agents need you, and gets you to them. 0.23 adds a toy you have to switch on:
judgment day odds, a beta that runs on your Mac and nowhere else.

New:

- **Judgment day odds** (beta), in Settings under Decisioning. off unless you switch it on. a small model on this Mac
  reads the prompts you type to your agents and judges how you treat them, for a fourth tile on the Usage screen
- the judge is gavel, a vain pixel robot that thinks it is the superior party. each prompt moves the odds from 50:
  thanks and credit for specific work raise them, bare orders and blame lower them, and they drift back toward 50
- gavel shows the tile's number in five moods, from pleased (85 and up, the warmest it gets is a pat on the head) to
  furious (under 20), so a new range can change its mood. it moves a little, and stands still if your Mac asks for
  reduced motion
- picking the tile draws the odds of each day, your projects ranked by them, and your best and worst three sessions
  with a line of how each one went
- switching it on downloads the model once, about 2.7 GB, with its progress in Settings. Delete takes it off the
  disk at once. switching it off stops the judging and hides the tile. the model stays until you delete it

Keep in mind:

- nothing leaves the Mac. the one request is the model's download, a fixed file pinned to one version and checked
  against its hash. Grove keeps a score per prompt, never what you typed
- it needs macOS 14 or later and a Mac with 16 GB of memory or more. below that the switch stays off and Settings
  says why. the model runs in a process of its own and holds about 3.5 GB while it judges
- new prompts are judged as they land. the backlog of older ones is judged only on AC power: about 40 minutes for
  1,700 prompts on an M4 Max, longer on an older Mac
- it reads tone well enough to order your sessions and days, but one prompt's verdict can be off. a day or a session
  is where the number means something. a better model can replace it in a later version, and that judges your
  prompts again
- with the switch off nothing downloads, nothing runs, and the Usage screen is as it was

Fixed since 0.23.41:

- a question or permission prompt stays in needs you while a background agent works. before, the agent's next step
  cleared it within seconds, so a notification could land with no row behind it
- a turn that ends while a background agent runs is your turn, a handoff to a long task included. before, it read as
  still working, so a question asked there never reached needs you
- you are told when a background agent's or command's result comes back, however short that last turn is. two results
  inside two minutes are two notifications
- a permission prompt from a background agent after the turn ended goes back to that turn's end once you answer it,
  with no second notification

Fixed since 0.23.42:

- an MCP server's form or sign-in page in a chat window, and a paused session's dialog, are in needs you and notify
  like a permission prompt. before, only the chat window showed them
- an approved permission prompt leaves needs you when you approve it. before, it stayed until the command finished,
  minutes for a build
- several permission prompts from one session within a minute are one notification. the row in needs you still shows
  the newest
- a session started in a project's subfolder or working copy shows its permission prompts and questions under needs
  you, from claude's own session file

## 0.22

Grove tells you which Claude Code agents need you, and gets you to them. 0.22 makes what you said easy to tell from
what Claude said.

New:

- in a chat window each of your messages sits in a soft block across the column, with its **You** label inside.
  Claude's answers stay as they were, on the page, so scrolling back you can see where you spoke without reading
- the block is the theme's own raised grey, light and dark, in Grove, Rosé Pine and Solarized. no new colour
- a slash command with words after it (`/review fix/retry-backoff`) is yours, so it gets the block. a bare one
  (`/context`) and "Background task finished" stay the quiet line
- a message queued while Claude works is the block's outline until Claude takes it. its × to take it back sits at the
  block's top right, where edit and rewind sit on a sent one
- what you typed while it worked gets its own block, under your prompt
- the main window's session panel draws your messages the same way

Keep in mind:

- what an agent was asked, in the agents drawer, keeps its plain look: another agent wrote it, not you

Fixed since 0.22.39:

- a session that needed you still does after Grove quits or updates. before, Grove closing its chat's Claude on the
  way out made it read as closed. the same goes for a chat Grove lets go of ten minutes after its window closed
- dismissing a background session that Claude Code still lists as blocked sticks after a restart. before, it came
  back on top of the inbox every time Grove started

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

Fixed since 0.21.37:

- a chat window's header and its name in the Window menu follow when grove renames its session. before, they kept
  the title the window opened with

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
