import type { PushEvents } from "../shared/ipc.ts";

/** the slice of electron's WebContents this needs. keeps the module loadable without electron. */
export interface PushTarget {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export type RevDomain = "sessions" | "combos";

/**
 * main -> renderer events. a rev is taken at the moment a payload is built, so the renderer can
 * drop anything older than the bootstrap snapshot it already holds.
 */
export class Pusher {
  private readonly target: () => PushTarget | null;
  private readonly revs: Record<RevDomain, number> = { sessions: 0, combos: 0 };

  constructor(target: () => PushTarget | null) {
    this.target = target;
  }

  nextRev(domain: RevDomain): number {
    this.revs[domain] += 1;
    return this.revs[domain];
  }

  currentRevs(): Record<RevDomain, number> {
    return { ...this.revs };
  }

  send<K extends keyof PushEvents>(channel: K, payload: PushEvents[K]): void {
    const target = this.target();
    if (!target || target.isDestroyed()) return;
    try {
      target.send(`grove:${channel}`, payload);
    } catch {
      // the window went away between the check and the send
    }
  }
}
