import path from "node:path";
import { loadMarks, setMarks } from "@grove/core";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

/**
 * what the person reviewed, as `<PREFIX>/<key>`. the file behind it is a decision record people
 * may edit by hand, so this only ever holds what was read back from it - never what we hoped to
 * write.
 */
export class ReviewedService {
  private readonly file: string;
  private marks: ReadonlySet<string> = new Set();

  /** beside combos.json: a review is the person's decision, and `.grove` is a cache */
  constructor(appRoot: string) {
    this.file = path.join(appRoot, "reviewed.json");
  }

  /** the marks under `<prefix>/`, with it taken off */
  keys(prefix: string): ReadonlySet<string> {
    const head = `${prefix}/`;
    return new Set(
      [...this.marks].filter((k) => k.startsWith(head)).map((k) => k.slice(head.length)),
    );
  }

  /** a broken file means "nothing is reviewed" until someone fixes it, never a rewrite */
  async load(): Promise<void> {
    const loaded = await loadMarks(this.file);
    if (loaded.message) log.warn("reviewed.json:", loaded.message);
    this.marks = loaded.keys;
  }

  async set(keys: readonly string[], marked: boolean): Promise<void> {
    const res = await setMarks(this.file, keys, marked);
    if (!res.ok) throw new AppError(res.error.code, res.error.message);
    this.marks = res.value;
  }
}
