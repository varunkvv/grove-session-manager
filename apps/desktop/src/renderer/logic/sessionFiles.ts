import type { IndexedFile } from "@grove/core/pure";
import type { ChatChange } from "../../shared/ipc.ts";

/** a file in a session's list: when a tool call last touched it, and what changed in it since the last commit */
export interface SessionFile {
  path: string;
  touchedAt?: number;
  added?: number;
  removed?: number;
  /** a file git has never seen */
  fresh?: boolean;
}

/**
 * the session's files, for its list: `edited` (a tool call edited it, or it has changes not
 * committed) and `read`. a file no tool call touched is left out: the index lists every tracked
 * file. each group is newest first; a change the transcript never touched comes last in `edited`.
 */
export function splitSessionFiles(
  files: readonly IndexedFile[],
  changes: readonly ChatChange[],
): { edited: SessionFile[]; read: SessionFile[] } {
  const changed = new Map(changes.map((c) => [c.path, c]));
  const touched = new Set<string>();
  const edited: SessionFile[] = [];
  const read: SessionFile[] = [];
  for (const f of files) {
    if (f.touchedAt === undefined) continue;
    touched.add(f.path);
    const c = changed.get(f.path);
    const row = withCounts({ path: f.path, touchedAt: f.touchedAt }, c);
    (f.edited || c ? edited : read).push(row);
  }
  for (const c of changes) {
    if (!touched.has(c.path)) edited.push(withCounts({ path: c.path }, c));
  }
  return { edited: edited.sort(newestFirst), read: read.sort(newestFirst) };
}

function withCounts(row: SessionFile, c: ChatChange | undefined): SessionFile {
  return {
    ...row,
    ...(c?.added !== undefined ? { added: c.added } : {}),
    ...(c?.removed !== undefined ? { removed: c.removed } : {}),
    ...(c?.fresh ? { fresh: true } : {}),
  };
}

/** newest touch first; a file never touched (a change alone) sorts after all of them */
function newestFirst(a: SessionFile, b: SessionFile): number {
  const diff = (b.touchedAt ?? 0) - (a.touchedAt ?? 0);
  if (diff !== 0) return diff;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
