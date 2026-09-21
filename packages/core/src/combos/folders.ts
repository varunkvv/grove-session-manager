import type { Combo } from "../types.ts";

/**
 * the roots of the generated workspace. the combo root comes first because the Claude Code
 * extension uses workspaceFolders[0] as the working directory. worktrees are children of the
 * root, so listing them as roots too would show them twice in the explorer.
 */
export function workspaceFolders(combo: Combo): string[] {
  return [combo.root, ...combo.folders.filter((f) => f.mode === "reference").map((f) => f.path)];
}

export function referencePaths(combo: Combo): string[] {
  return [...new Set(combo.folders.filter((f) => f.mode === "reference").map((f) => f.path))];
}

/**
 * folders every combo root gets next to its working copies. sessions in a combo do not share a
 * conversation (forks, background agents, other tabs), so what they have in common lives here.
 */
export const COMBO_SHARED_DIRS = ["plans", "artifacts", "context"] as const;

/** names a working copy may not take, because the combo itself uses them. lowercase. */
export const COMBO_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "claude.md",
  ".claude",
  ".git",
  ...COMBO_SHARED_DIRS,
]);
