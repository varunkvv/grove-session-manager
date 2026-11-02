import path from "node:path";
import type { ConversationState, IndexedFile } from "@grove/core/pure";

/** a file a session's tool call read or edited, and when */
export interface FileTouch {
  path: string;
  at: number;
  edited: boolean;
}

/**
 * the session's files: each path it touched (latest touch, and whether any touch edited it), plus
 * every file git tracks in its folders. one entry per path, sorted by path.
 */
export async function buildFileIndex(input: {
  touches: FileTouch[];
  folders: string[];
  listTracked: (folder: string) => Promise<string[]>;
}): Promise<IndexedFile[]> {
  const files = new Map<string, IndexedFile>();
  for (const t of input.touches) {
    const prev = files.get(t.path);
    files.set(t.path, {
      path: t.path,
      touchedAt: Math.max(prev?.touchedAt ?? t.at, t.at),
      edited: prev?.edited === true || t.edited,
    });
  }
  const tracked = await Promise.all(
    input.folders.map(async (folder) => ({ folder, rels: await input.listTracked(folder) })),
  );
  for (const { folder, rels } of tracked) {
    for (const rel of rels) {
      const p = path.join(folder, rel);
      if (!files.has(p)) files.set(p, { path: p });
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * the files a session's transcript read or edited, from the fold's tool steps. the fold sets a
 * step's path only for Read, Write, Edit, MultiEdit and NotebookEdit, and only as the call named it:
 * a relative path is dropped.
 */
export function touchesOf(state: ConversationState): FileTouch[] {
  const out: FileTouch[] = [];
  for (const item of state.items) {
    if (item.kind !== "turn") continue;
    for (const s of item.work.steps) {
      // a failed edit did not touch the file
      if (s.kind !== "tool" || !s.path || !path.isAbsolute(s.path) || s.isError) continue;
      out.push({ path: s.path, at: s.at, edited: s.name !== "Read" });
    }
  }
  return out;
}
