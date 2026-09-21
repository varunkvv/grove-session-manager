# Claude Code facts this project depends on

Verified on 2026-09-20 against 39 real transcripts (71,100 entries, Claude Code 2.1.221 - 2.1.278), the installed
Claude Code VS Code extension 2.1.278 bundle, the `claude` binary, and the docs at https://code.claude.com/docs.

The transcript format is internal and the docs say it changes between releases. Re-check after a Claude Code
upgrade with `pnpm oracle --strict`, which diffs our index against the Agent SDK's `listSessions()`.

Things that look surprising in the code usually trace back to a line in this file.
**Record types seen (18):** attachment, assistant, user, last-prompt, ai-title, atis-latch, bridge-session, queue-operation, mode, pr-link, custom-title, agent-name, system, file-history-snapshot, file-history-delta, permission-mode, cost-state, teleported-from. No `summary`, no `tag` in this corpus (official code still reads both).

```
{"type":"ai-title","aiTitle":"…","sessionId":"…"}
{"type":"custom-title","customTitle":"…","sessionId":"…"}
{"type":"agent-name","agentName":"…","sessionId":"…"}          equals customTitle where seen
{"type":"last-prompt","lastPrompt":"…"|null,"leafUuid":"…","sessionId":"…"}
{"type":"pr-link","prNumber":1042,"prUrl":"…","prRepository":"owner/name","timestamp":"…"}
{"type":"teleported-from","remoteSessionId":"…","branch":"main","messageCount":0}     whole file, 113 bytes, no sessionId/cwd
```

Message-bearing entries (user/assistant/attachment/system) carry: `cwd, gitBranch, sessionId, session_id, version, entrypoint, userType, uuid, parentUuid, timestamp, isSidechain, slug`. `entrypoint` = `claude-vscode` | `claude-desktop` | `cli`. Bookkeeping records carry only `type` + `sessionId`.

**Reading:** official = head 65536 + tail 65536 (one read when size <= 65536), string-scan for the LAST `"key":"` / `"key": "`, tail before head. Official display precedence: customTitle(tail) -> `<projectDir>/<sessionId>/custom-title.json` -> customTitle(head) -> aiTitle(tail) -> aiTitle(head) -> lastPrompt(tail) -> summary(tail) -> first prompt(head). Also lifts `tag` (last `"type":"tag"` in tail), gitBranch (tail then head), cwd = `relocatedCwd`(tail) ?? cwd(head), createdAt = first timestamp. Titles cut at 200 chars. Sessions whose first line has `isSidechain:true` are not listed.

**Ours:** each title field = tail ?? head, where `null` / empty / non-string counts as absent (all 4 CLI-entrypoint files open with `{"type":"last-prompt","lastPrompt":null}` - must not title as "null"; one of them becomes a fixture). customTitle = tail -> sidecar -> head. Precedence D2. Whitespace collapsed, 200 char cap, prompts indexed to 500 chars. `lastActivityMs` = max timestamp of user/assistant lines in the tail.

**Head facts:** line 1 <= 1.4KB. Head ends mid-line in 33/39 files -> cut at last `\n`. Tail starts mid-line -> drop to first `\n`. Lines up to 64KB (attachments) sit in the first 20 lines but always after the first prompt. First real prompt ends by byte 31.6KB. Two unrelated sessions share one customTitle -> row identity is the transcript path, never the title.

**First prompt:** skip the entry when `isSidechain`, `isMeta`, `isCompactSummary`, a `toolUseResult` key, any `tool_result` block, or `origin.kind === "task-notification"`. Content is a string or an array of text blocks. Per block: strip leading / trailing anchored `<system-reminder>…</system-reminder>` spans, then drop if empty or starting with `<`, `Caveat:`, `[Request interrupted`. Join survivors. Nothing survives -> next user entry. `<command-name>/x</command-name><command-args>…` -> `firstCommand = "/x args"`.

**Scan:** `projects/<dir>/<stem>.jsonl`, depth 2 only, stem without `.`, size > 0. Siblings to ignore: `<sessionId>/` (custom-title.json, subagents/, tool-results/, workflows/), `memory/`, `*.orphaned-*.jsonl`, `*.jsonl.superseded-*`. Some project dirs hold no transcript. `sessionId` == filename stem always. One sessionId per file.

**Token usage:** each assistant line carries `message.model`, `message.id` and `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`). One API response is written as one line per content block, all with the same `message.id`, and later blocks can carry a larger `output_tokens` (906 of ~10k responses). Blocks of one response are usually adjacent, not always (36 cases). So: last line per id wins. `model: "<synthetic>"` marks entries Claude Code writes itself (API errors), zero spend. Usage is spread over the whole file, so it is the one thing we read in full: once, then incrementally from a saved byte offset, only whole lines. Subagent transcripts are `<sessionId>/subagents/*.jsonl` and `<sessionId>/subagents/workflows/<wf>/*.jsonl`, and count toward the session. A `cost-state` record (rare, not per turn) holds Claude Code's own `modelUsage`: its cache read / write totals match our sum exactly, its input and output are higher - it also counts side calls that never land in the transcript.

