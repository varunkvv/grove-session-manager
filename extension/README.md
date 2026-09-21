# Grove Companion

The in-editor half of Grove. The desktop app owns combos, worktrees and the session
finder. This extension does the few things that can only happen from inside VS Code:

- lands the window on the Claude Code session the app handed over
- keeps a combo's references in `permissions.additionalDirectories`
- shows the current combo in the status bar, and warns once when its worktrees drifted
- `Grove: Find Session` (`ctrl+alt+s`) and `Grove: Open Combo` (`ctrl+alt+o`)

It needs the Claude Code extension (`anthropic.claude-code`) to resume a session.
