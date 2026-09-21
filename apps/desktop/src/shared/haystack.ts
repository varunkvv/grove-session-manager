// what a row can be found by without reading its transcript. shared so the renderer's instant filter
// and the main process's full-text search agree on what a match is.
import { modelLabel } from "@grove/core/pure";
import type { SessionRow } from "./ipc.ts";

const haystacks = new WeakMap<SessionRow, string>();

export function rowHaystack(r: SessionRow): string {
  let h = haystacks.get(r);
  if (h === undefined) {
    h = [
      r.title,
      r.firstPrompt,
      r.lastPrompt,
      r.comboName,
      r.gitBranch,
      r.cwdBase,
      r.tag,
      r.prNumber ? `#${r.prNumber} ${r.prRepo ?? ""}` : undefined,
      r.sessionId,
      ...(r.usage ?? []).map((u) => modelLabel(u.model)),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    haystacks.set(r, h);
  }
  return h;
}
