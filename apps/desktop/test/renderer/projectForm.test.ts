import { describe, expect, it } from "vitest";
import {
  canSubmit,
  changed,
  defaultMode,
  draftOf,
  driftNote,
  type Form,
  nameHint,
  type Repo,
  repoNote,
  repoOf,
} from "../../src/renderer/logic/projectForm.ts";
import type { FolderView, PathInfoView } from "../../src/shared/ipc.ts";

const info = (partial: Partial<PathInfoView> = {}): PathInfoView => ({
  path: "/c/api",
  exists: true,
  isGitRepo: true,
  canBeWorktree: true,
  branches: [],
  suggestedDirName: "api",
  ...partial,
});

const repo = (partial: Partial<Repo> = {}): Repo => ({
  path: "/c/api",
  info: info(),
  mode: "worktree",
  branchKind: "detach",
  newBranch: "",
  existingBranch: "",
  as: "",
  locked: false,
  ...partial,
});

const folder = (partial: Partial<FolderView> = {}): FolderView => ({
  path: "/c/api",
  mode: "worktree",
  dirName: "api",
  state: "ok",
  ...partial,
});

const HOME = "/Users/me";
const base = { appRoot: "/Users/me/claude-ws", home: HOME };

describe("nameHint", () => {
  it("new, empty", () => {
    expect(nameHint({ ...base, mode: "new", name: "", touched: false, prefix: "" })).toEqual({
      text: "The folder and card prefix come from the name.",
      problem: false,
    });
  });
  it("new, typed", () => {
    expect(
      nameHint({ ...base, mode: "new", name: "Auth SSO", touched: true, prefix: "AUTH" }).text,
    ).toBe("Folder ~/claude-ws/auth-sso · cards will be AUTH-1, AUTH-2…");
  });
  it("new, typed before main answered: the derived prefix", () => {
    expect(
      nameHint({ ...base, mode: "new", name: "2026 launch", touched: true, prefix: "" }).text,
    ).toBe("Folder ~/claude-ws/2026-launch · cards will be LAUN-1, LAUN-2…");
  });
  it("edit", () => {
    expect(
      nameHint({
        ...base,
        mode: "edit",
        name: "auth",
        touched: true,
        prefix: "AUTH",
        root: "/Users/me/claude-ws/auth-sso",
      }),
    ).toEqual({
      text: "The folder stays at ~/claude-ws/auth-sso. Only the name changes, and cards keep the AUTH prefix.",
      problem: false,
    });
  });
  it("a name problem in place of the hint", () => {
    expect(
      nameHint({ ...base, mode: "new", name: "x", touched: true, prefix: "X", problem: "taken" }),
    ).toEqual({ text: "taken", problem: true });
  });
  it("a name typed and cleared", () => {
    for (const mode of ["new", "edit"] as const)
      expect(nameHint({ ...base, mode, name: " ", touched: true, prefix: "A" })).toEqual({
        text: "Give the project a name.",
        problem: true,
      });
  });
});

describe("defaultMode", () => {
  it("a working copy unless it cannot be one", () => {
    expect(defaultMode(info())).toBe("worktree");
    expect(defaultMode(info({ canBeWorktree: false }))).toBe("reference");
    expect(defaultMode(info({ isGitRepo: false, canBeWorktree: false }))).toBe("reference");
    expect(defaultMode(info({ exists: false }))).toBe("reference");
  });
});

describe("draftOf", () => {
  it("trims, drops an empty goal and builds each folder", () => {
    const form: Form = {
      name: " auth ",
      goal: "  ",
      repos: [
        repo({ path: "/c/web", mode: "reference" }),
        repo({ branchKind: "new", newBranch: " feat/sso ", as: " api2 " }),
        repo({ path: "/c/lib", branchKind: "existing", existingBranch: "main" }),
        repo({ path: "/c/cli" }),
      ],
    };
    expect(draftOf(form)).toEqual({
      name: "auth",
      note: undefined,
      folders: [
        { path: "/c/web", mode: "reference" },
        { path: "/c/api", mode: "worktree", branch: { kind: "new", name: "feat/sso" }, as: "api2" },
        { path: "/c/lib", mode: "worktree", branch: { kind: "existing", name: "main" } },
        { path: "/c/cli", mode: "worktree", branch: { kind: "detach" } },
      ],
    });
    expect(draftOf({ ...form, goal: " ship ", prefix: "AUT2" })).toMatchObject({
      note: "ship",
      prefix: "AUT2",
    });
  });
});

describe("changed", () => {
  const initial: Form = { name: "auth", goal: "ship", repos: [repoOf(folder())] };
  it("sees name, goal, mode, branch and as", () => {
    expect(changed(initial, { ...initial, name: " auth " })).toBe(false);
    expect(changed(initial, { ...initial, repos: [{ ...initial.repos[0]!, info: info() }] })).toBe(
      false,
    );
    expect(changed(initial, { ...initial, name: "auth2" })).toBe(true);
    expect(changed(initial, { ...initial, goal: "ship it" })).toBe(true);
    const r = initial.repos[0]!;
    expect(changed(initial, { ...initial, repos: [{ ...r, mode: "reference" }] })).toBe(true);
    expect(
      changed(initial, { ...initial, repos: [{ ...r, branchKind: "new", newBranch: "b" }] }),
    ).toBe(true);
    expect(changed(initial, { ...initial, repos: [{ ...r, as: "api2" }] })).toBe(true);
    expect(changed(initial, { ...initial, repos: [] })).toBe(true);
  });
});

