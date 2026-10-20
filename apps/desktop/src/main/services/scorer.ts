// main's side of the scorer process: started when there is something to judge, the model loaded
// once, then stopped again after a while with nothing to do, so its memory goes back.
import type { ModelEntry, Probs, Rubric, ScoreItem } from "@grove/core";
import type { FromScorer, ScorerMode, ToScorer } from "../../scorer/protocol.ts";

/** the slice of electron's UtilityProcess this needs */
export interface ScorerChild {
  postMessage(m: ToScorer): void;
  on(event: "message", listener: (m: FromScorer) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface ScorerOptions {
  spawn: () => ScorerChild;
  mode: ScorerMode;
  modelPath: string;
  model: ModelEntry;
  rubric: Rubric;
  /** with nothing to judge for this long, the process goes */
  idleMs?: number;
  /** one batch, the model's load included */
  timeoutMs?: number;
}

const IDLE_MS = 120_000;
const TIMEOUT_MS = 180_000;

export class Scorer {
  private child: ScorerChild | null = null;
  private loading: Promise<void> | null = null;
  private next = 0;
  private readonly waiting = new Map<number, (r: Array<Probs | null> | Error) => void>();
  private onLoad: ((r: string | null) => void) | null = null;
  private idle: NodeJS.Timeout | null = null;

  private readonly o: ScorerOptions;

  constructor(o: ScorerOptions) {
    this.o = o;
  }

  /** the process is up and its model loaded */
  get running(): boolean {
    return this.child !== null;
  }

  private start(): Promise<void> {
    if (this.loading) return this.loading;
    const child = this.o.spawn();
    this.child = child;
    this.loading = new Promise<void>((resolve, reject) => {
      this.onLoad = (error) => (error === null ? resolve() : reject(new Error(error)));
    });
    child.on("message", (m) => {
      if (m.type === "loaded") this.onLoad?.(null);
      else if (m.type === "failed") this.onLoad?.(m.error);
      else if (m.type === "scored") {
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        done?.(m.results);
      }
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.gone(new Error("The scorer stopped."));
    });
    child.postMessage({
      type: "load",
      mode: this.o.mode,
      modelPath: this.o.modelPath,
      model: this.o.model,
      rubric: this.o.rubric,
    });
    // a load that failed leaves nothing running: the next ask starts again
    this.loading.catch(() => this.stop());
    return this.loading;
  }

  private gone(why: Error): void {
    this.child = null;
    this.loading = null;
    this.onLoad?.(why.message);
    this.onLoad = null;
    for (const done of this.waiting.values()) done(why);
    this.waiting.clear();
  }

  /** one answer per item, null for one that was not judged */
  async score(items: ScoreItem[]): Promise<Array<Probs | null>> {
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.start();
      const child = this.child;
      if (!child) throw new Error("The scorer stopped.");
      const id = ++this.next;
      const answer = await new Promise<Array<Probs | null> | Error>((resolve) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          resolve(new Error("The scorer took too long."));
          this.stop();
        }, this.o.timeoutMs ?? TIMEOUT_MS);
        this.waiting.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        child.postMessage({ type: "score", id, items });
      });
      if (answer instanceof Error) throw answer;
      return answer;
    } finally {
      this.idle = setTimeout(() => this.stop(), this.o.idleMs ?? IDLE_MS);
      this.idle.unref?.();
    }
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.gone(new Error("The scorer stopped."));
    child?.kill();
  }
}
