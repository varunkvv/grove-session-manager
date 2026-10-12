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
- a command counts once it is still there a minute after the turn that left it. a one-off script never shows
- a session whose process is gone holds nothing, and the list is kept across a restart of Grove

Keep in mind:

- every wake-up counts, however far off. a session left open with a daily cron keeps the Mac awake until you close
  it or the cron expires. the menu bar names it
- each wake-up of a `/loop` and each Monitor event is a turn, so that session is under Needs you again when it
  ends. Dismiss puts it back under Working as Watching
- the hooks in every project are rewritten once, on the first launch: an event is now kept up to 64KB, since the
  list comes after the turn's last message

The [README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not
verified.
