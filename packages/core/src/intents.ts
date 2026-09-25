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
interface IntentBase {
  version: 1;
  /** the primary folder being opened: a combo root, or a plain session's own cwd */
  cwd: string;
  workspaceFile?: string;
  /** resume: sent to the session. new: put in the input box, for the person to send. */
  prompt?: string;
  issuedAt: number;
  source?: string;
}

/**
 * `resume` lands on a conversation that exists. `new` starts one in that folder. a file from an
 * app that predates `kind` is a resume, and an older companion ignores a `new` one: it has no
 * session id to take.
 */
export type Intent =
  | (IntentBase & { kind: "resume"; sessionId: string })
  | (IntentBase & { kind: "new" });

type IntentFields = Omit<IntentBase, "version" | "issuedAt"> & { issuedAt?: number };

/** what a caller asks for. `kind` is optional on a resume, which is what every older caller writes. */
export type IntentRequest =
  | (IntentFields & { kind?: "resume"; sessionId: string })
  | (IntentFields & { kind: "new" });

export const INTENT_TTL_MS = 5 * 60_000;

export function pendingDir(appRoot: string): string {
  return path.join(getStateDir(appRoot), "pending");
}

/** one intent per folder: the last click wins. readers match on content, the name is opaque. */
export function intentFileName(cwd: string): string {
  return `${createHash("sha1").update(realpathLoose(cwd)).digest("hex").slice(0, 16)}.json`;
}

export async function writeIntent(appRoot: string, intent: IntentRequest): Promise<string> {
  if (intent.kind !== "new" && !isValidSessionId(intent.sessionId)) {
    throw new Error("not a session id");
  }
  const file = path.join(pendingDir(appRoot), intentFileName(intent.cwd));
  const at = { version: 1 as const, issuedAt: Date.now() };
  const cwd = realpathLoose(intent.cwd);
  const body: Intent =
    intent.kind === "new" ? { ...at, ...intent, cwd } : { ...at, ...intent, kind: "resume", cwd };
  await writeFileAtomic(file, JSON.stringify(body, null, 2));
  return file;
}

function parseIntent(raw: unknown, now: number, ttl: number): Intent | null {
  if (!isObject(raw)) return null;
  if (typeof raw.cwd !== "string" || typeof raw.issuedAt !== "number") return null;
  if (raw.issuedAt > now + 60_000 || now - raw.issuedAt > ttl) return null;
  const base: IntentBase = {
    version: 1,
    cwd: raw.cwd,
    issuedAt: raw.issuedAt,
    ...(typeof raw.workspaceFile === "string" ? { workspaceFile: raw.workspaceFile } : {}),
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
  };
  // a new conversation that names a session is one or the other, and guessing wrong either way
  // lands someone somewhere they did not ask for
  if (raw.kind === "new") return "sessionId" in raw ? null : { ...base, kind: "new" };
  if (raw.kind !== undefined && raw.kind !== "resume") return null;
  if (!isValidSessionId(raw.sessionId)) return null;
  return { ...base, kind: "resume", sessionId: raw.sessionId };
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
  intent: Pick<Intent, "cwd" | "workspaceFile">,
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