**Hooks (verified with claude 2.1.278, `-p` session):** each event's stdin is one JSON object with `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `permission_mode`. `PostToolUse` adds `tool_name`, `tool_input`, `tool_response`. `Stop` adds `last_assistant_message` and `background_tasks`. `SessionEnd` adds `reason`. Events raised by a subagent carry `agent_id`. Docs: `PermissionRequest` fires when a tool call needs a decision. `Notification` has `notification_type` (`permission_prompt` after ~6s, `idle_prompt` after ~60s idle, `agent_needs_input`, ...). Hooks in `.claude/settings.local.json` are honoured, settings files are watched so a running session picks up new hooks, and `async: true` keeps a hook from blocking the turn.

**Slug (byte-identical in CLI and extension):**
```js
function slug(cwd){ const s = cwd.replace(/[^a-zA-Z0-9]/g,'-'); if (s.length <= 200) return s;
  let h = 0; for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;   // over the ORIGINAL cwd
  return `${s.slice(0,200)}-${Math.abs(h).toString(36)}` }
```
Input is `realpathSync`'d and NFC-normalised on darwin. Never reverse a slug.

**Claude Code VS Code extension 2.1.278:** activation `onStartupFinished`, no `onUri`. `registerCommand("claude-vscode.primaryEditor.open", async (session, prompt) => createPanel(…))`. URI `/open` reads only `session` + `prompt`, validates session as 1-200 chars without `/ \ .. NUL`, then calls that command. An already-open session tab is revealed and the prompt dropped. cwd = `workspaceFolders[0]` (realpath + NFC), other roots -> additionalDirectories for the spawned process. Session list scope root = `workspaceFolders[0]`. Its keybindings: `alt+k`, `cmd+escape`, `cmd+shift+escape`, `cmd+alt+k`, `ctrl+alt+f`, `cmd+shift+t`, `cmd+n`. Docs: "The session must belong to the workspace currently open in VS Code. If the session isn't found, a fresh conversation starts instead." / "If VS Code is already running, the URL opens in whichever window is currently focused."

**VS Code URI routing:** `openExternal(vscode://…)` -> renderer -> main process. `windowId=<n>` in the query routes to that window, else the last active one. `vscode.env.asExternalUri(appSchemeUri)` appends this window's `windowId`. Use `vscode.env.uriScheme` (Cursor's is `cursor`). `anthropic.claude-code` is not in `trustedExtensionProtocolHandlers` -> one-time modal.

**Docs:** `claude --resume <id>` works from any directory since 2.1.223, but reports not-found when copies exist in several project dirs. `claude --resume <transcript-path>` works. `/cd` and Claude-created worktrees relocate the transcript. `claude-cli://open` has only `q`, `cwd`, `repo` - no resume param. Retention 30 days (`cleanupPeriodDays`, min 1), desktop transcripts exempt. Panel auto-archive 14 days (enum 0/1/2/7/14). `settings.local.json` applies without the trust step unless git-tracked. Lists merge across settings scopes. `additionalDirectories` from settings never loads CLAUDE.md / rules / skills. Subdirectory CLAUDE.md loads on demand. `claude agents --json` is the supported liveness surface (not used in v1). Agent SDK 0.3.278: `listSessions({dir?, limit?})` -> `{sessionId, summary, lastModified, fileSize, customTitle, firstPrompt, gitBranch, cwd, tag, createdAt}`.

**A typical macOS install:** VS Code `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`, extensions `~/.vscode/extensions` (`extensions.json` array + `.obsolete` map). Cursor `/Applications/Cursor.app/Contents/Resources/app/bin/code`, `~/.cursor/extensions`. claude `~/.local/bin/claude`. git prints realpaths in porcelain (`/private/tmp/...`), and a PATH can put a version-manager shim ahead of the real git - the resolver skips anything under `/shims/`.

**Fixtures** in `packages/core/test/fixtures/` are real transcripts with every string replaced (structure kept, byte lengths preserved so offsets survive): `tail50k` (first ai-title at byte 50,841 - past a 48KB head, inside the 64KiB one), `middle` (a single ai-title in the unread middle of a large file - falls back to the first prompt), `twotitles` (several ai-titles, last wins), `sidecar` (custom-title + sidecar file + agent-name), `command` (a CLI session that is only slash commands), `idefirst` (an `<ide_opened_file>` block before the typed text), `stub` (a 113-byte teleported-from marker).

## Electron, not Claude Code

**`nativeTheme.themeSource` does not reach the renderer's `prefers-color-scheme` in Electron 44.**
Verified on 44.4.3: main reported `shouldUseDarkColors: true` while the page still matched
`(prefers-color-scheme: light)`. So the app pins a chosen appearance with a `data-theme` attribute
on `:root` (carried on the page URL, so the first frame is already right) and keeps `themeSource`
only for the window frame and the native menus. Re-check on an Electron upgrade: if it starts
working, the attribute can go.
