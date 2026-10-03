// what grove notifies about, and when it holds one back. no electron import: main passes in how a
// notification is made, and what a click does. the question and stopped diffs are the caller's.
import { formatDuration, type LiveStatus, type ProjectId, squash } from "@grove/core";
import type { LandingTarget } from "../../shared/ipc.ts";

/** electron's Notification, as far as this uses it. a test root passes a recorder */
export interface Note {
  on(event: "click" | "close", listener: () => void): unknown;
  show(): void;
}

export interface NotifyOptions {
  /** the setting is not off, and the platform can show one */
  enabled: () => boolean;
  /** the main window has focus */
  focused: () => boolean;
  create: (n: { title: string; body: string }) => Note;
  /** where a folded stopped notification lands */
  land: (target: LandingTarget) => void;
}

export interface SessionNote {
  sessionId: string;
  /** the session's title */
  title?: string;
  /** the project it is in, or that holds the card it holds */
  project?: ProjectId;
  click: () => void;
}

/** a question and a finished turn from one session this close together notify once */
const ONCE_MS = 120_000;
/** stopped ones this close together fold into one: quitting the editor with several tabs mid-turn */
const FOLD_MS = 5_000;
/** a collected notification can lose its click, and macOS does not promise `close` */
const KEEP = 50;

/** only what is worth interrupting someone for. a short turn they are probably watching is not */
function liveBody(s: LiveStatus): string | null {
  if (s.state === "permission")
    return s.detail ? `Needs permission: ${s.detail}` : "Needs permission";
  if (s.state === "failed") return "Stopped on an API error";
  if (s.state === "waiting" && (s.turnMs ?? 0) >= 60_000) {
    const after = `Finished after ${formatDuration(s.turnMs ?? 0)}`;
    return s.detail ? `${after}: ${s.detail}` : after;
  }
  return null;
}

export class Notifier {
  private readonly o: NotifyOptions;
  private visible: ProjectId | null = null;
  /** when each session last showed a question or a finished turn */
  private asked = new Map<string, number>();
  private stops: Array<SessionNote & { project: ProjectId }> = [];
  private kept: Note[] = [];

  constructor(o: NotifyOptions) {
    this.o = o;
  }

  /** the project on screen in the main window. while it has focus, that project's notifications wait */
  setVisibleProject(id: ProjectId | null): void {
    this.visible = id;
  }

  /** permission, failed, and a turn over a minute finished */
  live(status: LiveStatus, s: SessionNote): void {
    const body = liveBody(status);
    if (!body) return;
    const show = () => this.post(s.project, s.title ?? "Claude session", body, s.click);
    if (status.state === "waiting") this.once(s.sessionId, show);
    else show();
  }

  /** a new open question to the person. `sessionId` is the agent that asked */
  question(q: {
    sessionId: string;
    project: ProjectId;
    projectName: string;
    card: string;
    text: string;
    click: () => void;
  }): void {
    this.once(q.sessionId, () =>
      this.post(q.project, `${q.projectName} · ${q.card}`, `Asks: ${squash(q.text, 160)}`, q.click),
    );
  }

  /** a session in a project stopped mid-turn. waits FOLD_MS for others to join it */
  stopped(s: SessionNote & { project: ProjectId }): void {
    this.stops.push(s);
    if (this.stops.length === 1) setTimeout(() => this.flushStops(), FOLD_MS);
  }

  private flushStops(): void {
    const left = this.stops.filter((s) => !this.holds(s.project));
    this.stops = [];
    const newest = left.at(-1);
    if (!newest) return;
    if (left.length === 1) {
      this.post(newest.project, newest.title ?? "Claude session", "Stopped mid-turn", newest.click);
      return;
    }
    this.post(newest.project, "Grove", `${left.length} agents stopped mid-turn`, () =>
      this.o.land({ view: "inbox", project: newest.project }),
    );
  }

  /** the window is focused on this project, or this is a session in no project */
  private holds(project: ProjectId | undefined): boolean {
    return this.o.focused() && (project === undefined || project === this.visible);
  }

  private once(sessionId: string, show: () => boolean): void {
    const now = Date.now();
    if (now - (this.asked.get(sessionId) ?? Number.NEGATIVE_INFINITY) < ONCE_MS) return;
    if (show()) this.asked.set(sessionId, now);
  }

  private post(
    project: ProjectId | undefined,
    title: string,
    body: string,
    click: () => void,
  ): boolean {
    if (!this.o.enabled() || this.holds(project)) return false;
    const n = this.o.create({ title, body });
    const drop = () => {
      this.kept = this.kept.filter((k) => k !== n);
    };
    n.on("click", () => {
      drop();
      click();
    });
    n.on("close", drop);
    this.kept.push(n);
    if (this.kept.length > KEEP) this.kept.shift();
    n.show();
    return true;
  }
}
