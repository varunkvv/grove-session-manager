import path from "node:path";
import { isObject } from "../fsx.ts";
import { expandHome } from "../paths.ts";
import { comboDirSlug } from "../slug.ts";
import type { BranchSpec, Combo, ComboFolder } from "../types.ts";

export interface ComboProblem {
  combo?: string;
  message: string;
}

/** where a folder lives on disk: the worktree dir under the root, or the reference itself */
export function targetDirFor(combo: Combo, folder: ComboFolder): string {
  if (folder.mode === "reference") return folder.path;
  return path.join(combo.root, folder.as ?? path.basename(folder.path));
}

function normalizeBranch(raw: unknown): BranchSpec | string {
  if (raw === undefined || raw === null) return { kind: "detach" };
  if (!isObject(raw)) return "branch must be an object";
  if (raw.kind === "detach") return { kind: "detach" };
  if (raw.kind === "new" || raw.kind === "existing") {
    if (typeof raw.name !== "string" || !raw.name.trim())
      return `branch.kind "${raw.kind}" needs a name`;
    const spec: BranchSpec =
      raw.kind === "new"
        ? {
            kind: "new",
            name: raw.name.trim(),
            ...(typeof raw.base === "string" ? { base: raw.base } : {}),
          }
        : { kind: "existing", name: raw.name.trim() };
    return spec;
  }
  return `unknown branch.kind ${JSON.stringify(raw.kind)}`;
}

function normalizeFolder(raw: unknown, home?: string): ComboFolder | string {
  // older files list folders as plain strings. those were always references.
  if (typeof raw === "string")
    return { path: path.resolve(expandHome(raw, home)), mode: "reference" };
  if (!isObject(raw)) return "folder must be a string or an object";
  if (typeof raw.path !== "string" || !raw.path.trim()) return "folder needs a path";
  const mode = raw.mode === "worktree" ? "worktree" : "reference";
  const folder: ComboFolder = { ...raw, path: path.resolve(expandHome(raw.path, home)), mode };
  if (mode === "worktree") {
    const branch = normalizeBranch(raw.branch);
    if (typeof branch === "string") return branch;
    folder.branch = branch;
  } else {
    delete folder.branch;
  }
  if (raw.as !== undefined && typeof raw.as !== "string") return "`as` must be a string";
  return folder;
}

/** never throws and never writes. a broken combo is reported and skipped, the rest still load. */
export function normalizeCombosFile(
  raw: unknown,
  appRoot: string,
  home?: string,
): { combos: Combo[]; problems: ComboProblem[]; rejected: unknown[] } {
  const problems: ComboProblem[] = [];
  const combos: Combo[] = [];
  // raw entries we could not load. kept so a save never drops something a person wrote by hand.
  const rejected: unknown[] = [];
  if (!isObject(raw) || !Array.isArray(raw.combos)) {
    if (raw !== undefined) problems.push({ message: 'expected { "combos": [...] }' });
    return { combos, problems, rejected };
  }
  for (const item of raw.combos) {
    if (!isObject(item) || typeof item.name !== "string" || !item.name.trim()) {
      problems.push({ message: "a combo needs a name" });
      rejected.push(item);
      continue;
    }
    const name = item.name.trim();
    const root =
      typeof item.root === "string" && item.root.trim()
        ? path.resolve(expandHome(item.root, home))
        : path.join(appRoot, comboDirSlug(name));
    const folders: ComboFolder[] = [];
    let bad: string | undefined;
    for (const f of Array.isArray(item.folders) ? item.folders : []) {
      const folder = normalizeFolder(f, home);
      if (typeof folder === "string") {
        bad = folder;
        break;
      }
      folders.push(folder);
    }
    if (bad) {
      problems.push({ combo: name, message: bad });
      rejected.push(item);
      continue;
    }
    if (combos.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      problems.push({ combo: name, message: "duplicate combo name" });
      rejected.push(item);
      continue;
    }
    const combo: Combo = { ...item, name, root, folders };
    // anything but the two known values falls back to the default instead of failing the combo
    if (item.longWork === "background" || item.longWork === "foreground")
      combo.longWork = item.longWork;
    else delete combo.longWork;
    combos.push(combo);
  }
  return { combos, problems, rejected };
}
