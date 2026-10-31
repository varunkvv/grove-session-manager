import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Combo } from "../types.ts";
import { COMBO_SHARED_DIRS } from "./folders.ts";

function branchLabel(f: Combo["folders"][number]): string {
  const b = f.branch;
  if (!b || b.kind === "detach") return "detached at HEAD";
  return b.kind === "new" ? `on branch \`${b.name}\`` : `on existing branch \`${b.name}\``;
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
      return `- \`${f.path}\` - reference. read it for context, do not change it.`;
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
    "A working copy is a git worktree: a second checkout of the original clone, sharing its `.git`.",
    "",
    "- commits and branches made here show up in the original clone straight away, and the other way round",
    "- it started clean. uncommitted work in the original clone is not here",
    "- a branch can be checked out in one worktree at a time. when `git checkout <branch>` refuses, that is why",
    "- never remove a working copy with `rm -rf` or `git worktree remove`. Grove owns their lifecycle",
    "",
    "## Where things go",
    "",
    "Nothing below belongs inside a working copy. Keep those clean, so nothing lands in a commit by accident.",
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
    "- before a large edit in a working copy, say what you are touching in `context/in-progress.md`, and remove your entry when done. two sessions editing the same files is what this prevents",
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
