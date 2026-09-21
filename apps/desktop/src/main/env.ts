import os from "node:os";
import path from "node:path";
import { getAppRoot, getProjectsDir, getStateDir, type Settings } from "@grove/core";

export interface AppEnv {
  appRoot: string;
  stateDir: string;
  home: string;
  /** GROVE_ROOT is set: a test, or a second setup next to the everyday one */
  customRoot: boolean;
  /** stands in for /usr/bin/open in tests */
  openBin: string;
  claudeBinOverride?: string;
  devServerUrl?: string;
  isDev: boolean;
}

export function resolveAppEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): AppEnv {
  const appRoot = getAppRoot({ env, home });
  const devServerUrl = env.GROVE_DEV_SERVER_URL?.trim() || undefined;
  return {
    appRoot,
    stateDir: getStateDir(appRoot),
    home,
    customRoot: Boolean(env.GROVE_ROOT),
    openBin: env.GROVE_OPEN_BIN || "/usr/bin/open",
    claudeBinOverride: env.GROVE_CLAUDE_BIN || undefined,
    devServerUrl,
    isDev: devServerUrl !== undefined,
  };
}

/**
 * the single-instance lock lives in userData, so this decides which launches count as "the same
 * app": a custom root gets its own, and an unpackaged build never shares with the installed one.
 * null keeps electron's default.
 */
export function userDataDirFor(
  appEnv: AppEnv,
  o: { isPackaged: boolean; appData: string; productName: string },
): string | null {
  if (appEnv.customRoot) return path.join(appEnv.stateDir, "electron");
  if (!o.isPackaged) return path.join(o.appData, `${o.productName}-dev`);
  return null;
}

/** same precedence as the extension: the shared settings file, then CLAUDE_CONFIG_DIR, then ~/.claude */
export function resolveProjectsDir(settings: Pick<Settings, "claudeConfigDir">): string {
  return getProjectsDir({ claudeConfigDir: settings.claudeConfigDir });
}
