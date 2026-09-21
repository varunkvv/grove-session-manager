# Grove

_A session and workspace manager for Claude Code._

Named multi-repo workspaces ("combos") for Claude Code, and a search across every Claude Code session on the machine.

Two pieces:

- **the app** (`apps/desktop`, Electron) - the session finder, combos, worktree lifecycle, launching the editor
- **the companion extension** (`extension/`) - the few things that can only happen from inside VS Code or Cursor: landing a
  window on a session, syncing a combo's references, showing drift

The app never drives Claude. It owns directories on disk and hands off to the editor.

## How it works

A combo owns a directory, `~/claude-ws/<combo>/`. That directory - not any of your repos - is the primary workspace folder,
so it is Claude's working directory. Two things follow:

- sessions started there land in their own `~/.claude/projects/<slug>/`, so the combo's sessions are a directory listing,
  not a guess. sessions started by hand, from a terminal, or while the app was closed are picked up the same way
- the Claude Code panel's own history is already scoped to the combo

Folders in a combo are one of:

| mode | what it is | when |
| --- | --- | --- |
| working copy | a `git worktree` inside the combo folder. detached at HEAD by default, so two combos can hold the same repo | you will edit here |
| reference | your real clone, added as a second workspace root and to `permissions.additionalDirectories` | context to read |

The combo dialog lists the folders you use most as one-click chips: the repos your sessions ran in (a session started
in a subfolder counts toward its repo), and folders already in other combos, ranked by how often and how recently.
The file picker is still there for anything else.

A working copy starts clean. Your uncommitted changes, dev servers and editor state stay in the original clone.

### What a session in a combo is told

Every session started in the combo root loads its `CLAUDE.md`, forks and background agents included. The stub says
what the folder is (a combo of git worktrees, and what a worktree implies), where plans and generated artifacts go
(`plans/`, `artifacts/` - never inside a working copy), and how to leave word for other sessions: several can work in
one combo at once without sharing a conversation, so `context/` is the memory they have in common.

### Long work in the background, as a switch

By default a combo tells Claude to hand long autonomous work to a background agent, so the conversation stays free to
answer questions and plan. Three files do it:

- `.claude/agents/long-task.md` - an agent with `background: true` in its frontmatter. A subagent never sees the
  conversation that spawned it, which is what the plan file is for: the plan in `plans/` is its brief
- `.claude/long-work.md` - the policy: background, or here in the conversation. The app owns this file
- `CLAUDE.md` only says "read `.claude/long-work.md` before long work, every time"

The indirection is the point. `CLAUDE.md` is read once, when a session starts, so a switch written there could never reach
a session that is already running. The policy file is read at the moment of decision, so flipping it takes effect on a
running session's next long task. Flip it in the app (the switch in an open combo) or from the editor
(`Grove: Toggle Background Long Work`). Saying "do this one here" in the chat overrules it for a single task.

It is a default by instruction, not an enforcement: Claude still decides what counts as long.

### Needs you

Run a few sessions at once and the slow part is noticing that one of them stopped: it wants permission for a
command, or it finished its turn twenty minutes ago in a window you are not looking at. Grove pins those sessions to
the top of the list under **Needs you**, badges the combo and the dock icon, and sends a notification when a session
asks for permission or finishes a turn that ran for over a minute. Clicking the notification lands you on the session.
Running sessions show a quiet "Running".

The transcript cannot tell "running a tool" from "waiting on a permission prompt", so this comes from Claude Code
hooks. Every combo's `.claude/settings.local.json` gets a few async hooks (`UserPromptSubmit`, `PermissionRequest`,
`PostToolUse`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`) that drop the hook's input into
`~/claude-ws/.grove/events/`. Claude Code watches its settings files, so sessions that are already running pick the
hooks up too. Sessions outside combos report only if you switch on **Track sessions outside combos** in Settings, which
adds the same hooks to Claude Code's own `settings.json`; switching it off takes them out again.

Landing on a session, or **Mark as seen** in its action menu, takes it out of the list until its next event.

### Search reaches the whole conversation

Typing filters titles and prompts instantly. A moment later the app also looks through everything that was said in
each session (what you typed, what Claude wrote back, and the files and commands its tools touched), and those
matches join the list with the line that matched. Tool output and thinking are left out: they are most of the bytes
and almost none of what people remember. The text is kept in `.grove/text/`, built by the same pass that counts
tokens, and only the appended part of a transcript is read after the first time.

### Tokens per model

Every row shows what the session spent, per model (the two biggest on the row, all of them in the action menu), subagents
included. The counts come from `message.usage` on each response in the transcript. That is the one thing that needs the
whole file, so it is read once in a background pass after the list is up, then only what was appended. Cache reads and
writes match Claude Code's own `/cost`. Its input and output run a bit higher, because it also counts side calls (titles,
compaction) that are never written to the transcript.

## On disk

```
~/claude-ws/
  combos.json                   source of truth. hand-editable. unknown keys and formatting are preserved
  settings.json                 optional: editor, binary paths
  .grove/                       cache only - safe to delete. events/ is where session status hooks write
  <combo>/
    <combo>.code-workspace      generated. only `folders` is ours, the rest is preserved
    CLAUDE.md                   written once when the combo is created. yours after that
    plans/  artifacts/  context/  made once, with the root. where sessions keep what outlives them
    .claude/agents/long-task.md written once. `background: true`, so long work never blocks the conversation
    .claude/long-work.md        generated. whether long work goes to that agent. flips mid-session
    .claude/settings.local.json only our entries in permissions.additionalDirectories are touched
    <repo>/                     working copies
