import { stat } from "node:fs/promises";
import { ensureWorktrees } from "../git/worktrees.ts";
import { writeIntent } from "../intents.ts";
import { getStateDir } from "../paths.ts";
import { syncComboStatusHooks } from "../sessions/liveStatus.ts";
import { type Combo, err, type FolderOutcome, ok, type Result, type Warning } from "../types.ts";
import { ensureRoot } from "./claudeMd.ts";
import { syncLongWorkPolicy } from "./longWork.ts";
import { type SyncResult, syncAdditionalDirectories } from "./settingsSync.ts";
import { writeWorkspaceFile } from "./workspace.ts";

export interface PrepareOptions {
  sessionId?: string;
  /** land on a new conversation instead of a session. needs companion 0.3.0 or later. */
  newConversation?: boolean;
  prompt?: string;
  /** a stale folder may be a big checkout someone deleted on purpose. off unless asked. */
  repairStale?: boolean;
  gitPath?: string;
  source?: string;
  onOutcome?: (outcome: FolderOutcome) => void;
}

export interface PrepareReport {
  combo: Combo;
  rootCreated: boolean;
  outcomes: FolderOutcome[];
  sync: SyncResult;
  workspaceFile: string;
  workspaceChanged: boolean;
  intentFile?: string;
  warnings: Warning[];
}

/**
 * everything that has to be true on disk before the editor opens a combo. the app and the
 * extension both call this, so "open combo" means the same thing in both places.
 * per-folder failures are reported in `outcomes`. they never stop the open.
 */
export async function prepareComboOpen(
  appRoot: string,
  combo: Combo,
  opts: PrepareOptions = {},
): Promise<PrepareReport> {
  const warnings: Warning[] = [];
  const { created } = await ensureRoot(combo);
  await syncLongWorkPolicy(combo);
  const outcomes = await ensureWorktrees(combo, {
    gitPath: opts.gitPath,
    repairStale: opts.repairStale,
    onOutcome: opts.onOutcome,
  });
  // synced before the intent is written, so a session the extension resumes already has access
  const sync = await syncAdditionalDirectories(combo, getStateDir(appRoot));
  if (sync.warning) warnings.push(sync.warning);
  const hooks = await syncComboStatusHooks(appRoot, combo);
  if (hooks.warning) warnings.push(hooks.warning);
  const ws = await writeWorkspaceFile(combo);
  warnings.push(...ws.warnings);

  let intentFile: string | undefined;
  const common = {
    cwd: combo.root,
    workspaceFile: ws.path,
    prompt: opts.prompt,
    source: opts.source,
  };
  if (opts.sessionId) {
    intentFile = await writeIntent(appRoot, { ...common, sessionId: opts.sessionId });
  } else if (opts.newConversation) {
    intentFile = await writeIntent(appRoot, { ...common, kind: "new" });
  }
  return {
    combo,
    rootCreated: created,
    outcomes,
    sync,
    workspaceFile: ws.path,
    workspaceChanged: ws.changed,
    intentFile,
    warnings,
  };
}

/** a session that belongs to no combo: open its own folder and land on it there */
export async function prepareFolderOpen(
  appRoot: string,
  cwd: string,
  opts: { sessionId: string; prompt?: string; source?: string },
): Promise<Result<{ cwd: string; intentFile: string }>> {
  try {
    if (!(await stat(cwd)).isDirectory()) return err("cwd-missing", `${cwd} is not a directory`);
  } catch {
    return err("cwd-missing", `${cwd} no longer exists`);
  }
  const intentFile = await writeIntent(appRoot, {
    sessionId: opts.sessionId,
    cwd,
    prompt: opts.prompt,
    source: opts.source,
  });
  return ok({ cwd, intentFile });
}
