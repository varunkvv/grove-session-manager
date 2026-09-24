import path from "node:path";
import {
  formatDuration,
  type LiveStatus,
  loadSettings,
  needsYou,
  type Settings,
  sessionsRegistryDir,
  stripLaunchEnv,
} from "@grove/core";
import type { BrowserWindow } from "electron";
import * as electron from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";
import { type AppEnv, resolveAppEnv, resolveProjectsDir, userDataDirFor } from "./env.ts";
import { type AppHandlers, registerIpc } from "./ipc.ts";
import { log } from "./log.ts";
import { installMenu } from "./menu.ts";
import { OpQueue } from "./opQueue.ts";
import { APP_ENTRY_URL, entryUrl, isTrustedUrl } from "./origin.ts";
import { registerAppScheme, serveRenderer } from "./protocol.ts";
import { Pusher } from "./push.ts";
import { AgentInspector } from "./services/agentInspector.ts";
import { AgentSummaries } from "./services/agentSummaries.ts";
import { ArchiveService } from "./services/archive.ts";
import { BackgroundService } from "./services/background.ts";
import { ComboService, type Lane } from "./services/combos.ts";
import { EditorService } from "./services/editor.ts";
import { LiveService } from "./services/live.ts";
import { resolveClaudeBin } from "./services/resumeScript.ts";
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

  let summaries: AgentSummaries | null = null;
  const sessions = new SessionService({
    projectsDir,
    cacheDir: appEnv.stateDir,
    maxParsed: settings.maxParsedSessions,
    emitPatch: (patch) =>
      pusher.send("sessions:patch", { rev: pusher.nextRev("sessions"), ...patch }),
    emitStatus: (status) => pusher.send("sessions:index", status),
    onAgents: (key, snapshot) => summaries?.note(key, snapshot),
  });
  const inspector = new AgentInspector({
    stateDir: appEnv.stateDir,
    snapshot: (key) => sessions.agentSnapshot(key),
    onSteps: (steps) => pusher.send("agent:steps", steps),
  });
  const archive = new ArchiveService({
    appRoot: appEnv.appRoot,
    onChange: (ids) => sessions.setArchived(ids),
  });
  summaries = new AgentSummaries({
    stateDir: appEnv.stateDir,
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    // a test root never spends anyone's Claude auth
    enabled: () => settings.agentSummaries !== false && !appEnv.customRoot,
    visible: () => !!win && win.isVisible() && !win.isMinimized(),
    onSummary: (key, id, summary, at) => sessions.applySummary(key, id, summary, at),
    onFound: (key, id, line) => sessions.applyFound(key, id, line),
  });

  let handlers: AppHandlers | null = null;
  const live = new LiveService({
    stateDir: appEnv.stateDir,
    claudeSettingsFile: path.join(path.dirname(projectsDir), "settings.json"),
    registryDir: sessionsRegistryDir(path.dirname(projectsDir)),
    onChange: (statuses, agentRuns, alive) => {
      sessions.setLive(statuses, agentRuns, alive);
      const count = [...statuses.values()].filter((s) => needsYou(s)).length;
      electron.app.dock?.setBadge(count > 0 ? String(count) : "");
    },
    onNeedsYou: (sessionId, status) => {
      if (settings.notifications === false || appEnv.customRoot) return;
      if (win?.isFocused()) return;
      const row = sessions.byId(sessionId)[0];
      const body = notificationBody(status);
      if (!row || !body || !electron.Notification.isSupported()) return;
      const n = new electron.Notification({
        title: row.title ?? "Claude session",
        body,
        silent: false,
      });
      const toApp = () => {
        win?.show();
        win?.focus();
      };
      n.on("click", () => {
        // the supervisor holds it: an editor's resume would be refused. the app has the way in.
        if (sessions.byId(sessionId)[0]?.background?.held) return toApp();
        // the folder may be gone by now. then the app is the next best place to land.
        void handlers
          ?.runSessionAction(row.key, row.comboName ? "combo-land" : "folder-land")
          .catch(toApp);
      });
      n.show();
    },
    onBackgroundMoved: () => void background.read(),
  });

  const background = new BackgroundService({
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    env: async () => stripLaunchEnv(process.env),
    // a test root never runs the real claude, only a stub it names
    enabled: () => !appEnv.customRoot || appEnv.claudeBinOverride !== undefined,
    onEntries: (entries) => {
      sessions.setBackground(entries);
      live.applyBackground(entries);
    },
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
  await archive.load();
  await sessions.loadCached(combos.list());

  handlers = registerIpc({
    env: appEnv,
    projectsDir,
    settings: () => settings,
    setSettings: (s) => {
      const tracking = s.trackAllSessions === true;
      if (tracking !== (settings.trackAllSessions === true)) {
        void live
          .trackAllSessions(tracking)
          .catch((e) =>
            pusher.send("toast", { level: "error", title: "Session status", body: String(e) }),
          );
      }
      settings = s;
      electron.nativeTheme.themeSource = s.appearance;
    },
    sessions,
    live,
    combos,
    archive,
    inspector,
    seen: (key, ids) => {
      const snapshot = sessions.agentSnapshot(key);
      for (const id of ids) {
        const agent = snapshot?.agents.find((a) => a.id === id);
        if (agent) void summaries?.seen(key, agent, snapshot?.reads[id]);
      }
    },
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
    void live
      .start()
      .catch((e) => log.warn("session status:", e))
      // stopped and finished background sessions have no process, so the registry never says
      .then(() => background.read());
    // combos made before status tracking existed get their hooks without anyone opening them
    void combos.syncStatusHooks();
    if (settings.trackAllSessions) void live.trackAllSessions(true).catch((e) => log.warn(e));
  });
  win.on("focus", () => {
    sessions.refreshThrottled();
    combos.reconcileOnFocus();
    // catches a settings file a session put back while the app was closed. the watch has the rest.
    void combos.syncStatusHooks();
    void live.syncUserHooks();
    void background.read();
  });
  // nothing is summarised while the window is hidden, so coming back has to ask for it
  const wake = () => summaries?.wake();
  win.on("show", wake);
  win.on("restore", wake);
  win.on("focus", wake);
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
    live.dispose();
    inspector.dispose();
    summaries?.dispose();
    void sessions.dispose();
  });
}

/** only what is worth interrupting someone for. a short turn they are probably watching is not. */
function notificationBody(s: LiveStatus): string | null {
  if (s.state === "permission")
    return s.detail ? `Needs permission: ${s.detail}` : "Needs permission";
  if (s.state === "failed") return "Stopped on an API error";
  if (s.state === "waiting" && (s.turnMs ?? 0) >= 60_000) {
    const after = `Finished after ${formatDuration(s.turnMs ?? 0)}`;
    return s.detail ? `${after}: ${s.detail}` : after;
  }
  return null;
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
