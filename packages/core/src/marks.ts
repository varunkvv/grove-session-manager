import path from "node:path";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "./fsx.ts";
import { err, ok, type Result } from "./types.ts";

/**
 * a set of keys a person marked: what they reviewed (`reviewed.json`). a decision a person made,
 * not something the app worked out, so it lives beside combos.json rather than in `.grove/` - that
 * is a cache and the README says it can be deleted at any time. the file is small, hand-editable,
 * and read the same guarded way combos.json is:
 *
 * ```json
 * { "<key>": { "at": 1758600000000 } }
 * ```
 */
export interface MarkEntry {
  /** when it was marked. anything else in the entry is someone's own and is left alone. */
  at?: number;
}

export interface LoadedMarks {
  status: "ok" | "missing" | "invalid" | "unexpected-shape";
  /** the keys that are marked */
  keys: Set<string>;
  message?: string;
}

/**
 * generous on read: an object entry is the shape we write, and a bare `true` is what someone
 * hand-editing the file is most likely to type. anything else is not marked - and is still kept
 * when we write, see setMarks.
 */
function isMarked(value: unknown): boolean {
  return value === true || isObject(value);
}

/** loading never writes. a file we cannot make sense of means "nothing is marked", not "rewrite it". */
export async function loadMarks(file: string): Promise<LoadedMarks> {
  const read = await readJsonGuarded(file);
  if (read.status === "missing") return { status: "missing", keys: new Set() };
  if (read.status === "invalid") {
    return { status: "invalid", keys: new Set(), message: read.message };
  }
  if (!isObject(read.value)) {
    return {
      status: "unexpected-shape",
      keys: new Set(),
      message: `expected { "<key>": { "at": … } }`,
    };
  }
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(read.value)) if (isMarked(value)) keys.add(key);
  return { status: "ok", keys };
}

/**
 * read-modify-write, like combos.json. entries we do not understand, extra fields on entries we
 * do, and the file's indentation all survive. a file that is not valid JSON is never overwritten:
 * someone is mid-edit, and losing their marks is worse than not marking one more thing.
 */
export async function setMarks(
  file: string,
  keys: readonly string[],
  marked: boolean,
  now: number = Date.now(),
): Promise<Result<Set<string>>> {
  const name = path.basename(file);
  const read = await readJsonGuarded(file);
  if (read.status === "invalid") {
    return err("invalid-json", `${name} is not valid JSON and was left untouched: ${read.message}`);
  }
  if (read.status === "ok" && !isObject(read.value)) {
    return err("unexpected-shape", `${name} is not an object of keys, so it was left untouched.`);
  }
  const raw: Record<string, unknown> =
    read.status === "ok" ? { ...(read.value as Record<string, unknown>) } : {};
  for (const key of keys) {
    if (!key) continue;
    if (!marked) delete raw[key];
    // already marked: leave the entry exactly as it is, so `at` still says when it happened
    else if (!isMarked(raw[key])) raw[key] = { at: now } satisfies MarkEntry;
  }
  await writeFileAtomic(file, stringifyLike(raw, read.status === "ok" ? read.text : undefined));
  const out = new Set<string>();
  for (const [key, value] of Object.entries(raw)) if (isMarked(value)) out.add(key);
  return ok(out);
}
