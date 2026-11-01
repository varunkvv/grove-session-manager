import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Combo } from "../types.ts";
import { COMBO_SHARED_DIRS } from "./folders.ts";

export function branchLabel(f: Combo["folders"][number]): string {
  const b = f.branch;
  if (!b || b.kind === "detach") return "detached at HEAD";
  return b.kind === "new" ? `on branch \`${b.name}\`` : `on existing branch \`${b.name}\``;
}

/** what a session needs to make its own worktree per change. the old text in recordCleanup swaps to this */
export function worktreesBlock(root: string): string[] {
  return [
    "A reference is the person's own clone. Change code in a git worktree, never in the clone. Give each independent task its own, inside this folder:",
    "",
    `    git -C <reference> worktree add ${root}/worktrees/<repo>-<task> -b <branch>`,
    "",
    "- a question, a review or an investigation needs no worktree. a change does",
    "- a worktree shares the clone's `.git`: commits and branches show up in both straight away, uncommitted work does not",
    "- a branch can be checked out in one worktree at a time. when `git checkout <branch>` refuses, that is why",
    "- once its branch is merged, remove it with `git -C <reference> worktree remove <dir>`. never one with uncommitted work, never with `rm -rf`",
    "- a working copy listed above is Grove's: leave it where it is",
  ];
}

export function referenceMemberLine(f: Combo["folders"][number]): string {
  return `- \`${f.path}\` - reference. your own clone: read it and make worktrees from it, never edit it directly.`;
}

/**
 * every session started in the combo root loads this file, forks and background agents included.
 * so it carries the three things none of them can work out alone: what this folder is, where
 * things go, and how to leave word for a session that does not share this conversation.
 * it costs context in every session, so it stays short.
 */
export function renderClaudeMdStub(combo: Combo): string {
  const members = combo.folders.map((f) => {
    if (f.mode === "reference") {
      return referenceMemberLine(f);
    }
    const dir = f.as ?? path.basename(f.path);
    return `- \`${dir}/\` - working copy. a git worktree of \`${f.path}\`, ${branchLabel(f)}.`;
  });
  return [
    `# ${combo.name}`,
    "",
    combo.note?.trim() || "What this combo is for: (describe the task here)",
    "",
    "## What this folder is",
    "",
    "A combo: one folder that gathers the repos a single task needs. It is not a git repository -",
    "run git inside the member folders.",
    "",
    ...(members.length ? members : ["- (no members yet)"]),
    "",
    "## Worktrees",
    "",
    ...worktreesBlock(combo.root),
    "",
    "## Where things go",
    "",
    "Nothing below belongs inside a worktree. Keep those clean, so nothing lands in a commit by accident.",
    "",
    "- `plans/` - plans and designs, one file each: `YYYY-MM-DD-topic.md`. a plan that only exists in a chat is gone when the session ends or forks",
    "- `artifacts/` - generated things that are not source: reports, query results, exports, diagrams, scratch scripts",
    "- `context/` - what other sessions need to know. see below",
    "",
    "## Other sessions work here too",
    "",
    "Several sessions can be working in this folder at once: forks of this conversation, background",
    "agents, other tabs. They do not share your conversation. The files in `context/` are the only",
    "memory you have in common.",
    "",
    "- before starting a task, read `context/`",
    "- when you decide something, learn something non-obvious, or finish a piece of work, write it to `context/<topic>.md` as a short dated entry",
    "- add to a file, do not rewrite it. another session may be reading it or adding to it",
    "- before a large edit in a worktree, say what you are touching in `context/in-progress.md`, and remove your entry when done. two sessions editing the same files is what this prevents",
    "",
    "This file was written once when the combo was created. It is yours to edit.",
    "",
  ].join("\n");
}

/**
 * creates the combo root. the CLAUDE.md stub and the shared folders are
 * written only by the call that really created the directory, the stub with the wx flag as a second guard: if the
 * person deletes or rewrites any of it later, it stays that way.
 */
export async function ensureRoot(combo: Combo): Promise<{ created: boolean }> {
  await mkdir(path.dirname(combo.root), { recursive: true });
  try {
    await mkdir(combo.root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
    throw e;
  }
  await writeFile(path.join(combo.root, "CLAUDE.md"), renderClaudeMdStub(combo), {
    flag: "wx",
  }).catch(() => {});
  for (const dir of COMBO_SHARED_DIRS) {
    await mkdir(path.join(combo.root, dir)).catch(() => {});
  }
  return { created: true };
}
