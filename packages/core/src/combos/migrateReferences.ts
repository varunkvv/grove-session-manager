import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../fsx.ts";
import { gitMessage, runGit } from "../git/exec.ts";
import { listWorktrees } from "../git/inspect.ts";
import { samePath } from "../paths.ts";
import type { Combo, ComboFolder } from "../types.ts";
import { branchLabel, referenceMemberLine } from "./claudeMd.ts";
import { cleanRecordFiles } from "./recordCleanup.ts";
import { targetDirFor } from "./schema.ts";
import { updateCombos } from "./store.ts";
import { workspaceFilePath, writeWorkspaceFile } from "./workspace.ts";

export interface FolderMigration {
  combo: string;
  path: string;
  /** moved: worktree moved (or would be), flipped: nothing to move, kept: left a worktree-mode entry */
  action: "moved" | "flipped" | "kept";
  from: string;
  to?: string;
  message: string;
}

export interface ComboMigration {
  combo: string;
  folders: FolderMigration[];
  /** what happened to the stub, empty when there was nothing to say */
  claudeMd: string[];
}

export interface MigrationReport {
  applied: boolean;
  combos: ComboMigration[];
  moved: number;
  flipped: number;
  kept: number;
}

/** the line renderClaudeMdStub wrote before 050dc1e for a working copy */
function oldMemberLine(f: ComboFolder): string {
  const dir = f.as ?? path.basename(f.path);
  return `- \`${dir}/\` - working copy. a git worktree of \`${f.path}\`, ${branchLabel(f)}.`;
}

async function isWorktreeOf(origin: string, dir: string): Promise<boolean> {
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) return false;
  const listed = await listWorktrees(origin);
  return listed.ok && listed.value.some((e) => !e.isMain && samePath(e.path, dir));
}

/**
 * moves every working copy to `<root>/worktrees/<repo>` with `git worktree move` (branch, commits
 * and uncommitted files stay), flips the folder to a reference and rewrites the project's stub.
 * a dry run only reports. combos.json is written once, at the end.
 */
export async function migrateReferences(
  appRoot: string,
  combos: Combo[],
  opts: { apply: boolean },
): Promise<MigrationReport> {
  const report: MigrationReport = {
    applied: opts.apply,
    combos: [],
    moved: 0,
    flipped: 0,
    kept: 0,
  };
  // combo name -> indexes of the folders that flip
  const flips = new Map<string, Set<number>>();

  for (const combo of combos) {
    const entry: ComboMigration = { combo: combo.name, folders: [], claudeMd: [] };
    const taken = new Set<string>();
    const done = new Set<number>();
    for (const [i, f] of combo.folders.entries()) {
      if (f.mode !== "worktree") continue;
      const from = targetDirFor(combo, f);
      const base = { combo: combo.name, path: f.path, from };
      if (!(await isWorktreeOf(f.path, from))) {
        entry.folders.push({
          ...base,
          action: "flipped",
          message: "no worktree there, only flipping to a reference",
        });
        done.add(i);
        continue;
      }
      let name = path.basename(f.path);
      for (let n = 2; taken.has(name) || existsSync(path.join(combo.root, "worktrees", name)); n++)
        name = `${path.basename(f.path)}-${n}`;
      taken.add(name);
      const to = path.join(combo.root, "worktrees", name);
      if (!opts.apply) {
        entry.folders.push({ ...base, action: "moved", to, message: "would move" });
        done.add(i);
        continue;
      }
      await mkdir(path.dirname(to), { recursive: true });
      const moved = await runGit(["worktree", "move", from, to], { cwd: f.path });
      if (!moved.ok) {
        entry.folders.push({
          ...base,
          action: "kept",
          to,
          message: `left as a worktree: ${gitMessage(moved)}`,
        });
        continue;
      }
      entry.folders.push({ ...base, action: "moved", to, message: "moved" });
      done.add(i);
    }
    flips.set(combo.name, done);

    // the stub: member lines of the folders that flip. the swaps follow once combos.json is written
    const claudeMd = path.join(combo.root, "CLAUDE.md");
    const text = await readFile(claudeMd, "utf8").catch(() => null);
    if (text !== null) {
      let next = text;
      for (const i of done) {
        const f = combo.folders[i];
        if (!f) continue;
        const line = oldMemberLine(f);
        if (text.includes(line)) next = next.replace(line, () => referenceMemberLine(f));
        else entry.claudeMd.push(`member line of ${f.path} was edited or is gone, left alone`);
      }
      if (next !== text) {
        entry.claudeMd.push(opts.apply ? "member lines rewritten" : "would rewrite member lines");
        if (opts.apply) await writeFileAtomic(claudeMd, next, (await stat(claudeMd)).mode & 0o777);
      }
    }
    report.combos.push(entry);
  }

  for (const c of report.combos) for (const f of c.folders) report[f.action]++;
  if (!opts.apply) return report;

  const written = await updateCombos(appRoot, (all) =>
    all.map((c) => {
      const done = flips.get(c.name);
      if (!done) return c;
      return {
        ...c,
        folders: c.folders.map((f, i) => {
          if (!done.has(i)) return f;
          const { as: _as, branch: _branch, ...rest } = f;
          return { ...rest, mode: "reference" as const };
        }),
      };
    }),
  );
  if (!written.ok) throw new Error(written.error.message);

  // the swaps and the workspace file, now that the combos are what they will be
  for (const [i, combo] of combos.entries()) {
    const now = written.value.find((c) => c.name === combo.name) ?? combo;
    const cleaned = await cleanRecordFiles(now);
    if (cleaned.length) report.combos[i]?.claudeMd.push(`cleaned ${cleaned.join(", ")}`);
    if (existsSync(workspaceFilePath(now))) await writeWorkspaceFile(now);
  }
  return report;
}
