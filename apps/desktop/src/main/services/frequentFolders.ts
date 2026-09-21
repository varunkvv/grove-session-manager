import { stat } from "node:fs/promises";
import path from "node:path";
import { isInside } from "@grove/core";
import type { FrequentFolder } from "../../shared/ipc.ts";

const DAY = 24 * 3_600_000;
/** a session this old still counts, a little */
const HALF_LIFE_MS = 14 * DAY;
/** being in a combo already is a stronger signal than one session run there */
const COMBO_WEIGHT = 3;
const LIMIT = 12;

export interface FolderUse {
  path: string;
  atMs: number;
  weight?: number;
}

const SCRATCH = ["/tmp", "/private/tmp", "/private/var", "/var/folders"];

interface NoiseOptions {
  home: string;
  appRoot: string;
  claudeDir: string;
  /** temp dirs. tests, which live in one, pass [] */
  scratch?: readonly string[];
}

/** places nobody means to add: scratch space, the app's own root, Claude's config */
export function isNoise(p: string, o: NoiseOptions): boolean {
  if (p === "/" || p === o.home || p === path.dirname(o.home)) return true;
  for (const dir of [o.appRoot, o.claudeDir, ...(o.scratch ?? SCRATCH)]) {
    if (p === dir || isInside(p, dir)) return true;
  }
  return false;
}

/** recent and repeated beats old and repeated, which beats one-off. pure, so testable. */
export function rankFolders(
  uses: readonly FolderUse[],
  now: number,
): Array<{ path: string; score: number; lastMs: number }> {
  const by = new Map<string, { path: string; score: number; lastMs: number }>();
  for (const u of uses) {
    const age = Math.max(0, now - u.atMs);
    const score = (u.weight ?? 1) * 0.5 ** (age / HALF_LIFE_MS);
    const cur = by.get(u.path) ?? { path: u.path, score: 0, lastMs: 0 };
    cur.score += score;
    cur.lastMs = Math.max(cur.lastMs, u.atMs);
    by.set(u.path, cur);
  }
  return [...by.values()].sort((a, b) => b.score - a.score || b.lastMs - a.lastMs);
}

async function exists(p: string): Promise<"dir" | "other" | null> {
  try {
    return (await stat(p)).isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/**
 * the repo a session ran in, not the subfolder it happened to start from. walks up looking for
 * `.git` (a directory, or the file a worktree has), and stops at the home folder.
 */
export async function repoRootOf(
  dir: string,
  home: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const hit = cache.get(dir);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  if ((await exists(dir)) === "dir") {
    found = dir;
    for (let d = dir; d !== home && d !== path.dirname(d); d = path.dirname(d)) {
      if (await exists(path.join(d, ".git"))) {
        found = d;
        break;
      }
    }
  }
  cache.set(dir, found);
  return found;
}

export async function frequentFolders(input: {
  sessions: ReadonlyArray<{ cwd?: string; activityMs: number; comboName?: string }>;
  comboFolders: ReadonlyArray<{ path: string; atMs: number }>;
  home: string;
  appRoot: string;
  claudeDir: string;
  scratch?: readonly string[];
  now?: number;
}): Promise<FrequentFolder[]> {
  const now = input.now ?? Date.now();
  const roots = new Map<string, string | null>();
  const uses: FolderUse[] = [];
  const noise: NoiseOptions = {
    home: input.home,
    appRoot: input.appRoot,
    claudeDir: input.claudeDir,
    ...(input.scratch ? { scratch: input.scratch } : {}),
  };
  // a session inside a combo ran in a worktree. the combo's own folders already speak for it.
  const cwds = input.sessions.filter((s) => s.cwd && !s.comboName && !isNoise(s.cwd, noise));
  await Promise.all(
    [...new Set(cwds.map((s) => s.cwd as string))].map((c) => repoRootOf(c, input.home, roots)),
  );
  for (const s of cwds) {
    const root = roots.get(s.cwd as string);
    if (root && !isNoise(root, noise)) uses.push({ path: root, atMs: s.activityMs });
  }
  for (const f of input.comboFolders) {
    if ((await exists(f.path)) === "dir")
      uses.push({ path: f.path, atMs: f.atMs, weight: COMBO_WEIGHT });
  }
  return rankFolders(uses, now)
    .slice(0, LIMIT)
    .map((r) => ({ path: r.path, name: path.basename(r.path), lastUsedMs: r.lastMs }));
}
