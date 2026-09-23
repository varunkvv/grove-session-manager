import path from "node:path";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { err, ok, type Result } from "../types.ts";

/**
 * archiving is a decision a person made, not something the app worked out, so it lives beside
 * combos.json rather than in `.grove/` - that is a cache and the README says it can be deleted at
 * any time. the file is small, hand-editable, and read the same guarded way combos.json is:
 *
 * ```json
 * { "<sessionId>": { "at": 1758600000000 } }
 * ```
 *
 * keyed by session id and not by transcript path, because a path moves when Claude Code relocates
 * a transcript (`/cd`, a worktree it made) and one conversation can sit in more than one project
 * dir. someone archiving a session means the conversation, not the file.
 */
export interface ArchivedEntry {
  /** when it was archived. anything else in the entry is someone's own and is left alone. */
  at?: number;
}

export function archivedFilePath(appRoot: string): string {
  return path.join(appRoot, "archived.json");
}

export interface LoadedArchive {
  status: "ok" | "missing" | "invalid" | "unexpected-shape";
  /** the session ids that are archived */
  ids: Set<string>;
  message?: string;
}

/**
 * generous on read: an object entry is the shape we write, and a bare `true` is what someone
 * hand-editing the file is most likely to type. anything else is not archived - and is still kept
 * when we write, see setArchived.
 */
function isArchived(value: unknown): boolean {
  return value === true || isObject(value);
}

/** loading never writes. a file we cannot make sense of means "nothing is archived", not "rewrite it". */
export async function loadArchived(appRoot: string): Promise<LoadedArchive> {
  const read = await readJsonGuarded(archivedFilePath(appRoot));
  if (read.status === "missing") return { status: "missing", ids: new Set() };
  if (read.status === "invalid") {
    return { status: "invalid", ids: new Set(), message: read.message };
  }
  if (!isObject(read.value)) {
    return {
      status: "unexpected-shape",
      ids: new Set(),
      message: `expected { "<sessionId>": { "at": … } }`,
    };
  }
  const ids = new Set<string>();
  for (const [id, value] of Object.entries(read.value)) if (isArchived(value)) ids.add(id);
  return { status: "ok", ids };
}

/**
 * read-modify-write, like combos.json. entries we do not understand, extra fields on entries we
 * do, and the file's indentation all survive. a file that is not valid JSON is never overwritten:
 * someone is mid-edit, and losing their archive is worse than not archiving one more session.
 */
export async function setArchived(
  appRoot: string,
  sessionIds: readonly string[],
  archived: boolean,
  now: number = Date.now(),
): Promise<Result<Set<string>>> {
  const file = archivedFilePath(appRoot);
  const read = await readJsonGuarded(file);
  if (read.status === "invalid") {
    return err(
      "invalid-json",
      `archived.json is not valid JSON and was left untouched: ${read.message}`,
    );
  }
  if (read.status === "ok" && !isObject(read.value)) {
    return err(
      "unexpected-shape",
      `archived.json is not an object of session ids, so it was left untouched.`,
    );
  }
  const raw: Record<string, unknown> =
    read.status === "ok" ? { ...(read.value as Record<string, unknown>) } : {};
  for (const id of sessionIds) {
    if (!id) continue;
    if (!archived) delete raw[id];
    // already archived: leave the entry exactly as it is, so `at` still says when it happened
    else if (!isArchived(raw[id])) raw[id] = { at: now } satisfies ArchivedEntry;
  }
  await writeFileAtomic(file, stringifyLike(raw, read.status === "ok" ? read.text : undefined));
  const ids = new Set<string>();
  for (const [id, value] of Object.entries(raw)) if (isArchived(value)) ids.add(id);
  return ok(ids);
}
