import path from "node:path";
import { loadMarks, renameMarkPrefixes, setMarks } from "@grove/core";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

/**
 * what the person dismissed, as `<project id>/<key>`. the file behind it is a decision record
 * people may edit by hand, so this only ever holds what was read back from it - never what we
 * hoped to write.
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

  /**
   * a broken file means "nothing is dismissed" until someone fixes it, never a rewrite.
   * `renames` is the one-time move of 0.10's marks, each card prefix to its project's id
   */
  async load(renames?: ReadonlyMap<string, string>): Promise<void> {
    if (renames?.size) {
      const moved = await renameMarkPrefixes(this.file, renames).catch((e) => {
        log.warn("reviewed.json:", e);
        return 0;
      });
      if (moved) log.info(`reviewed.json: moved ${moved} marks from card prefixes to project ids`);
    }
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
