import type { Landing, LandingTarget } from "../../shared/ipc.ts";

export interface RevealOptions {
  /** bring the window forward: shown, restored if minimised, focused */
  raise: () => void;
  /** tell the page there is somewhere to land. it pulls the landing itself. */
  notify: () => void;
}

/**
 * where a notification click or a tray row takes the page. the page may not be there yet - the
 * click can be what started the app - so the landing is held until the page asks for it, once it
 * has connected. no timer: the page asks when it is ready, and a notice that arrives before it
 * listens costs nothing, because connecting asks anyway.
 */
export class Reveals {
  private readonly opts: RevealOptions;
  private pending: Landing | null = null;

  constructor(opts: RevealOptions) {
    this.opts = opts;
  }

  land(target: LandingTarget): Landing {
    this.opts.raise();
    this.pending = { target, at: Date.now() };
    this.opts.notify();
    return this.pending;
  }

  /** the landing the page has not taken yet, taken */
  take(): Landing | null {
    const landing = this.pending;
    this.pending = null;
    return landing;
  }
}