describe("repoOf", () => {
  it("keeps the folder's branch and a folder name that is not the repo's own", () => {
    expect(
      repoOf(folder({ dirName: "api2", branchSpec: { kind: "new", name: "feat/x" } })),
    ).toMatchObject({ branchKind: "new", newBranch: "feat/x", as: "api2", locked: true });
    expect(repoOf(folder({ mode: "reference", dirName: "web" })).as).toBe("");
  });
});

describe("canSubmit", () => {
  const form: Form = { name: "auth", goal: "", repos: [repo()] };
  const ok = { mode: "new" as const, form, running: false };

  it("new: every rule", () => {
    expect(canSubmit(ok)).toBe(true);
    expect(canSubmit({ ...ok, form: { ...form, name: "  " } })).toBe(false);
    expect(canSubmit({ ...ok, nameProblem: "taken" })).toBe(false);
    expect(canSubmit({ ...ok, prefixProblem: "taken" })).toBe(false);
    expect(canSubmit({ ...ok, form: { ...form, repos: [] } })).toBe(false);
    expect(canSubmit({ ...ok, form: { ...form, repos: [repo({ info: undefined })] } })).toBe(false);
    const badBranch = repo({ branchKind: "new", newBranch: "a..b" });
    expect(canSubmit({ ...ok, form: { ...form, repos: [badBranch] } })).toBe(false);
    expect(
      canSubmit({ ...ok, form: { ...form, repos: [{ ...badBranch, mode: "reference" }] } }),
    ).toBe(true);
    expect(canSubmit({ ...ok, running: true })).toBe(false);
  });

  it("edit: something changed, and the same rules but the prefix", () => {
    const edit = { mode: "edit" as const, form, initial: form, running: false };
    expect(canSubmit(edit)).toBe(false);
    const renamed = { ...form, name: "auth2" };
    expect(canSubmit({ ...edit, form: renamed })).toBe(true);
    expect(canSubmit({ ...edit, form: renamed, prefixProblem: "ignored on edit" })).toBe(true);
    expect(canSubmit({ ...edit, form: { ...renamed, repos: [] } })).toBe(false);
    expect(canSubmit({ ...edit, form: renamed, nameProblem: "taken" })).toBe(false);
    expect(canSubmit({ ...edit, form: renamed, running: true })).toBe(false);
  });

  it("edit: a project that already has no repos can be given a goal", () => {
    const bare = { ...form, repos: [] };
    const edit = { mode: "edit" as const, form: bare, initial: bare, running: false };
    expect(canSubmit(edit)).toBe(false);
    expect(canSubmit({ ...edit, form: { ...bare, goal: "ship sso" } })).toBe(true);
    // a repo added to it is held to the same rules as any other
    const adding = { ...bare, goal: "ship sso", repos: [repo({ info: undefined })] };
    expect(canSubmit({ ...edit, form: adding })).toBe(false);
  });
});

describe("repoNote", () => {
  it("the first that applies", () => {
    const gone = { text: "This folder no longer exists.", tone: "text-danger" };
    expect(repoNote({ info: info({ exists: false, isGitRepo: false }) })).toEqual(gone);
    expect(repoNote({ info: info({ isGitRepo: false, canBeWorktree: false }) })).toEqual({
      text: "Not a git repository, so it can only be a reference.",
      tone: "text-fg-4",
    });
    expect(repoNote({ info: info({ canBeWorktree: false }) })?.text).toBe(
      "Not the top level of a repository, so it can only be a reference.",
    );
    expect(repoNote({ info: info(), folder: folder({ state: "stale" }) })).toEqual({
      text: driftNote(folder({ state: "stale" })),
      tone: "text-danger",
    });
    expect(repoNote({ info: info(), folder: folder() })).toBeNull();
    expect(repoNote({})).toBeNull();
  });
});

describe("driftNote", () => {
  it("each drift state in today's words", () => {
    expect(driftNote(folder({ state: "stale" }))).toBe(
      "Folder was deleted. Git still lists this working copy, but the directory is gone. Repair working copies (⌘K) recreates it.",
    );
    expect(driftNote(folder({ state: "foreign" }))).toBe(
      "Something else is here. This folder is not a working copy of the original repo and was left untouched. Move or rename it, then repair working copies (⌘K).",
    );
    expect(driftNote(folder({ state: "missing-origin", path: "/c/gone" }))).toBe(
      "Original repo not found. /c/gone is missing or is no longer a git repository.",
    );
  });
  it("none for absent and the states that are not drift", () => {
    for (const state of ["absent", "ok", "reference", "unknown"] as const)
      expect(driftNote(folder({ state }))).toBeNull();
  });
});
