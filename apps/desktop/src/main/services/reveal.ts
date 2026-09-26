import type { LiveStatus } from "@grove/core";
import type { Landing, SessionKey } from "../../shared/ipc.ts";

export interface RevealOptions {
  /** the row of a session, by its id. several transcripts can share one: the newest is the one. */
  find: (sessionId: string) => { key: SessionKey; live?: LiveStatus } | undefined;
  needsYou: (live: LiveStatus | undefined) => boolean;
  /** bring the window forward: shown, restored if minimised, focused */
  raise: () => void;
  /** tell the page there is somewhere to land. it pulls the landing itself. */
  notify: () => void;
}

/**
 * where a notification click takes you: into grove, on that session. the page may not be there
 * yet - the click can be what started the app - so the landing is held until the page asks for
 * it, once it has connected. no timer: the page asks when it is ready, and a notice that arrives
 * before it listens costs nothing, because connecting asks anyway.
 */
export class Reveals {
  private readonly opts: RevealOptions;
  private pending: Landing | null = null;

  constructor(opts: RevealOptions) {
    this.opts = opts;
  }

  reveal(sessionId: string): Landing | null {
    const row = this.opts.find(sessionId);
    this.opts.raise();
    if (!row) return null;
    const waiting = this.opts.needsYou(row.live);
    const landing: Landing = {
      key: row.key,
      // answered in the editor while the notification sat there: it is not waiting any more
      scope: waiting ? "inbox" : "all",
      at: Date.now(),
    };
    // a subagent asking for permission: its own detail is where the question is
    if (waiting && row.live?.state === "permission" && row.live.agentId) {
      landing.agentId = row.live.agentId;
    }
    this.pending = landing;
    this.opts.notify();
    return landing;
  }

  /** the landing the page has not taken yet, taken */
  take(): Landing | null {
    const landing = this.pending;
    this.pending = null;
    return landing;
  }
}
