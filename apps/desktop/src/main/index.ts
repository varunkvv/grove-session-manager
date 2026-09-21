import path from "node:path";
import { loadSettings, type Settings } from "@grove/core";
import type { BrowserWindow } from "electron";
import * as electron from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";
import { type AppEnv, resolveAppEnv, resolveProjectsDir, userDataDirFor } from "./env.ts";
import { registerIpc } from "./ipc.ts";
import { log } from "./log.ts";
import { installMenu } from "./menu.ts";
import { OpQueue } from "./opQueue.ts";
import { APP_ENTRY_URL, entryUrl, isTrustedUrl } from "./origin.ts";
import { registerAppScheme, serveRenderer } from "./protocol.ts";
import { Pusher } from "./push.ts";
import { ComboService, type Lane } from "./services/combos.ts";
import { EditorService } from "./services/editor.ts";
import { SessionService } from "./services/sessions.ts";
import { canvasColor, createMainWindow, denyAllPermissions, lockDown } from "./window.ts";

const appEnv: AppEnv = resolveAppEnv();
// this file is out/main/index.cjs, so outDir is out/ and the package root is its parent
const outDir = path.dirname(__dirname);
const packageDir = path.dirname(outDir);
const rendererDir = path.join(outDir, "renderer");
const preloadFile = path.join(outDir, "preload", "index.cjs");

// userData holds the single-instance lock and the chromium profile, so it decides which launches
// count as the same app. a test root or an unpackaged build never shares with the installed one.
const userData = userDataDirFor(appEnv, {
  isPackaged: electron.app.isPackaged,
  appData: electron.app.getPath("appData"),
  productName: electron.app.getName(),
});
if (userData) electron.app.setPath("userData", userData);

registerAppScheme();
electron.app.enableSandbox();

let win: BrowserWindow | null = null;

if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  void start();
}

async function start(): Promise<void> {
  let settings: Settings = await loadSettings(appEnv.appRoot).catch(
    () => ({ editor: "vscode" }) as Settings,
  );
  const projectsDir = resolveProjectsDir(settings);

  const queue = new OpQueue<Lane>({ mutate: 1, read: 4 });
  const pusher = new Pusher(() => win?.webContents ?? null);
  const editor = new EditorService(settings, [
    // packaged, then a checkout where `pnpm ext:package` has run
    path.join(process.resourcesPath ?? outDir, "extension"),
    path.join(packageDir, "..", "..", "extension", "dist"),
  ]);

  const sessions = new SessionService({
    projectsDir,
    cacheDir: appEnv.stateDir,
    maxParsed: settings.maxParsedSessions,
    emitPatch: (patch) =>
      pusher.send("sessions:patch", { rev: pusher.nextRev("sessions"), ...patch }),
    emitStatus: (status) => pusher.send("sessions:index", status),
  });

  const combos = new ComboService({
    appRoot: appEnv.appRoot,
    queue,
    gitPath: settings.gitPath,
    onCombosChanged: (views, problem) =>
      pusher.send("combos:changed", {
        rev: pusher.nextRev("combos"),
        combos: views,
        ...(problem ? { problem } : {}),
      }),
    onFolders: (view) =>
      pusher.send("combos:folders", {
        rev: pusher.nextRev("combos"),
        name: view.name,
        status: view.status,
        ...(view.checkedAt !== undefined ? { checkedAt: view.checkedAt } : {}),
        folders: view.folders,
      }),
    onToast: (toast) => pusher.send("toast", toast),
    onModelChanged: (list) => sessions.reattribute(list),
  });

  await electron.app.whenReady();
  // this is what macOS draws the window frame and the native menus from. the page has its own
  // copy of the setting, because nativeTheme does not reach the renderer's media queries.
  electron.nativeTheme.themeSource = settings.appearance;
  serveRenderer(rendererDir);
  denyAllPermissions();

  await combos.load();
  await sessions.loadCached(combos.list());

  registerIpc({
    env: appEnv,
    projectsDir,
    settings: () => settings,
    setSettings: (s) => {
      settings = s;
      electron.nativeTheme.themeSource = s.appearance;
    },
    sessions,
    combos,
    editor,
    pusher,
    window: () => win,
  });

  win = await createMainWindow({
    preload: preloadFile,
    stateFile: path.join(electron.app.getPath("userData"), "window-state.json"),
    url: entryUrl(appEnv.devServerUrl ?? APP_ENTRY_URL, settings.appearance),
  });
  lockDown(win.webContents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  installMenu({
    isDev: appEnv.isDev,
    send: (id: MenuCommandId) => pusher.send("menu:command", { id }),
  });

  win.on("closed", () => {
    win = null;
  });
  // work that would only slow down the first paint
  win.webContents.once("did-finish-load", () => {
    void sessions.refresh();
    sessions.start();
    combos.watchFile();
    void combos.reconcileAll();
    void editor.status(true).then((status) => pusher.send("editor:status", status));
  });
  win.on("focus", () => {
    sessions.refreshThrottled();
    combos.reconcileOnFocus();
  });
  // the page follows the media query on its own. this is only the frame behind it.
  electron.nativeTheme.on("updated", () => {
    win?.setBackgroundColor(canvasColor(electron.nativeTheme.shouldUseDarkColors));
  });
  electron.powerMonitor.on("resume", () => void sessions.refresh());

  electron.app.on("web-contents-created", (_event, contents) => {
    lockDown(contents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  });
  electron.app.on("activate", () => {
    if (win) win.show();
  });
  electron.app.on("window-all-closed", () => electron.app.quit());
  electron.app.on("before-quit", () => {
    combos.dispose();
    void sessions.dispose();
  });
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
