## 0.14

Grove tells you which Claude Code agents need you, and gets you to them. 0.14 keeps the Mac awake while they work.

New:

- while any session Grove can see is mid-turn, the Mac and its display do not go to sleep on their own. when the last
  turn ends they can again. a session that waits on you does not count
- it is what `caffeinate -d -i` takes, held by Grove itself: no terminal and no extra process. a laptop on battery
  with its lid shut still sleeps
- it holds only while Grove is running. closing the window keeps Grove in the menu bar, quitting lets go
- the menu bar's menu says whether Grove is keeping the Mac awake, for how long, and lists the sessions that are
  working, which are what keeps it so. a click on one opens the window on it
- **Keep the Mac awake while agents work** in Settings switches it off

The [README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not
verified.
