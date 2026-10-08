import { stat } from "node:fs/promises";
import type { HookSyncStatus } from "../sessions/liveStatus.ts";
import type { Combo, Warning } from "../types.ts";
import { syncLongWorkPolicy } from "./longWork.ts";
import { cleanRecordFiles, syncComboSettings } from "./recordCleanup.ts";

export interface ComboSyncReport {
  root: string;
  skipped?: "no-root";
  settings: HookSyncStatus;
  warnings: Warning[];
  /** what was left of the 0.10 record and is gone now, as paths from the root. see recordCleanup.ts */
  cleaned: string[];
}

/**
 * everything grove keeps current in one project folder: the long-work policy and the status
 * hooks. `cleanRecord` also takes out what 0.10 installed for the record: the app passes it when
 * the projects are its own to edit, a dev build next to the installed app never does
 */
export async function syncComboFiles(
  appRoot: string,
  combo: Combo,
  opts: { cleanRecord?: boolean } = {},
): Promise<ComboSyncReport> {
  const report: ComboSyncReport = {
    root: combo.root,
    settings: "unchanged",
    warnings: [],
    cleaned: [],
  };
  // every write below would recreate a deleted root with only .claude in it
  const rootIsDir = await stat(combo.root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!rootIsDir) return { ...report, skipped: "no-root" };
  await syncLongWorkPolicy(combo);
  if (opts.cleanRecord) report.cleaned = await cleanRecordFiles(combo);
  const settings = await syncComboSettings(appRoot, combo, opts.cleanRecord === true);
  report.settings = settings.status;
  if (settings.warning) report.warnings.push(settings.warning);
  return report;
}
