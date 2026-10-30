// one-time cleanup, can go in a later release. the judgment day odds feature is gone, so nothing
// else deletes what it left behind: its model (about 2.7 GB, in Application Support) and its score
// files (under the combo root's .grove/decisioning). each launch removes exactly those, and does
// nothing once they are gone. a folder goes only when it is empty afterwards.
import { readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.ts";

/** the model's file name: its sha256's first 16 hex digits, as the feature named it */
const MODEL_FILE = "8a12b976e7d2ea60.gguf";
/** the model's own siblings: the download in progress, and the checksum written once it matched */
const MODEL_SIDECARS = [`${MODEL_FILE}.part`, `${MODEL_FILE}.sha256`];

export interface LeftoverPaths {
  /** <stateDir>/decisioning: only the score files are in it */
  scoresDir: string;
  /** <appData>/Grove/models. omit it for a test root, which never downloaded to appData */
  modelsDir?: string;
}

/** removes what the judgment day odds feature left on disk. returns the paths it removed */
export async function removeDecisioningLeftovers(p: LeftoverPaths): Promise<string[]> {
  const removed: string[] = [];
  if (p.modelsDir !== undefined) {
    await removeNamed(p.modelsDir, [MODEL_FILE, ...MODEL_SIDECARS], removed);
    await rmdirIfEmpty(p.modelsDir);
  }
  // the score files are scores.<rubric>.v<n>.json, and their atomic-write temps: nothing else lives here
  const names = await readdir(p.scoresDir).catch(() => [] as string[]);
  await removeNamed(
    p.scoresDir,
    names.filter((n) => n.startsWith("scores.")),
    removed,
  );
  await rmdirIfEmpty(p.scoresDir);
  for (const f of removed) log.info("removed a judgment day odds leftover:", f);
  return removed;
}

async function removeNamed(dir: string, names: string[], removed: string[]): Promise<void> {
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      await unlink(file);
      removed.push(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn("could not remove", file, e);
    }
  }
}

/** rmdir refuses a folder with anything in it, and a missing one is already done */
async function rmdirIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => {});
}
