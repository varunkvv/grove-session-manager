// the New and Edit project form's words and rules. pure: the form keeps the state, main validates.
import {
  type BranchSpec,
  comboDirSlug,
  derivePrefix,
  type FolderMode,
  shortPath,
  validateBranchName,
} from "@grove/core/pure";
import type { FolderView, PathInfoView, ProjectDraft } from "../../shared/ipc.ts";

export type BranchKind = "detach" | "new" | "existing";

/** one row of the Repos list */
export interface Repo {
  path: string;
  /** inspectPath's answer. absent until it comes */
  info?: PathInfoView;
  mode: FolderMode;
  branchKind: BranchKind;
  newBranch: string;
  existingBranch: string;
  /** the folder name inside the project, when not the repo's own */
  as: string;
  /** in the project when the screen opened: its mode and branch are fixed */
  locked: boolean;
}

export interface Form {
  name: string;
  goal: string;
  repos: Repo[];
  /** new only, and only once main reported a prefix problem */
  prefix?: string;
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** a repo that was in the project when Edit project opened */
export function repoOf(f: FolderView): Repo {
  return {
    path: f.path,
    mode: f.mode,
    branchKind: f.branchSpec?.kind ?? "detach",
    newBranch: f.branchSpec?.kind === "new" ? f.branchSpec.name : "",
    existingBranch: f.branchSpec?.kind === "existing" ? f.branchSpec.name : "",
    as: f.mode === "worktree" && f.dirName !== baseName(f.path) ? f.dirName : "",
    locked: true,
  };
}

/** a working copy unless it cannot be one */
export function defaultMode(info: PathInfoView): FolderMode {
  return info.exists && info.canBeWorktree ? "worktree" : "reference";
}

export function draftOf(form: Form): ProjectDraft {
  return {
    name: form.name.trim(),
    note: form.goal.trim() || undefined,
    ...(form.prefix ? { prefix: form.prefix } : {}),
    folders: form.repos.map((r) => {
      if (r.mode === "reference") return { path: r.path, mode: "reference" };
      const branch: BranchSpec =
        r.branchKind === "new"
          ? { kind: "new", name: r.newBranch.trim() }
          : r.branchKind === "existing"
            ? { kind: "existing", name: r.existingBranch }
            : { kind: "detach" };
      return {
        path: r.path,
        mode: "worktree",
        branch,
        ...(r.as.trim() ? { as: r.as.trim() } : {}),
      };
    }),
  };
}

/** the trimmed name, the trimmed goal, or a repo's path, mode, branch or folder name */
export function changed(initial: Form, form: Form): boolean {
  return JSON.stringify(draftOf(initial)) !== JSON.stringify(draftOf(form));
}

const branchInvalid = (r: Repo) =>
  r.mode === "worktree" &&
  r.branchKind === "new" &&
  validateBranchName(r.newBranch.trim()) !== null;

export function canSubmit(i: {
  mode: "new" | "edit";
  form: Form;
  /** edit: the form as the screen opened */
  initial?: Form;
  nameProblem?: string;
  prefixProblem?: string;
  running: boolean;
}): boolean {
  const { form } = i;
  if (i.running || !form.name.trim() || i.nameProblem) return false;
  // a project that already has no repos can still be renamed or given a goal. a new one needs one
  const none = form.repos.length === 0 && !(i.mode === "edit" && i.initial?.repos.length === 0);
  if (none || form.repos.some((r) => !r.info || branchInvalid(r))) return false;
  if (i.mode === "edit") return !i.initial || changed(i.initial, form);
  return !i.prefixProblem;
}

/** the line under Name: what the name becomes, or main's problem with it */
export function nameHint(i: {
  mode: "new" | "edit";
  name: string;
  /** something was typed: an empty name is a problem only after that */
  touched: boolean;
  problem?: string;
  /** main's derived prefix (empty until it answers), or the project's on edit */
  prefix: string;
  appRoot: string;
  home: string;
  /** edit: the project folder */
  root?: string;
}): { text: string; problem: boolean } {
  if (i.problem) return { text: i.problem, problem: true };
  const empty = !i.name.trim();
  if (empty && i.touched) return { text: "Give the project a name.", problem: true };
  if (i.mode === "edit")
    return {
      text: `The folder stays at ${shortPath(i.root ?? "", undefined, i.home)}. Only the name changes, and cards keep the ${i.prefix} prefix.`,
      problem: false,
    };
  if (empty) return { text: "The folder and card prefix come from the name.", problem: false };
  // main's answer can lag the keystroke. its rule without the clash check fills the gap
  const prefix = i.prefix || derivePrefix(i.name);
  return {
    text: `Folder ${shortPath(i.appRoot, undefined, i.home)}/${comboDirSlug(i.name)} · cards will be ${prefix}-1, ${prefix}-2…`,
    problem: false,
  };
}

const DRIFT: Partial<Record<FolderView["state"], (f: FolderView) => string>> = {
  stale: () =>
    "Folder was deleted. Git still lists this working copy, but the directory is gone. Repair working copies (⌘K) recreates it.",
  foreign: () =>
    "Something else is here. This folder is not a working copy of the original repo and was left untouched. Move or rename it, then repair working copies (⌘K).",
  "missing-origin": (f) =>
    `Original repo not found. ${f.path} is missing or is no longer a git repository.`,
};

/** a locked working copy's drift, in today's words. `absent` is not drift: opening creates it */
export function driftNote(f: FolderView): string | null {
  return DRIFT[f.state]?.(f) ?? null;
}

/** the note under a repo row, first that applies */
export function repoNote(i: {
  info?: PathInfoView;
  /** edit: the project's view of a locked working copy */
  folder?: FolderView;
}): { text: string; tone: string } | null {
  if (i.info && !i.info.exists)
    return { text: "This folder no longer exists.", tone: "text-danger" };
  if (i.info && !i.info.isGitRepo)
    return { text: "Not a git repository, so it can only be a reference.", tone: "text-fg-4" };
  if (i.info && !i.info.canBeWorktree)
    return {
      text: "Not the top level of a repository, so it can only be a reference.",
      tone: "text-fg-4",
    };
  const drift = i.folder && driftNote(i.folder);
  if (drift) return { text: drift, tone: "text-danger" };
  return null;
}
