import path from "node:path";
import { realpathLoose } from "../paths.ts";
import { claudeProjectSlug } from "../slug.ts";
import type { Combo, ComboRelation, SessionRecord, SessionView } from "../types.ts";

interface ComboKey {
  name: string;
  root: string;
  slug: string;
}

function keysFor(combos: readonly Combo[]): ComboKey[] {
  return combos
    .map((c) => {
      const root = realpathLoose(c.root);
      return { name: c.name, root, slug: claudeProjectSlug(root) };
    })
    .sort((a, b) => b.root.length - a.root.length);
}

function relate(cwd: string, root: string): ComboRelation | null {
  if (cwd === root) return "root";
  return cwd.startsWith(root + path.sep) ? "inside" : null;
}

/**
 * which combo a session belongs to. each combo root is unique, so cwd -> combo needs no
 * bookkeeping: a session started by hand, from a terminal, or while the app was closed still
 * maps. the first cwd decides. the project dir name only covers the first second of a new
 * session, before a cwd is readable. never a slug PREFIX: '-ws-prod' prefixes '-ws-prod-debug'.
 */
export function assignCombos(
  records: readonly SessionRecord[],
  combos: readonly Combo[],
): SessionView[] {
  const keys = keysFor(combos);
  if (keys.length === 0) return records.map((r) => ({ ...r }));
  return records.map((r) => {
    const cwd = (r.relocatedCwd ?? r.cwd)?.normalize("NFC");
    for (const k of keys) {
      const relation = cwd ? relate(cwd, k.root) : r.projectDirName === k.slug ? "root" : null;
      if (relation) return { ...r, comboName: k.name, comboRelation: relation };
    }
    return { ...r };
  });
}

/**
 * a human label for a session we could not parse. borrows the cwd of a sibling whose
 * forward-computed slug equals the dir name. a slug is never reversed.
 */
export function projectDirLabel(
  projectDirName: string,
  siblings: readonly SessionRecord[],
): string {
  for (const s of siblings) {
    if (
      s.projectDirName === projectDirName &&
      s.cwd &&
      claudeProjectSlug(s.cwd) === projectDirName
    ) {
      return path.basename(s.cwd);
    }
  }
  return projectDirName;
}
