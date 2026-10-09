## 0.12

Grove tells you which Claude Code agents need you, and gets you to them. 0.12 puts every session on the screen it
opens on, and brings search back.

New:

- **All sessions** is the home screen, where the Inbox was. the sessions that need you are still its first rows, as
  they were. under them: the ones working now, each with what it was last asked and how long its turn has run, then
  Today, Yesterday and the two days before, one line a session
- sessions older than three days are under **Older**, closed until you click it. it draws 50 rows, and 50 more as you
  scroll
- a project's screen has the same groups
- sessions in no project are listed too, with their folder's name. scripted runs (`claude -p`, SDK apps) only while
  they run
- **Search** in the top bar, on both screens: titles, prompts and branches at once, then what was said in each
  session, with the words around the match on a second line. All sessions searches everything, a project's screen
  the project. `⌘F` focuses it
- a double-click on a project in the sidebar starts a new session in it
- a notification plays a short chime of Grove's own

Changed:

- the sidebar, the top bar and the View menu say **All sessions** where they said Inbox. the count beside it, the
  menu bar and the dock still count only the sessions that need you
- dismissing a row on All sessions takes it out of Needs you. the session stays listed under its day, and the panel
  goes on to the next row that needs you
- "Nothing needs you." is gone from the window: with nothing waiting, the list starts at Working or Today. the menu
  bar still says it
- `⌘F` stays on the screen you are on. from All sessions it used to jump to a project
- Grove writes one new file outside `~/claude-ws`: `~/Library/Sounds/Grove.wav`, the chime

The [README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not
verified.

## Install

Download `Grove-*-arm64.dmg` below, open it, and drag **Grove** onto Applications. Apple Silicon only.

Grove is not notarized by Apple, so macOS quarantines a copy that came through a browser and
refuses to open it ("Grove is damaged"). Clear the flag once:

```
xattr -dr com.apple.quarantine /Applications/Grove.app
```

Landing on a session and starting an agent in the editor need the companion extension in VS Code or
Cursor. Grove offers to install it the first time you open it.

