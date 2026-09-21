// a ComboDraft is the one place the renderer hands main a path. nothing in it is believed
// until it has been checked here.
import { stat } from "node:fs/promises";
import path from "node:path";
import { type BranchSpec, type ComboFolder, isObject, validateBranchName } from "@grove/core";

export interface CleanDraft {
  name: string;
  note?: string;
  folders: ComboFolder[];
}

function cleanBranch(raw: unknown, where: string, problems: string[]): BranchSpec {
  if (raw === undefined || raw === null) return { kind: "detach" };
  if (!isObject(raw)) {
    problems.push(`${where}: the branch is not valid.`);
    return { kind: "detach" };
  }
  if (raw.kind === "detach") return { kind: "detach" };
  if (raw.kind !== "new" && raw.kind !== "existing") {
    problems.push(`${where}: unknown branch kind.`);
    return { kind: "detach" };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const bad = validateBranchName(name);
  if (bad) problems.push(`${where}: ${bad}.`);
  if (raw.kind === "existing") return { kind: "existing", name };
  const base = typeof raw.base === "string" ? raw.base.trim() : "";
  if (base.startsWith("-")) problems.push(`${where}: a base cannot start with "-".`);
  return base ? { kind: "new", name, base } : { kind: "new", name };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** shape, absolute paths, and that every folder exists. the combo-level rules live in core. */
export async function parseDraft(
  raw: unknown,
): Promise<{ draft: CleanDraft | null; problems: string[] }> {
  const problems: string[] = [];
  if (!isObject(raw) || typeof raw.name !== "string" || !Array.isArray(raw.folders)) {
    return { draft: null, problems: ["The combo could not be read."] };
  }
  const folders: ComboFolder[] = [];
  for (const item of raw.folders as unknown[]) {
    if (!isObject(item) || typeof item.path !== "string" || !item.path.trim()) {
      problems.push("A folder has no path.");
      continue;
    }
    const given = item.path.trim();
    if (!path.isAbsolute(given)) {
      problems.push(`${given} is not an absolute path.`);
      continue;
    }
    const abs = path.resolve(given);
    if (!(await isDirectory(abs))) {
      problems.push(`${abs} does not exist or is not a folder.`);
      continue;
    }
    const mode = item.mode === "worktree" ? "worktree" : "reference";
    const folder: ComboFolder = { path: abs, mode };
    if (mode === "worktree") {
      folder.branch = cleanBranch(item.branch, path.basename(abs), problems);
      if (typeof item.as === "string" && item.as.trim()) folder.as = item.as.trim();
    }
    folders.push(folder);
  }
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
  return {
    draft: { name: raw.name.trim(), ...(note ? { note } : {}), folders },
    problems,
  };
}
