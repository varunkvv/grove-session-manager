export interface Patch<Row> {
  upserts: Row[];
  removes: string[];
  replace: boolean;
}

export interface PatchCoalescerOptions<Row> {
  intervalMs: number;
  keyOf: (row: Row) => string;
  emit: (patch: Patch<Row>) => void;
  now?: () => number;
}

/**
 * at most one patch per interval. the first change after a quiet period goes out at once, a
 * burst is folded into one trailing patch. within a pending patch the last word on a key wins,
 * so an upsert followed by a remove sends only the remove.
 */
export class PatchCoalescer<Row> {
  private readonly intervalMs: number;
  private readonly keyOf: (row: Row) => string;
  private readonly emit: (patch: Patch<Row>) => void;
  private readonly now: () => number;
  private upserts = new Map<string, Row>();
  private removes = new Set<string>();
  private replacing = false;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PatchCoalescerOptions<Row>) {
    this.intervalMs = opts.intervalMs;
    this.keyOf = opts.keyOf;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
  }

  upsert(rows: readonly Row[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      const key = this.keyOf(row);
      this.removes.delete(key);
      this.upserts.set(key, row);
    }
    this.schedule();
  }

  remove(keys: readonly string[]): void {
    if (keys.length === 0) return;
    for (const key of keys) {
      this.upserts.delete(key);
      // after a replace the receiver has nothing but the upserts, so there is nothing to remove
      if (!this.replacing) this.removes.add(key);
    }
    this.schedule();
  }

  /** the next patch carries the full list and tells the receiver to drop everything else */
  replace(rows: readonly Row[]): void {
    this.replacing = true;
    this.removes.clear();
    this.upserts = new Map(rows.map((row) => [this.keyOf(row), row]));
    this.schedule();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.replacing && this.upserts.size === 0 && this.removes.size === 0) return;
    const patch: Patch<Row> = {
      upserts: [...this.upserts.values()],
      removes: [...this.removes],
      replace: this.replacing,
    };
    this.upserts = new Map();
    this.removes = new Set();
    this.replacing = false;
    this.lastEmit = this.now();
    this.emit(patch);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.upserts.clear();
    this.removes.clear();
    this.replacing = false;
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = this.lastEmit + this.intervalMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }
}

/**
 * what changed between the rows a receiver already has and a fresh full listing.
 * rows are plain JSON, so equality is their serialised form.
 */
export function diffRows<Row>(
  have: ReadonlyMap<string, Row>,
  next: readonly Row[],
  keyOf: (row: Row) => string,
): { upserts: Row[]; removes: string[] } {
  const upserts: Row[] = [];
  const seen = new Set<string>();
  for (const row of next) {
    const key = keyOf(row);
    seen.add(key);
    const old = have.get(key);
    if (!old || JSON.stringify(old) !== JSON.stringify(row)) upserts.push(row);
  }
  const removes: string[] = [];
  for (const key of have.keys()) if (!seen.has(key)) removes.push(key);
  return { upserts, removes };
}
