## 0.10

Grove is now a project manager for agents. What was a combo is a project, with a goal and a record that agents write
and you read. Before 0.10 it was a session finder.

New:

- the record: cards, questions and conclusions (decisions, findings, verdicts), kept as plain files in the project
  folder. agents write it through an MCP server, `grove`, that every session runs for itself, so it works with Grove closed
- an inbox of what agents ask of you and what they decided without you, a cards screen, a page per card, and every
  conclusion in one searchable list
- starting an agent on the project's goal or on a card, in VS Code or in the background
- `⌘K` to go anywhere, switch project and find any Claude Code session on the machine
- a menu bar item with the count of what waits on you. closing the window hides it, and the app keeps running
- notifications when an agent asks you something on a card and when one stops mid-turn

Gone: the session list as a screen, the conversation pane, the agent inspector, the Agents view, the archive, token
counts, **New session...** and **Continue in background...**. Sessions are found from `⌘K`.

The first launch writes to disk, once:

- `~/claude-ws/combos.json` gets a `prefix` for every project (`AUTH`, so its cards are `AUTH-1`, `AUTH-2`, ...)
- `~/claude-ws/.grove/bin/record` and `record.cjs` are installed
- every project gets `.mcp.json` (only its `grove` entry is ours), `.claude/rules/grove-record.md` and
  `.claude/grove-project.json`, and in `.claude/settings.local.json` the `grove` server's approval, two allow rules
  (`mcp__grove`, and Bash for the launcher) and a `SessionStart` hook

Sessions that are open during the upgrade get the tools after a restart. The
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

