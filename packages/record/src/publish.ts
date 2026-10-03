// the one rule that makes many writers safe with no lock and no server:
//
//   a record is written in full to a hidden temp file, then given its real name with link(2).
//   link is atomic and fails with EEXIST when the name is taken. so a name is either absent or
//   complete, exactly one writer gets it, and nothing is ever rewritten or deleted.
//
// every fs call goes through the default `fs` object on purpose: the race harness swaps
// fs.linkSync for a broken primitive to prove the tests catch it (test/broken.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpSeq = 0;
const HOST = os.hostname().split(".")[0] || "unknown";

export function hostName(): string {
  return HOST;
}

/** highest N among entries of `dir` that match `re` (group 1 is the number) and pass `counts`. 0 when none. */
export function highest(dir: string, re: RegExp, counts?: (name: string) => boolean): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return 0;
    throw e;
  }
  const nums: [number, string][] = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) nums.push([Number(m[1]), name]);
  }
  if (!counts) return nums.reduce((max, [n]) => (n > max ? n : max), 0);
  // from the top down, so the usual case is one check
  nums.sort((a, b) => b[0] - a[0]);
  for (const [n, name] of nums) if (counts(name)) return n;
  return 0;
}

export interface Published {
  n: number;
  file: string;
  attempts: number;
}

/**
 * allocate the next number and publish the record under it, in one atomic step.
 *   next()        the number to try: highest existing + 1. called again after every lost race
 *   finalFor(n)   the record's real path. its directory is created if missing
 *   contentFor(n) the whole file
 *   tmpDir        where the temp file goes. must be on the same filesystem as the final path
 * the directory of the final path carries no meaning. only the linked file does.
 */
export function publishNext(
  tmpDir: string,
  next: () => number,
  finalFor: (n: number) => string,
  contentFor: (n: number) => string,
): Published {
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `.tmp.${HOST}.${process.pid}.${tmpSeq++}`);
  try {
    for (let attempts = 1; attempts <= 500; attempts++) {
      const n = next();
      const file = finalFor(n);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch (e) {
        // a plain file stands where a card folder goes (a hand edit, or one made a moment ago). look again
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTDIR") continue;
        throw e;
      }
      fs.writeFileSync(tmp, contentFor(n));
      try {
        fs.linkSync(tmp, file);
        return { n, file, attempts };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue; // someone else got that number. look again
        throw new Error(
          `cannot create ${file} (${code}). the name is free, so this is permissions, disk space or a filesystem without hard links`,
        );
      }
    }
    throw new Error("gave up after 500 attempts to get the next number");
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to remove
    }
  }
}

/** publish at exactly this path or report that it is taken. used for claim events, where a lost race means "decide again". */
export function publishAt(file: string, content: string): boolean {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp.${HOST}.${process.pid}.${tmpSeq++}`);
  try {
    fs.writeFileSync(tmp, content);
    try {
      fs.linkSync(tmp, file);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      throw new Error(
        `cannot create ${file} (${code}). the name is free, so this is permissions, disk space or a filesystem without hard links`,
      );
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to remove
    }
  }
}

/** one line, one write(2), O_APPEND. lines stay under 1,000 bytes so appends from many processes cannot interleave. */
export function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

/** remove temp files a killed writer left behind. only ones older than `olderThanMs`, so a live writer's file is never touched. */
export function sweepTemps(dirs: string[], olderThanMs = 3_600_000): number {
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(".tmp.")) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        // gone already
      }
    }
  }
  return removed;
}
