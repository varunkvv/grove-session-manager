import path from "node:path";
import {
  type Combo,
  type FolderStatus,
  loadCombos,
  reconcileCombo,
  repairCombo,
  samePath,
  syncAdditionalDirectories,
  syncLongWorkPolicy,
} from "@grove/core";
import type { Deps } from "./deps.ts";
import { drainIntents } from "./drain.ts";

const DRIFT = new Set(["stale", "foreign", "missing-origin"]);

export async function currentCombo(deps: Deps): Promise<Combo | undefined> {
  const root = deps.workspace().root;
  if (!root) return undefined;
  const { combos } = await loadCombos(deps.appRoot);
  return combos.find((c) => samePath(c.root, root));
}

function describe(s: FolderStatus): string {
  return `${path.basename(s.target)}: ${s.message ?? s.state}`;
}

export async function checkDrift(
  deps: Deps,
  combo: Combo,
  quiet: boolean,
): Promise<FolderStatus[]> {
  const statuses = await reconcileCombo(combo, { gitPath: deps.gitPath });
  const drifted = statuses.filter((s) => DRIFT.has(s.state));
  deps.setStatus({ combo: combo.name, drift: drifted.map(describe) });
  if (drifted.length === 0) return drifted;

  // drift is a normal state, not an error: say it once per distinct situation, never as a modal
  const signature = drifted.map((s) => `${s.target}:${s.state}`).join("|");
  if (quiet && deps.memory.get<string>("driftSignature") === signature) return drifted;
  await deps.memory.set("driftSignature", signature);

  const repairable = drifted.some((s) => s.state === "stale");
  const choice = await deps.warn(
    `${combo.name}: ${drifted.map(describe).join(". ")}.`,
    ...(repairable ? ["Repair"] : []),
  );
  if (choice === "Repair") {
    await repairCombo(combo, { gitPath: deps.gitPath });
    await checkDrift(deps, combo, false);
  }
  return drifted;
}

/** runs once per window, after activation: drain, then sync, then reconcile */
export async function runStartup(deps: Deps): Promise<{ combo?: string }> {
  if (!deps.workspace().root) return {};
  await drainIntents(deps, "activation");

  const combo = await currentCombo(deps);
  // a window on an ordinary repo only ever drains. no git calls and no writes, so a .claude/
  // directory never appears in someone's real clone because of us.
  if (!combo) {
    deps.setStatus({});
    return {};
  }
  deps.setStatus({ combo: combo.name });

  await syncLongWorkPolicy(combo).catch((e) => deps.log(`long-work policy: ${String(e)}`));
  if (deps.settings.syncAdditionalDirectories) {
    const sync = await syncAdditionalDirectories(combo, deps.stateDir);
    deps.log(`additionalDirectories: ${sync.status}`);
    if (sync.warning) void deps.warn(sync.warning.message);
  }
  if (deps.settings.reconcileOnStartup && deps.isTrusted()) {
    await checkDrift(deps, combo, true).catch((e) => deps.log(`reconcile failed: ${String(e)}`));
  }
  return { combo: combo.name };
}
