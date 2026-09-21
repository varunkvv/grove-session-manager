import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { buildSessionUri, isValidSessionId } from "@grove/core";
import type { Deps } from "./deps.ts";

export type ResumeResult = "command" | "uri" | "invalid" | "expired" | "missing-claude" | "failed";

/** the command the Claude Code extension's own URI handler calls. contributed, but not documented. */
export const CLAUDE_OPEN_COMMAND = "claude-vscode.primaryEditor.open";

export async function transcriptExists(projectsDir: string, sessionId: string): Promise<boolean> {
  try {
    for (const dir of await readdir(projectsDir)) {
      try {
        await access(path.join(projectsDir, dir, `${sessionId}.jsonl`));
        return true;
      } catch {
        // not in this project
      }
    }
  } catch {
    // no projects dir
  }
  return false;
}

async function waitForFocus(deps: Deps, timeoutMs: number): Promise<boolean> {
  if (deps.isFocused()) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, timeoutMs);
    const sub = deps.onDidFocus(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(true);
    });
  });
}

/**
 * land this window on a session.
 *
 * first choice is the command, in process: same window by construction, and no "allow this
 * extension to open a URI?" prompt. awaiting the Claude extension's activation replaces a
 * blind sleep. if the command is gone or throws, fall back to the documented deep link, pinned
 * to this window - an unpinned vscode:// link goes to whichever window has focus, and a session
 * that lands in the wrong workspace silently starts a fresh conversation.
 */
export async function resumeSession(
  deps: Deps,
  sessionId: string,
  prompt?: string,
): Promise<ResumeResult> {
  if (!isValidSessionId(sessionId)) return "invalid";
  if (!(await transcriptExists(deps.projectsDir, sessionId))) {
    void deps.warn(
      "That session's transcript is gone. Claude Code deletes transcripts after 30 days by default.",
    );
    return "expired";
  }
  if (!(await deps.activateClaude())) {
    void deps.warn(
      "The Claude Code extension is not installed in this editor, so the session cannot be opened here.",
    );
    return "missing-claude";
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await deps.executeCommand(CLAUDE_OPEN_COMMAND, sessionId, prompt);
      deps.log(`resumed ${sessionId} via command`);
      return "command";
    } catch (e) {
      deps.log(`command attempt ${attempt + 1} failed: ${String(e)}`);
      if (!/not found/i.test(String(e))) break;
      await deps.delay(500);
    }
  }

  await waitForFocus(deps, 15_000);
  try {
    const opened = await deps.openExternalPinned(
      buildSessionUri(deps.uriScheme, sessionId, prompt),
    );
    deps.log(`resumed ${sessionId} via uri: ${opened}`);
    return opened ? "uri" : "failed";
  } catch (e) {
    deps.log(`uri fallback failed: ${String(e)}`);
    return "failed";
  }
}