```

The app never writes inside `~/.claude` (the one exception is the opt-in status hooks above, and only in
`settings.json`), never copies a transcript, never deletes a branch, and never runs
`git worktree remove --force` unless you confirm it for one specific folder.

Drift is normal: people run `git worktree remove` and `rm -rf` behind the app's back, and Claude Code expires transcripts.
Folder states are `ok`, `reference`, `absent`, `stale`, `foreign` (left alone) and `missing-origin`.

## Develop

Needs node >= 22.12, pnpm 10, git >= 2.36.

```bash
pnpm install
pnpm test               # core + extension + app logic (vitest, real throwaway git repos)
pnpm typecheck && pnpm lint

pnpm grove list            # every session on this machine, straight from the core
pnpm grove search queue
pnpm oracle --strict    # diff our index against the Agent SDK's listSessions() (cd tools/oracle && pnpm install --ignore-workspace --no-optional first)

pnpm app:dev            # the app, with hot reload
pnpm app:e2e            # Playwright drives the real built app against temp fixtures
pnpm ext:package && pnpm ext:install        # or ext:install:cursor
pnpm app:package        # apps/desktop/dist/*.dmg, ad-hoc signed
pnpm app:packaged       # smoke test the packaged app
```

The icon is [apps/desktop/resources/icon.svg](apps/desktop/resources/icon.svg); `node apps/desktop/scripts/make-icon.mjs`
re-renders the PNG that electron-builder turns into the `.icns`.

Layout: `packages/core` is pure Node TypeScript with no runtime dependencies, and is the only implementation of the
transcript parser, the combo model and the git layer. The app's main process and the extension both bundle it from source.

`GROVE_ROOT` and `CLAUDE_CONFIG_DIR` move the app root and Claude's config dir. The e2e tests isolate
themselves with them.

## Install it

Download the latest `.dmg` from [Releases](https://github.com/varunkvv/grove-session-manager/releases/latest), open it,
and drag **Grove** onto Applications. Apple Silicon only. Every merge to `main` publishes one: the workflow in
[.github/workflows/ci.yml](.github/workflows/ci.yml) runs the tests, builds the DMG on a clean macOS runner, and tags it
`v<major>.<minor>.<run number>`. The five newest releases are kept.

Or build it yourself:

```bash
pnpm app:package
open apps/desktop/dist
```

It is ad-hoc signed, which is enough to run on the machine that built it. A DMG that travels through
a browser, Slack or AirDrop is quarantined by macOS, and needs
`xattr -dr com.apple.quarantine "/Applications/Grove.app"` once.

It follows the macOS appearance, light or dark, and switches with it. Settings → Appearance pins it
to one.

## Things people will report as bugs

- **a session disappeared** - Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`). the VS Code panel also
  archives sessions after 14 days idle (`claudeCode.archiveInactiveSessions`). archived ones still show here
- **"2d ago" does not match the file's date** - rows sort by the last message, not the file's mtime. Claude Code appends
  title records to old transcripts long after the conversation ended
- **the app does not open from a download** - it is ad-hoc signed. `xattr -dr com.apple.quarantine "Grove.app"`
- **landing opened a fresh conversation** - the companion extension is not installed in that editor (the app shows a banner
  and can install it), or the transcript expired

The transcript format is internal to Claude Code and changes between releases. What this project relies on, and how it was
verified, is in [docs/claude-code-facts.md](docs/claude-code-facts.md).

## License

MIT. Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
