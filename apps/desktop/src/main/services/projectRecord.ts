// each project's record in memory: read whole once, then kept current from fs.watch, with a pass
// every 30s for what the watch missed (it can miss a change right after it starts, and FSEvents
// coalesces). the readers never throw, so a cut-off file is a problem on the snapshot, not an error.
import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import path from "node:path";
import type { ProjectId } from "@grove/core";
import * as record from "@grove/record";
import type { Card, Conclusion } from "@grove/record/types";
import { log } from "../log.ts";

/** a record file that did not parse whole, relative to the project root */
export interface RecordProblem {
  file: string;
  problems: string[];
}

type Reader = Pick<typeof record, "readRecord" | "readCard" | "readConclusions" | "listCardIds">;

export interface ProjectRecordOptions {
  /** the @grove/record readers. a test passes counting wrappers */
  reader?: Reader;
  /** a project's cards, conclusions or both changed. the first read reports both */
  onChange: (id: ProjectId, part: { cards: boolean; conclusions: boolean }) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  backstopMs?: number;
}

export interface ProjectSnapshot {
  root: string;
  /** by card id */
  cards: Map<string, Card>;
  /** newest first, superseded marked */
  conclusions: Conclusion[];
  problems: RecordProblem[];
  readAt: number;
}

type Part = "root" | "cards" | "conclusions";

interface Watched {
  id: ProjectId;
  root: string;
  snap?: ProjectSnapshot;
  watchers: Partial<Record<Part, FSWatcher>>;
  errors: number;
  retry?: NodeJS.Timeout;
  dirty: { all: boolean; cards: Set<string>; conclusions: boolean };
  first?: number;
  timer?: NodeJS.Timeout;
  /** what each card's files looked like just before it was last read. "" is the conclusions */
  stamps: Map<string, string>;
  gone?: boolean;
}

const CONCLUSION_FILE = /^[DFV]-[1-9][0-9]*\.md$/;

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** card.md's mtime and size, and the names in comments/ and claims/. "" when there is no card.md */
function cardStamp(root: string, id: string): string {
  const dir = path.join(root, "cards", id);
  try {
    const s = statSync(path.join(dir, "card.md"));
    const files = (sub: string) => names(path.join(dir, sub)).filter((n) => !n.startsWith("."));
    return `${s.mtimeMs}:${s.size}:${files("comments")}:${files("claims")}`;
  } catch {
    return "";
  }
}

/** the names and mtimes in conclusions/ */
function conclusionsStamp(root: string): string {
  const dir = path.join(root, "conclusions");
  return names(dir)
    .filter((n) => CONCLUSION_FILE.test(n))
    .sort()
    .map((n) => {
      try {
        return `${n}:${statSync(path.join(dir, n)).mtimeMs}`;
      } catch {
        return n;
      }
    })
    .join(",");
}

function problemsOf(
  root: string,
  cards: Iterable<Card>,
  conclusions: readonly Conclusion[],
): RecordProblem[] {
  const out: RecordProblem[] = [];
  const add = (x: { file: string; problems: string[] }) => {
    if (x.problems.length) out.push({ file: path.relative(root, x.file), problems: x.problems });
  };
  for (const c of cards) {
    add(c);
    for (const x of c.comments) add(x);
    for (const x of c.claims) add(x);
  }
  for (const c of conclusions) add(c);
  return out;
}

export class ProjectRecordService {
  private readonly o: ProjectRecordOptions;
  private readonly reader: Reader;
  private projects = new Map<ProjectId, Watched>();
  private queue: Watched[] = [];
  private backstop: NodeJS.Timeout;

  constructor(o: ProjectRecordOptions) {
    this.o = o;
    this.reader = o.reader ?? record;
    this.backstop = setInterval(() => this.check(), o.backstopMs ?? 30_000);
    this.backstop.unref?.();
  }

  /** from the combo model. a new project is read whole, one project per macrotask */
  setProjects(list: readonly { id: ProjectId; root: string }[]): void {
    const keep = new Set<ProjectId>();
    for (const { id, root } of list) {
      keep.add(id);
      const had = this.projects.get(id);
      if (had?.root === root) continue;
      if (had) this.close(had);
      const p: Watched = {
        id,
        root,
        watchers: {},
        errors: 0,
        dirty: { all: false, cards: new Set(), conclusions: false },
        stamps: new Map(),
      };
      this.projects.set(id, p);
      this.queue.push(p);
      if (this.queue.length === 1) setImmediate(() => this.readNext());
    }
    for (const p of [...this.projects.values()]) if (!keep.has(p.id)) this.close(p);
  }

  snapshot(id: ProjectId): ProjectSnapshot | undefined {
    return this.projects.get(id)?.snap;
  }

  /** the backstop pass now: window focus, power resume, refresh, a write grove just made. sync */
  check(id?: ProjectId): void {
    for (const p of this.projects.values()) {
      if (!p.snap || (id !== undefined && p.id !== id)) continue;
      this.attach(p);
      const ids = new Set(names(path.join(p.root, "cards")).filter((n) => record.CARD_ID.test(n)));
      for (const k of p.stamps.keys()) if (k) ids.add(k);
      for (const c of ids)
        if (cardStamp(p.root, c) !== (p.stamps.get(c) ?? "")) p.dirty.cards.add(c);
      if (conclusionsStamp(p.root) !== (p.stamps.get("") ?? "")) p.dirty.conclusions = true;
      this.flush(p);
    }
  }

