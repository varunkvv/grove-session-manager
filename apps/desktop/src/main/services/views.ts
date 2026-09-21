// combo state -> what the renderer draws. pure: no electron, no fs.
import path from "node:path";
import {
  type Combo,
  type ComboFolder,
  type FolderOutcome,
  type FolderStatus,
  longWorkMode,
  type TeardownOutcome,
} from "@grove/core";
import type { ComboView, FolderView, ToastMessage } from "../../shared/ipc.ts";

export type Busy = NonNullable<FolderView["busy"]>;

/** what main remembers about a combo between reconciles. keyed by root, which never changes. */
export interface ComboRuntime {
  statuses: Map<string, FolderStatus>;
  busy: Map<string, Busy>;
  /** the first reconcile has landed. until then nothing is claimed about the folders. */
  reconciled: boolean;
  /** a check the person asked for is in flight */
  checking: boolean;
  checkedAt?: number;
}

export function emptyRuntime(): ComboRuntime {
  return { statuses: new Map(), busy: new Map(), reconciled: false, checking: false };
}

/** a repo can be in a combo twice (two branches, two `as` names), so the path alone is not an identity */
export function folderKey(f: Pick<ComboFolder, "path" | "mode" | "as">): string {
  return `${f.mode}\n${f.path}\n${f.as ?? ""}`;
}

export function dirNameOf(f: Pick<ComboFolder, "path" | "as">): string {
  return f.as ?? path.basename(f.path);
}

const HEADS = "refs/heads/";

export function branchLabelOf(
  s: Pick<FolderStatus, "branch" | "detached" | "head">,
): string | undefined {
  if (s.detached) return s.head ? `detached @${s.head.slice(0, 7)}` : "detached";
  if (!s.branch) return undefined;
  return s.branch.startsWith(HEADS) ? s.branch.slice(HEADS.length) : s.branch;
}

export function buildFolderView(
  folder: ComboFolder,
  status: FolderStatus | undefined,
  busy: Busy | undefined,
): FolderView {
  const view: FolderView = {
    path: folder.path,
    mode: folder.mode,
    dirName: dirNameOf(folder),
    state: status?.state ?? "unknown",
  };
  if (folder.branch) view.branchSpec = folder.branch;
  if (status) {
    const label = branchLabelOf(status);
    if (label) view.branchLabel = label;
    if (status.locked !== undefined) view.locked = status.locked;
    if (status.dirty !== undefined) view.dirty = status.dirty;
    if (status.message) view.message = status.message;
  }
  if (busy) view.busy = busy;
  return view;
}

export function comboStatusOf(runtime: ComboRuntime | undefined): ComboView["status"] {
  if (runtime?.checking) return "checking";
  return runtime?.reconciled ? "known" : "unknown";
}

export function buildFolderViews(combo: Combo, runtime: ComboRuntime | undefined): FolderView[] {
  return combo.folders.map((f) => {
    const key = folderKey(f);
    return buildFolderView(f, runtime?.statuses.get(key), runtime?.busy.get(key));
  });
}

export function buildComboView(
  combo: Combo,
  runtime: ComboRuntime | undefined,
  workspaceFile: string,
): ComboView {
  const view: ComboView = {
    name: combo.name,
    root: combo.root,
    workspaceFile,
    longWork: longWorkMode(combo),
    folders: buildFolderViews(combo, runtime),
    status: comboStatusOf(runtime),
  };
  if (combo.note) view.note = combo.note;
  if (runtime?.checkedAt !== undefined) view.checkedAt = runtime.checkedAt;
  return view;
}

/**
 * a reconcile without dirty checks knows nothing about uncommitted work. when nothing else
 * about the worktree moved, the last answer stays instead of blinking off on every focus.
 */
export function mergeStatus(prev: FolderStatus | undefined, next: FolderStatus): FolderStatus {
  if (next.dirty !== undefined || prev?.dirty === undefined) return next;
  const same = prev.state === next.state && prev.branch === next.branch && prev.head === next.head;
  return same ? { ...next, dirty: prev.dirty } : next;
}

/** the row a finished git command implies, before the reconcile that follows it lands */
export function statusFromOutcome(
  prev: FolderStatus | undefined,
  outcome: FolderOutcome,
): FolderStatus {
  const base: FolderStatus = {
    folder: outcome.folder,
    target: outcome.target,
    state: outcome.state,
  };
  if (outcome.message) base.message = outcome.message;
  if (outcome.state !== "ok") return base;
  if (prev?.state === "ok") return { ...prev, ...base };
  const spec = outcome.folder.branch;
  if (!spec || spec.kind === "detach") return { ...base, detached: true };
  return { ...base, branch: spec.name, detached: false };
}

export type OutcomeContext = "create" | "update" | "open" | "ensure" | "repair";

const REST: Record<OutcomeContext, string> = {
  create: " The rest of the combo was created.",
  update: " The rest of the combo was updated.",
  open: " The combo opened without it.",
  ensure: "",
  repair: "",
};

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cased = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

/** failures that core reports instead of throwing. anything else is not worth interrupting for. */
export function outcomeToast(outcome: FolderOutcome, context: OutcomeContext): ToastMessage | null {
  const dir = dirNameOf(outcome.folder);
  const detail = outcome.git?.stderr || undefined;
  const spec = outcome.folder.branch;
  const branch = spec && spec.kind !== "detach" ? spec.name : undefined;
  const toast = (title: string, body: string): ToastMessage => ({
    level: "error",
    title,
    body: `${body}${REST[context]}`,
    ...(detail ? { detail } : {}),
  });
  switch (outcome.action) {
    case "collision":
      return toast(
        branch
          ? `${dir}: branch "${branch}" is already checked out`
          : `${dir}: the branch is already checked out`,
        outcome.heldBy ? `at ${outcome.heldBy}.` : sentence(outcome.message ?? ""),
      );
    case "invalid-branch":
      return toast(
        `${dir}: "${branch ?? ""}" is not a usable branch name`,
        sentence(outcome.message ?? ""),
      );
    case "refused-foreign":
      return toast(
        `${dir}: something else is already at that path`,
        `${sentence(outcome.message ?? "")} ${outcome.target} was left untouched.`.trim(),
      );
    case "missing-origin":
      return toast(
        `${dir}: the original folder is missing`,
        sentence(outcome.message ?? `${outcome.folder.path} does not exist`),
      );
    case "failed":
      return toast(
        `${dir}: git could not create the worktree`,
        sentence(outcome.message ?? "git failed"),
      );
    default:
      return null;
  }
}

export function isRemaining(outcome: TeardownOutcome): boolean {
  return (
    outcome.action === "skipped-dirty" ||
    outcome.action === "skipped-locked" ||
    outcome.action === "failed"
  );
}

/** a folder the person removed from the combo whose worktree git would not give up */
export function keptFolderToast(outcome: TeardownOutcome): ToastMessage {
  const dir = dirNameOf(outcome.folder);
  let body: string;
  if (outcome.action === "skipped-dirty") {
    const some = outcome.dirtyPaths?.slice(0, 3).join(", ");
    body = `It has uncommitted changes${some ? ` (${some})` : ""}. Commit or discard them, then remove it again.`;
  } else if (outcome.action === "skipped-locked") {
    body = "The worktree is locked. Unlock it with `git worktree unlock`, then remove it again.";
  } else {
    body = sentence(outcome.message ?? "git could not remove the worktree");
  }
  return {
    level: "error",
    title: `${dir}: kept in the combo`,
    body,
    ...(outcome.git?.stderr ? { detail: outcome.git.stderr } : {}),
  };
}
