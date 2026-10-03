// the record's runtime outside every combo: <appRoot>/.grove/bin/record (a sh launcher) and
// record.cjs (the bundle, copied out of the app). sessions run both through each combo's
// .mcp.json, its SessionStart hook and the Bash fallback.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getStateDir, type RecordInstall, writeFileAtomic } from "@grove/core";
import { compareVersions, renderLauncher } from "@grove/record";

export interface RecordRuntime {
  launcher: string;
  bundle: string;
  launcherChanged: boolean;
  bundleChanged: boolean;
  /** a newer Grove wrote the bundle. this one left it */
  newerInstalled?: string;
  error?: string;
}

export function recordPaths(appRoot: string): { launcher: string; bundle: string } {
  const dir = path.join(getStateDir(appRoot), "bin");
  return { launcher: path.join(dir, "record"), bundle: path.join(dir, "record.cjs") };
}

/**
 * a packaged app, or any build under GROVE_ROOT. an unpackaged build next to the installed app
 * installs nothing and points no combo at a launcher, so a dev run never writes into real combos.
 */
export function recordInstallFor(o: {
  isPackaged: boolean;
  customRoot: boolean;
  appRoot: string;
}): RecordInstall | undefined {
  if (!o.isPackaged && !o.customRoot) return undefined;
  return { launcher: recordPaths(o.appRoot).launcher };
}

/** the `app=` version in the build's banner, the bundle's first line */
export function bundleVersionOf(text: string): string | null {
  return /\/\/ grove-record app=(\S+)/.exec(text.slice(0, 512))?.[1] ?? null;
}

/**
 * writes only what differs. a launcher file with a new inode costs 250-400ms on its first exec, so
 * equal bytes are never written again. a bundle a newer Grove installed is left alone.
 */
export async function installRecordRuntime(o: {
  appRoot: string;
  /** process.execPath, the binary the launcher runs as node */
  execPath: string;
  /** out/record/record.cjs, inside app.asar when packaged */
  source: string;
  appVersion: string;
}): Promise<RecordRuntime> {
  const { launcher, bundle } = recordPaths(o.appRoot);
  const out: RecordRuntime = { launcher, bundle, launcherChanged: false, bundleChanged: false };
  try {
    const text = renderLauncher({ execPath: o.execPath, bundle });
    const [current, mode] = await Promise.all([
      readFile(launcher, "utf8").catch(() => null),
      stat(launcher).then(
        (s) => s.mode,
        () => 0,
      ),
    ]);
    if (current !== text || (mode & 0o100) === 0) {
      await writeFileAtomic(launcher, text, 0o755);
      out.launcherChanged = true;
    }

    const bytes = await readFile(o.source, "utf8");
    const installed = await readFile(bundle, "utf8").catch(() => null);
    if (installed === bytes) return out;
    const theirs = installed === null ? null : bundleVersionOf(installed);
    if (theirs && compareVersions(theirs, o.appVersion) > 0) {
      out.newerInstalled = theirs;
      return out;
    }
    await writeFileAtomic(bundle, bytes, 0o644);
    out.bundleChanged = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}
