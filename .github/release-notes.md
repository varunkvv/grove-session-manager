## 0.11

Grove tells you which Claude Code agents need you, and gets you to them. 0.10 made it a project manager with a record
agents wrote to. That is gone, and the sessions are the app again.

New:

- a sidebar of your projects, each with the count of its sessions that need you
- one inbox over every project: Needs permission, Your turn, Failed, Stopped
- a project's sessions as a screen, all of them, with a filter. the ones that need you first, then the ones working
- a click on a row opens the session in a panel beside the list. a double-click opens it in VS Code
- a recap at the top of the panel: Goal, Done, Now, Needs you. four lines on what the session was for and what it
  needs from you, written by haiku through your own `claude` when a session's turn ends and when you open it. an inbox
  row says what the recap says you have to do, and so does the notification for a long turn
- under the recap, the whole conversation: what you typed, one line for the work, and the message each turn ended on
- **Write recaps with Claude** in Settings switches recaps off. they use your Claude login and the haiku model
- a notification and a menu bar row open the window on that session, with the panel open
- a colour per project, and one colour per state everywhere

Gone: the Cards and Conclusions screens, card pages, inbox rows about cards and conclusions, starting an agent on a
card, the notification for a question on a card, the card prefix, and the record itself. Agents no longer get the
`grove` MCP server, its rules file or its `SessionStart` hook.

The first launch takes out of every project what 0.10 installed, and only that:

- `mcpServers.grove` in `.mcp.json` (the file too, when that was all it held)
- in `.claude/settings.local.json`: the `SessionStart` hook marked `# grove-record`, the `grove` server's approval and
  its two allow rules. the status hooks stay
- `.claude/rules/grove-record.md`
- the record paragraphs in `CLAUDE.md` and `.claude/agents/long-task.md`, where they are still exactly what Grove wrote
- `~/claude-ws/.grove/bin/record` and `record.cjs`

`cards/`, `conclusions/` and `.claude/grove-project.json` are yours and are not touched. What you marked reviewed stays
dismissed. Sessions that are open during the upgrade need a restart. The
[README](https://github.com/varunkvv/grove-session-manager#readme) has the rest, with what was and was not verified.

## Install

Download `Grove-*-arm64.dmg` below, open it, and drag **Grove** onto Applications. Apple Silicon only.

Grove is not notarized by Apple, so macOS quarantines a copy that came through a browser and
refuses to open it ("Grove is damaged"). Clear the flag once:

```
xattr -dr com.apple.quarantine /Applications/Grove.app
```

Landing on a session and starting an agent in the editor need the companion extension in VS Code or
Cursor. Grove offers to install it the first time you open it.

