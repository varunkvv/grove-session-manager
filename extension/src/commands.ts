import { stat } from "node:fs/promises";
import {
  buildResumeCommand,
  type Combo,
  loadCombos,
  prepareComboOpen,
  prepareFolderOpen,
  type SessionView,
  samePath,
} from "@grove/core";
import type { Deps } from "./deps.ts";
import { type ResumeResult, resumeSession } from "./resume.ts";

export type OpenOutcome = ResumeResult | "opened-combo" | "opened-folder" | "copied";

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function openCombo(deps: Deps, combo: Combo, sessionId?: string): Promise<void> {
  const report = await prepareComboOpen(deps.appRoot, combo, {
    sessionId,
    gitPath: deps.gitPath,
    source: "extension",
  });
  for (const o of report.outcomes) {
    if (o.action === "collision" || o.action === "failed" || o.action === "refused-foreign") {
      void deps.warn(`${combo.name}: ${o.message ?? o.action}`);
    }
  }
  await deps.openFolder(report.workspaceFile, true);
}

/** what picking a session in the quick pick does */
export async function openSession(deps: Deps, session: SessionView): Promise<OpenOutcome> {
  const here = deps.workspace().root;
  const cwd = session.relocatedCwd ?? session.cwd;

  if (here && cwd && samePath(cwd, here)) return resumeSession(deps, session.sessionId);

  if (session.comboName) {
    const combo = (await loadCombos(deps.appRoot)).combos.find((c) => c.name === session.comboName);
    if (combo) {
      if (here && samePath(combo.root, here)) return resumeSession(deps, session.sessionId);
      await openCombo(deps, combo, session.sessionId);
      return "opened-combo";
    }
  }

  if (cwd && (await exists(cwd))) {
    const prepared = await prepareFolderOpen(deps.appRoot, cwd, {
      sessionId: session.sessionId,
      source: "extension",
    });
    if (prepared.ok) {
      await deps.openFolder(cwd, true);
      return "opened-folder";
    }
  }

  await deps.copy(buildResumeCommand(session.sessionId));
  void deps.info("That session's folder is gone. The resume command is on your clipboard.");
  return "copied";
}
