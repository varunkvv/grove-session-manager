import path from "node:path";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { realpathLoose } from "../paths.ts";
import type { Combo, Warning } from "../types.ts";
import { referencePaths } from "./folders.ts";

export type SyncStatus =
  | "skipped-empty"
  | "created"
  | "skipped-invalid-json"
  | "skipped-unexpected-shape"
  | "unchanged"
  | "written";

export interface SyncResult {
  status: SyncStatus;
  file: string;
  directories: string[];
  warning?: Warning;
}

export function settingsLocalPath(combo: Combo): string {
  return path.join(combo.root, ".claude", "settings.local.json");
}

type Managed = Record<string, string[]>;

async function readManaged(file: string | null): Promise<Managed> {
  if (!file) return {};
  const read = await readJsonGuarded<Managed>(file);
  return read.status === "ok" && isObject(read.value) ? read.value : {};
}

/**
 * grants Claude file access to the combo's references when a session is started from a terminal
 * (the VS Code panel already passes the other workspace roots itself).
 *
 * we own our entries in permissions.additionalDirectories and nothing else in the file. `/add-dir`
 * can persist a person's own entries into the same array, so we only ever remove paths that we
 * added earlier (remembered in the cache dir). if that memory is lost we only add. a file that
 * is not valid JSON is left completely alone.
 */
export async function syncAdditionalDirectories(
  combo: Combo,
  stateDir: string | null,
): Promise<SyncResult> {
  const file = settingsLocalPath(combo);
  const desired = referencePaths(combo);
  const managedFile = stateDir ? path.join(stateDir, "managed-dirs.json") : null;
  const rootKey = realpathLoose(combo.root);

  const read = await readJsonGuarded(file);
  if (read.status === "invalid") {
    return {
      status: "skipped-invalid-json",
      file,
      directories: desired,
      warning: {
        code: "settings-invalid-json",
        message: `${file} is not valid JSON, so it was left untouched. References are not synced until it is fixed.`,
      },
    };
  }

  const managed = await readManaged(managedFile);
  const previous = managed[rootKey] ?? [];
  const remember = async () => {
    if (!managedFile) return;
    const same = previous.length === desired.length && previous.every((p, i) => p === desired[i]);
    if (same) return;
    const next = { ...managed, [rootKey]: desired };
    if (desired.length === 0) delete next[rootKey];
    await writeFileAtomic(managedFile, JSON.stringify(next, null, 2));
  };

  if (read.status === "missing") {
    if (desired.length === 0) return { status: "skipped-empty", file, directories: [] };
    await writeFileAtomic(file, stringifyLike({ permissions: { additionalDirectories: desired } }));
    await remember();
    return { status: "created", file, directories: desired };
  }

  const root = read.value;
  if (!isObject(root)) return { status: "skipped-unexpected-shape", file, directories: desired };
  const permissions = root.permissions;
  if (permissions !== undefined && !isObject(permissions)) {
    return { status: "skipped-unexpected-shape", file, directories: desired };
  }
  const existing = permissions?.additionalDirectories;
  if (
    existing !== undefined &&
    !(Array.isArray(existing) && existing.every((e) => typeof e === "string"))
  ) {
    return { status: "skipped-unexpected-shape", file, directories: desired };
  }

  const current = (existing as string[] | undefined) ?? [];
  const next = current.filter((dir) => !(previous.includes(dir) && !desired.includes(dir)));
  for (const dir of desired) if (!next.includes(dir)) next.push(dir);

  const unchanged = next.length === current.length && next.every((d, i) => d === current[i]);
  if (unchanged) {
    await remember();
    return { status: "unchanged", file, directories: next };
  }

  const updated = { ...root, permissions: { ...(permissions ?? {}), additionalDirectories: next } };
  await writeFileAtomic(file, stringifyLike(updated, read.text));
  await remember();
  return { status: "written", file, directories: next };
}
