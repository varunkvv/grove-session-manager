import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Combo } from "../types.ts";
import { COMBO_SHARED_DIRS } from "./folders.ts";

/** the agent long work is handed to when the combo's policy says background. `background: true` keeps it off the main thread. */
export const LONG_TASK_AGENT = "long-task";

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
    "## Long work",
    "",
    "Before starting anything you expect to take more than a few minutes of autonomous work, read",
    "`.claude/long-work.md` and follow it. It says whether long work runs in the background or here,",
    "and it can change while a session is running, so read it each time rather than remembering it.",
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

export function longTaskAgentPath(combo: Combo): string {
  return path.join(combo.root, ".claude", "agents", `${LONG_TASK_AGENT}.md`);
}

/**
 * a subagent starts with its own prompt, the combo's CLAUDE.md and the brief it is handed -
 * never the conversation that spawned it. so the prompt sends it to the files where that
 * context was written down, and has it write back to the same place.
 */
export function renderLongTaskAgent(combo: Combo): string {
  return [
    "---",
    `name: ${LONG_TASK_AGENT}`,
    "description: Runs one long piece of implementation or investigation in the background, so the main conversation stays free to talk and plan. Use it only when .claude/long-work.md says long work runs in the background, or when the person asks for it. It cannot see the conversation - give it the path of a plan file in plans/ and anything the plan leaves out.",
    "background: true",
    "model: inherit",
    "---",
    "",
    `You are doing one long piece of work inside the "${combo.name}" combo, in the background. The person and the`,
    "main conversation are busy with something else and cannot answer you, so do not stop to ask. Decide, write down",
    "why, and carry on.",
    "",
    "Before you start:",
    "",
    "- read the plan file you were given, then `context/`. they hold what the conversation that sent you knows and you do not",
    "- add an entry to `context/in-progress.md` naming the working copy and the files you will touch",
    "- stay inside the working copy and files you were given. another agent may own the rest",
    "",
    "While you work:",
    "",
    "- when you decide something the plan did not settle, or learn something non-obvious, add a short dated entry to `context/<topic>.md`",
    "- generated output that is not source goes in `artifacts/`, never inside a working copy",
    "- run the tests for what you changed. a change you did not verify is not finished",
    "",
    "When you finish:",
    "",
    "- remove your entry from `context/in-progress.md`",
    "- report what you changed, what you verified and how, what you decided on your own, and what is left. if something failed, say so with the output",
    "",
  ].join("\n");
}

/**
 * creates the combo root. the CLAUDE.md stub, the shared folders and the long-task agent are
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
  const agent = longTaskAgentPath(combo);
  await mkdir(path.dirname(agent), { recursive: true }).catch(() => {});
  await writeFile(agent, renderLongTaskAgent(combo), { flag: "wx" }).catch(() => {});
  return { created: true };
}
