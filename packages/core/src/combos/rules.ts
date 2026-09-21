import os from "node:os";
import path from "node:path";
import { pathRelation, realpathLoose } from "../paths.ts";
import { claudeProjectSlug, comboDirSlug } from "../slug.ts";
import type { Combo } from "../types.ts";
import { COMBO_RESERVED_NAMES } from "./folders.ts";
import { targetDirFor } from "./schema.ts";

export function validateComboName(
  name: string,
  existing: readonly Combo[],
  self?: string,
): { slug: string; problem?: string } {
  const trimmed = name.trim();
  const slug = comboDirSlug(trimmed);
  if (!trimmed) return { slug, problem: "Give the combo a name." };
  if (!slug) return { slug, problem: "The name needs at least one letter or digit." };
  const clash = existing.find(
    (c) =>
      c.name !== self &&
      (c.name.toLowerCase() === trimmed.toLowerCase() || path.basename(c.root) === slug),
  );
  if (clash) return { slug, problem: `"${clash.name}" already uses that name.` };
  return { slug };
}

/** problems with the folder list: bad `as` values and two folders that would land in one directory */
export function validateFolders(combo: Combo): string[] {
  const problems: string[] = [];
  const targets = new Map<string, string>();
  const seen = new Set<string>();
  const workspaceFile = `${path.basename(combo.root)}.code-workspace`.toLowerCase();
  for (const f of combo.folders) {
    const key = `${f.mode}:${realpathLoose(f.path)}`;
    if (seen.has(key)) problems.push(`${f.path} is listed twice.`);
    seen.add(key);
    if (f.mode !== "worktree") continue;
    const dirName = f.as ?? path.basename(f.path);
    if (f.as !== undefined) {
      if (!f.as || f.as !== path.basename(f.as) || f.as === "." || f.as === "..") {
        problems.push(`"${f.as}" is not a single folder name.`);
        continue;
      }
      if (/^[.-]/.test(f.as)) problems.push(`"${f.as}" cannot start with "." or "-".`);
    }
    const lower = dirName.toLowerCase();
    if (COMBO_RESERVED_NAMES.has(lower) || lower === workspaceFile)
      problems.push(
        `"${dirName}" is a name the combo folder uses itself. Give that working copy another folder name.`,
      );
    const other = targets.get(lower);
    if (other)
      problems.push(
        `${f.path} and ${other} would both become "${dirName}". Set a folder name on one of them.`,
      );
    targets.set(lower, f.path);
  }
  return problems;
}

/**
 * the combo root is Claude's cwd and the key that ties sessions to the combo, so it has to be
 * unique in the way Claude sees it: by project slug, not just by path.
 */
export function validateComboRoot(
  combo: Combo,
  others: readonly Combo[],
  appRoot: string,
  home: string = os.homedir(),
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!path.isAbsolute(combo.root))
    return { problems: ["The combo folder must be an absolute path."], warnings };
  const root = realpathLoose(combo.root);
  const slug = claudeProjectSlug(root);

  for (const [p, label] of [
    ["/", "the filesystem root"],
    [home, "your home folder"],
    [appRoot, "the app folder itself"],
  ] as const) {
    if (root === realpathLoose(p)) problems.push(`The combo folder cannot be ${label}.`);
  }
  if (pathRelation(root, path.join(home, ".claude")))
    problems.push("The combo folder cannot live inside ~/.claude.");

  for (const f of combo.folders) {
    const rel = pathRelation(f.path, root);
    if (rel) problems.push(`${f.path} is inside the combo folder. Members must live elsewhere.`);
    else if (pathRelation(root, f.path)) problems.push(`The combo folder is inside ${f.path}.`);
  }

  for (const o of others) {
    if (o.name === combo.name) continue;
    const otherRoot = realpathLoose(o.root);
    if (pathRelation(root, otherRoot) || pathRelation(otherRoot, root)) {
      problems.push(`The combo folder overlaps with "${o.name}".`);
      continue;
    }
    const otherSlugs = [
      otherRoot,
      ...o.folders
        .filter((f) => f.mode === "worktree")
        .map((f) => realpathLoose(targetDirFor(o, f))),
    ];
    if (otherSlugs.some((p) => claudeProjectSlug(p) === slug)) {
      problems.push(
        `Claude Code would store this combo's sessions in the same place as "${o.name}". Pick another name.`,
      );
    }
  }
  return { problems, warnings };
}
