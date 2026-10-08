// where a session runs, and what the inbox needs to know about it.
// pure: the renderer imports this through @grove/core/pure.
import type { LiveStatus } from "../types.ts";

/** where a session's process is right now */
export type Runtime = "vscode" | "terminal" | "background" | "elsewhere" | "closed";

/** what the inbox needs about one session. a SessionRow in main is one */
export interface SessionFacts {
  sessionId: string;
  live?: LiveStatus;
  interrupted?: { why: "gone" | "failed"; at?: number };
  lastPrompt?: string;
}

/**
 * `holder` is LiveService's registry entry. it can name a process that is gone (the list is only
 * replaced on a non-empty read), so `alive` decides.
 */
export function runtimeOf(i: {
  held?: boolean;
  holder?: { kind?: string; entrypoint?: string };
  alive: boolean;
}): Runtime {
  if (i.held || i.holder?.kind === "bg") return "background";
  if (!i.holder || !i.alive) return "closed";
  if (i.holder.entrypoint === "claude-vscode") return "vscode";
  if (i.holder.entrypoint === "cli") return "terminal";
  // claude -p and SDK processes (sdk-cli), or no entrypoint at all
  return "elsewhere";
}
