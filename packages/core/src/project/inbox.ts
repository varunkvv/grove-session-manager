// the inbox: the sessions that need the person, one row each.
// pure: built in main, and importable by the renderer through @grove/core/pure.
import { needsYou } from "../sessions/needsYou.ts";
import { squash } from "../transcript/title.ts";
import type { LiveStatus } from "../types.ts";
import type { SessionFacts } from "./derive.ts";
import type { ProjectId } from "./ids.ts";

export type InboxKind = "permission" | "turn" | "failed" | "stopped";

/** the row, the panel, the sessions list and the tray menu all read these */
export const KIND_WORD: Record<InboxKind, string> = {
  permission: "Needs permission",
  turn: "Your turn",
  failed: "Failed",
  stopped: "Stopped",
};

export interface InboxInput {
  project: ProjectId;
  /** the sessions in the project that are live or were interrupted */
  sessions: Iterable<SessionFacts>;
  /** this project's marks from reviewed.json */
  reviewed: ReadonlySet<string>;
}

export interface InboxRow {
  /** the session's id: a session has one row */
  id: string;
  project: ProjectId;
  kind: InboxKind;
  /** ms */
  at: number;
  summary: string;
  /** what Dismiss does. `seen:` changes the session's status instead of being marked */
  reviewKeys: string[];
}

/** newest first. ties by id. main sorts every project's rows together with it */
export function inboxOrder(a: InboxRow, b: InboxRow): number {
  return b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** what a session that needs the person is at */
function asks(live: LiveStatus): Pick<InboxRow, "kind" | "summary"> {
  if (live.state === "permission") {
    // the tool, and what it would act on
    return { kind: "permission", summary: [live.detail, live.target].filter(Boolean).join(" ") };
  }
  if (live.state === "failed") {
    return { kind: "failed", summary: squash(live.detail ?? "", 200) || "Stopped on an API error" };
  }
  // the end of its last message: where the question is
  return { kind: "turn", summary: live.question || live.detail || "" };
}

export function buildInbox(i: InboxInput): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const f of i.sessions) {
    const stop = f.interrupted;
    const key = stop && `stopped:${f.sessionId}@${stop.at ?? "failed"}`;
    // a mark hides the stop it was made for. the next one has another time, so it shows
    const stopped = key && !i.reviewed.has(key) ? key : undefined;
    const live = needsYou(f.live) ? f.live : undefined;
    // its process is gone, which is the last word on it, whatever its status said before
    const what: Pick<InboxRow, "kind" | "at" | "summary"> | undefined = stopped
      ? {
          kind: "stopped",
          // a failure the supervisor reported comes with no time of grove's own
          at: stop?.at ?? f.live?.at ?? 0,
          // what it was working on
          summary: squash(f.lastPrompt ?? "", 200),
        }
      : live && { ...asks(live), at: live.at };
    if (!what) continue;
    rows.push({
      id: f.sessionId,
      project: i.project,
      ...what,
      // Dismiss clears the row whole: the stop, and the status behind it when it also asks
      reviewKeys: [...(stopped ? [stopped] : []), ...(live ? [`seen:${f.sessionId}`] : [])],
    });
  }
  return rows.sort(inboxOrder);
}