  dispose(): void {
    clearInterval(this.backstop);
    for (const p of [...this.projects.values()]) this.close(p);
  }

  private readNext(): void {
    const p = this.queue.shift();
    if (p && !p.gone) {
      this.attach(p);
      for (const id of names(path.join(p.root, "cards"))) {
        if (record.CARD_ID.test(id)) p.stamps.set(id, cardStamp(p.root, id));
      }
      p.stamps.set("", conclusionsStamp(p.root));
      const r = this.reader.readRecord(p.root);
      const cards = new Map(r.cards.map((c) => [c.id, c]));
      p.snap = {
        root: p.root,
        cards,
        conclusions: r.conclusions,
        problems: problemsOf(p.root, cards.values(), r.conclusions),
        readAt: Date.now(),
      };
      this.o.onChange(p.id, { cards: true, conclusions: true });
    }
    if (this.queue.length) setImmediate(() => this.readNext());
  }

  /** every watch whose folder is there and not watched yet. the record folders appear on the first write */
  private attach(p: Watched): void {
    if (p.gone) return;
    const on = (part: Part, dir: string, recursive: boolean, hit: (name: string) => void) => {
      if (p.watchers[part]) return;
      try {
        const w = watch(dir, { recursive, persistent: false }, (_e, name) => {
          if (name !== null) return hit(name.toString());
          // no name: anything under this watch may have changed
          this.mark(p, { all: part !== "conclusions", conclusions: part !== "cards" });
        });
        w.on("error", (e) => {
          log.warn(`record watch ${dir}:`, e);
          w.close();
          delete p.watchers[part];
          const backoff = [1000, 5000, 30_000][Math.min(p.errors++, 2)];
          p.retry = setTimeout(() => this.attach(p), backoff);
          p.retry.unref?.();
        });
        p.watchers[part] = w;
      } catch {
        // not there yet. the root watch or the next pass attaches it
      }
    };
    // the root only matters until both record folders are watched. it also reports them on writes inside
    on("root", p.root, false, (name) => {
      if ((name !== "cards" && name !== "conclusions") || p.watchers[name]) return;
      this.attach(p);
      this.mark(p, name === "cards" ? { all: true } : { conclusions: true });
    });
    on("cards", path.join(p.root, "cards"), true, (name) => {
      const segs = name.split(path.sep);
      // the publish temp files sit beside their target, inside the card's folder
      if (segs.some((s) => s.startsWith("."))) return;
      const id = segs[0] ?? "";
      if (record.CARD_ID.test(id)) this.mark(p, { card: id });
    });
    on("conclusions", path.join(p.root, "conclusions"), false, (name) => {
      if (CONCLUSION_FILE.test(name)) this.mark(p, { conclusions: true });
    });
  }

  /** collects for debounceMs after the last event, at most maxWaitMs after the first */
  private mark(p: Watched, what: { all?: boolean; card?: string; conclusions?: boolean }): void {
    if (what.all) p.dirty.all = true;
    if (what.card) p.dirty.cards.add(what.card);
    if (what.conclusions) p.dirty.conclusions = true;
    const now = Date.now();
    p.first ??= now;
    clearTimeout(p.timer);
    const wait = Math.min(this.o.debounceMs ?? 150, p.first + (this.o.maxWaitMs ?? 1000) - now);
    p.timer = setTimeout(() => this.flush(p), Math.max(0, wait));
  }

  private flush(p: Watched): void {
    clearTimeout(p.timer);
    p.first = undefined;
    const { all, cards, conclusions } = p.dirty;
    p.dirty = { all: false, cards: new Set(), conclusions: false };
    // before the first read there is nothing to update: that read takes everything
    if (!p.snap || p.gone || (!all && !cards.size && !conclusions)) return;
    const snap = p.snap;
    const read = (id: string) => {
      p.stamps.set(id, cardStamp(p.root, id));
      const c = this.reader.readCard(p.root, id);
      if (c) snap.cards.set(id, c);
      else {
        snap.cards.delete(id);
        p.stamps.delete(id);
      }
    };
    if (all) {
      const ids = new Set(this.reader.listCardIds(p.root));
      for (const id of snap.cards.keys()) if (!ids.has(id)) snap.cards.delete(id);
      for (const id of ids) read(id);
    } else for (const id of cards) read(id);
    if (conclusions) {
      p.stamps.set("", conclusionsStamp(p.root));
      snap.conclusions = this.reader.readConclusions(p.root);
    }
    snap.problems = problemsOf(p.root, snap.cards.values(), snap.conclusions);
    snap.readAt = Date.now();
    this.o.onChange(p.id, { cards: all || cards.size > 0, conclusions });
  }

  private close(p: Watched): void {
    p.gone = true;
    for (const w of Object.values(p.watchers)) w?.close();
    clearTimeout(p.timer);
    clearTimeout(p.retry);
    if (this.projects.get(p.id) === p) this.projects.delete(p.id);
  }
}
