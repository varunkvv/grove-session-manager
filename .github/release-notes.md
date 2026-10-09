## 0.13

Grove tells you which Claude Code agents need you, and gets you to them. 0.13 lets you archive a project, and makes
Delete the way to get disk space back and nothing else.

New:

- **Archive project** puts a project away and changes nothing on disk: its folder, working copies, hooks and sessions
  stay as they are. it is in `⌘K`, at the foot of the Edit project form, and in the delete dialog as **Archive
  instead**
- an archived project leaves the sidebar's list for **Archived**, a row at the foot of the projects that is closed
  until you click it
- its quiet sessions leave All sessions. one that needs you still shows there, still counts in the sidebar, the
  menu bar and the dock, and still notifies. one that is running shows there too. closed, Archived shows how many
  sessions in it need you
- an archived project's screen is its sessions, all of them, with **Unarchive** where New session was
- `⌘K` lists an archived project once you type part of its name
- in `combos.json` it is `"archived": true` on the project, so it can be set by hand

Changed:

- **Delete project** has no checkbox. it removes the clean working copies, takes the project out of `combos.json` and
  moves the project folder, with its CLAUDE.md, plans and notes, to the Trash. before, the folder stayed unless you
  ticked the box. a working copy with uncommitted work still stops it
- `⌥↑` and `⌥↓` step past archived projects
- Grove no longer opens on a project that was archived since you were last on it

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

