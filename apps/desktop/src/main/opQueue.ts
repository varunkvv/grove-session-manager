interface Job {
  key?: string;
  run: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Lane {
  concurrency: number;
  running: number;
  queued: Job[];
}

export interface RunOptions {
  /**
   * a job with the same key that has not started yet absorbs this one: both callers get its
   * result. a RUNNING job never absorbs, because whatever asked again may have changed since.
   */
  key?: string;
}

/**
 * named lanes with their own concurrency. git mutations share one lane of 1 (combos can share
 * an origin repo and contend on its locks), reads get a wider lane. a failed job rejects its
 * own promise and nothing else.
 */
export class OpQueue<L extends string> {
  private readonly lanes = new Map<L, Lane>();
  private idleWaiters: Array<{ lane?: L; resolve: () => void }> = [];

  constructor(lanes: Record<L, number>) {
    for (const [name, concurrency] of Object.entries(lanes) as Array<[L, number]>) {
      this.lanes.set(name, { concurrency: Math.max(1, concurrency), running: 0, queued: [] });
    }
  }

  run<T>(laneName: L, task: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
    const lane = this.lane(laneName);
    if (opts.key !== undefined) {
      const waiting = lane.queued.find((j) => j.key === opts.key);
      if (waiting) return waiting.promise as Promise<T>;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    lane.queued.push({ key: opts.key, run: task, promise, resolve, reject });
    this.pump(lane);
    return promise as Promise<T>;
  }

  /** running or waiting */
  busy(laneName: L): boolean {
    const lane = this.lane(laneName);
    return lane.running > 0 || lane.queued.length > 0;
  }

  size(laneName: L): { running: number; queued: number } {
    const lane = this.lane(laneName);
    return { running: lane.running, queued: lane.queued.length };
  }

  /** resolves once the lane (or every lane) has nothing running and nothing waiting */
  onIdle(laneName?: L): Promise<void> {
    if (this.isIdle(laneName)) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push({ lane: laneName, resolve }));
  }

  private isIdle(laneName?: L): boolean {
    if (laneName !== undefined) return !this.busy(laneName);
    return [...this.lanes.keys()].every((name) => !this.busy(name));
  }

  private lane(name: L): Lane {
    const lane = this.lanes.get(name);
    if (!lane) throw new Error(`unknown lane: ${name}`);
    return lane;
  }

  private pump(lane: Lane): void {
    while (lane.running < lane.concurrency) {
      const job = lane.queued.shift();
      if (!job) break;
      lane.running++;
      // the task may throw synchronously. that is a rejection too, not a stuck lane.
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.running--;
          this.pump(lane);
          this.settleIdle();
        });
    }
  }

  private settleIdle(): void {
    if (this.idleWaiters.length === 0) return;
    const still: typeof this.idleWaiters = [];
    for (const w of this.idleWaiters) {
      if (this.isIdle(w.lane)) w.resolve();
      else still.push(w);
    }
    this.idleWaiters = still;
  }
}
