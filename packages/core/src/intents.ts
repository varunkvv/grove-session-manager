import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { isObject, writeFileAtomic } from "./fsx.ts";
import { getStateDir, pathRelation, realpathLoose, samePath } from "./paths.ts";
import { isValidSessionId } from "./sessions/resume.ts";

/**
 * the handoff from the app to the editor. nothing tells an outside process when VS Code has
 * finished opening a workspace, so the app writes what it wants here and the companion
 * extension picks it up from inside the right window. a file plus a launch survives restarts.
 */
export interface Intent {
  version: 1;
  sessionId: string;
  /** the primary folder being opened: a combo root, or a plain session's own cwd */
  cwd: string;
  workspaceFile?: string;
  prompt?: string;
  issuedAt: number;
  source?: string;
}

export const INTENT_TTL_MS = 5 * 60_000;

export function pendingDir(appRoot: string): string {
  return path.join(getStateDir(appRoot), "pending");
}

/** one intent per folder: the last click wins. readers match on content, the name is opaque. */
export function intentFileName(cwd: string): string {
  return `${createHash("sha1").update(realpathLoose(cwd)).digest("hex").slice(0, 16)}.json`;
}

export async function writeIntent(
  appRoot: string,
  intent: Omit<Intent, "version" | "issuedAt"> & { issuedAt?: number },
): Promise<string> {
  if (!isValidSessionId(intent.sessionId)) throw new Error("not a session id");
  const file = path.join(pendingDir(appRoot), intentFileName(intent.cwd));
  const body: Intent = {
    version: 1,
    issuedAt: Date.now(),
    ...intent,
    cwd: realpathLoose(intent.cwd),
  };
  await writeFileAtomic(file, JSON.stringify(body, null, 2));
  return file;
}

function parseIntent(raw: unknown, now: number, ttl: number): Intent | null {
  if (!isObject(raw) || !isValidSessionId(raw.sessionId)) return null;
  if (typeof raw.cwd !== "string" || typeof raw.issuedAt !== "number") return null;
  if (raw.issuedAt > now + 60_000 || now - raw.issuedAt > ttl) return null;
  return {
    version: 1,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    issuedAt: raw.issuedAt,
    ...(typeof raw.workspaceFile === "string" ? { workspaceFile: raw.workspaceFile } : {}),
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
  };
}

export async function listIntents(
  appRoot: string,
  now: number = Date.now(),
  ttl: number = INTENT_TTL_MS,
): Promise<Array<{ file: string; intent: Intent }>> {
  const dir = pendingDir(appRoot);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<{ file: string; intent: Intent }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const intent = parseIntent(JSON.parse(await readFile(file, "utf8")), now, ttl);
      if (intent) out.push({ file, intent });
    } catch {
      // junk or mid-write. the sweep removes it later.
    }
  }
  return out.sort((a, b) => b.intent.issuedAt - a.intent.issuedAt);
}

export function matchIntent(
  intent: Intent,
  workspace: { root: string; workspaceFile?: string },
): "exact" | "inside" | null {
  if (
    intent.workspaceFile &&
    workspace.workspaceFile &&
    samePath(intent.workspaceFile, workspace.workspaceFile)
  ) {
    return "exact";
  }
  const rel = pathRelation(intent.cwd, workspace.root);
  return rel === "same" ? "exact" : rel;
}

/** rename first, so two windows that see the same intent cannot both take it */
export async function claimIntent(file: string): Promise<Intent | null> {
  const claimed = `${file}.claimed-${process.pid}-${Date.now()}`;
  try {
    await rename(file, claimed);
  } catch {
    return null;
  }
  try {
    return parseIntent(JSON.parse(await readFile(claimed, "utf8")), Date.now(), INTENT_TTL_MS);
  } catch {
    return null;
  } finally {
    await unlink(claimed).catch(() => {});
  }
}

export async function sweepIntents(
  appRoot: string,
  now: number = Date.now(),
  ttl: number = INTENT_TTL_MS,
): Promise<number> {
  const dir = pendingDir(appRoot);
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const live = new Set((await listIntents(appRoot, now, ttl)).map((i) => path.basename(i.file)));
  for (const name of names) {
    if (live.has(name)) continue;
    const file = path.join(dir, name);
    try {
      // leave very fresh files alone: they may be a write or a claim in progress
      if (now - (await stat(file)).mtimeMs < 10_000 && !name.endsWith(".json")) continue;
      await unlink(file);
      removed++;
    } catch {
      // already gone
    }
  }
  return removed;
}
