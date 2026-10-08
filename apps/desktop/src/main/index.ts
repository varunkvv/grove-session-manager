import path from "node:path";
import {
  loadSettings,
  projectIdOf,
  recordPrefixes,
  removeRecordRuntime,
  resolveEditor,
  type Settings,
  sessionsRegistryDir,
} from "@grove/core";
import type { BrowserWindow, MenuItemConstructorOptions, Tray } from "electron";
import * as electron from "electron";
import type { InboxView, MenuCommandId } from "../shared/ipc.ts";
import { type AppEnv, resolveAppEnv, resolveProjectsDir, userDataDirFor } from "./env.ts";
import { registerIpc } from "./ipc.ts";
import { log } from "./log.ts";
import { installMenu } from "./menu.ts";
import { OpQueue } from "./opQueue.ts";
import { APP_ENTRY_URL, entryUrl, isTrustedUrl } from "./origin.ts";
import { registerAppScheme, serveRenderer } from "./protocol.ts";
import { Pusher } from "./push.ts";
import { BackgroundService } from "./services/background.ts";
import { ComboService, type Lane } from "./services/combos.ts";
import { EditorService } from "./services/editor.ts";
import { LiveService } from "./services/live.ts";
import { LoginEnv } from "./services/loginEnv.ts";
import { Notifier } from "./services/notify.ts";
import { ProjectsService } from "./services/projects.ts";
import { RecapService } from "./services/recaps.ts";
import { resolveClaudeBin } from "./services/resumeScript.ts";
import { Reveals } from "./services/reveal.ts";
import { ReviewedService } from "./services/reviewed.ts";
import { SessionService } from "./services/sessions.ts";
import { createTray, updateTray } from "./tray.ts";
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
// a tray with no reference is collected and disappears
let tray: Tray | null = null;
let quitting = false;

/** the window, wherever it was: hidden by its close button, minimised, or behind something */
function showMain(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", showMain);
  void start();
}

async function start(): Promise<void> {
  let settings: Settings = await loadSettings(appEnv.appRoot).catch(
    () => ({ editor: "vscode" }) as Settings,
  );
  const projectsDir = resolveProjectsDir(settings);
  // for tests, and for a login item later. nothing registers one yet
  const startHidden = process.argv.includes("--hidden");

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
    onChange: () => projects.sessionsChanged(),
  });

  const reveals = new Reveals({ raise: showMain, notify: () => pusher.send("app:land", {}) });

  /** what a test root would have shown: it shows no notifications */
  const noted: Array<{ title: string; body: string; at: number }> = [];
  const notifier = new Notifier({
    enabled: () =>
      settings.notifications !== false &&
      (!!appEnv.customRoot || electron.Notification.isSupported()),
    focused: () => !!win?.isFocused(),
    create: (n) => {
      if (!appEnv.customRoot) return new electron.Notification({ ...n, silent: false });
      noted.push({ ...n, at: Date.now() });
      return { on: () => {}, show: () => {} };
    },
    land: (target) => reveals.land(target),
  });
  /**
   * a click on a notification about a session: its row, with its panel open. a session in no
   * project has no screen in grove, so it opens in the editor
   */
  const landOn = (sessionId: string) => {
    const target = projects.landing(sessionId);
    if (target) return void reveals.land(target);
    const session = sessions.byId(sessionId)[0];
    if (session) handlers.openSession(session.key).catch((e) => log.warn("open session:", e));
  };

  const live = new LiveService({
    stateDir: appEnv.stateDir,
    claudeSettingsFile: path.join(path.dirname(projectsDir), "settings.json"),
    registryDir: sessionsRegistryDir(path.dirname(projectsDir)),
    onChange: (statuses, agentRuns, alive) => {
      sessions.setLive(statuses, agentRuns, alive);
      // a session that closed while idle changes no row, and its list still has to say Closed
      projects.sessionsChanged();
    },
    onNeedsYou: (sessionId, status) => {
      const row = sessions.byId(sessionId)[0];
      if (!row) return;
      notifier.live(status, {
        sessionId,
        title: row.title,
        project: projects.projectOf(sessionId),
        click: () => landOn(sessionId),
      });
    },
    onBackgroundMoved: () => void background.read(),
    onInterrupted: (interrupted) => {
      sessions.setInterrupted(interrupted);
      projects.interruptedChanged(interrupted);
    },
  });

  // a background session keeps the environment it was dispatched with. Finder's is no good.
  const loginEnv = new LoginEnv({
    home: appEnv.home,
    base: process.env,
    claudeConfigDir: () => path.dirname(projectsDir),
    // a test root never runs anyone's rc files
    useShell: !appEnv.customRoot,
  });
  const background = new BackgroundService({
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    env: () => loginEnv.get(),
    // a test root never runs the real claude, only a stub it names
    enabled: () => !appEnv.customRoot || appEnv.claudeBinOverride !== undefined,
    onEntries: (entries) => {
      sessions.setBackground(entries);
      live.applyBackground(entries);
    },
  });

  const recaps = new RecapService({
    stateDir: appEnv.stateDir,
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    env: () => loginEnv.get(),
    // a test root never runs the real claude, only a stub it names
    enabled: () =>
      settings.recaps !== false && (!appEnv.customRoot || appEnv.claudeBinOverride !== undefined),
    // a recap reaches the page with its session's row
    onChange: () => projects.sessionsChanged(),
  });

  // packaged, or under GROVE_ROOT. a dev build next to the installed app leaves its projects, and
  // what 0.10 installed in them, alone
  const cleanRecord = electron.app.isPackaged || appEnv.customRoot;

  /** the project list as the page has it. sent only when something in it moved */
  let sentProjects = "";
  const pushProjects = () => {
    const { projects: list, problem } = projects.views();
    const json = JSON.stringify([list, problem]);
    if (json === sentProjects) return;
    sentProjects = json;
    pusher.send("projects:changed", {
      rev: pusher.nextRev("projects"),
      projects: list,
      ...(problem ? { problem } : {}),
    });
  };

  // projects.start() takes the stopped baseline, so nothing calls it before live.start() is through
  let started = false;

  const combos = new ComboService({
    appRoot: appEnv.appRoot,
    cleanRecord,
    onSynced: (combo, report) => {
      if (report.cleaned.length) {
        log.info(`took 0.10's record out of ${combo.name}:`, report.cleaned.join(", "));
      }
      // a file grove could not write
      pushProjects();
    },
    queue,
    gitPath: settings.gitPath,
    onCombosChanged: pushProjects,
    onFolders: (view) =>
      pusher.send("projects:folders", {
        rev: pusher.nextRev("projects"),
        id: projectIdOf(view),
        status: view.status,
        ...(view.checkedAt !== undefined ? { checkedAt: view.checkedAt } : {}),
        folders: view.folders,
      }),
    onToast: (toast) => pusher.send("toast", toast),
    onModelChanged: (list) => {
      sessions.reattribute(list);
      if (started) projects.start();
    },
  });

  const reviewed = new ReviewedService(appEnv.appRoot);

  /** the last tray menu and title. kept so a test root can read and click them with no tray */
  let trayMenu: MenuItemConstructorOptions[] = [];
  let trayTitle = "";
  const showInbox = (inbox: InboxView) => {
    trayMenu = updateTray(tray, inbox, { land: (target) => void reveals.land(target), showMain });
    trayTitle = inbox.rows.length > 0 ? String(inbox.rows.length) : "";
    electron.app.dock?.setBadge(trayTitle);
  };

  const projects = new ProjectsService({
    combos,
    sessions,
    live,
    reviewed,
    recaps,
    onInbox: (inbox) => {
      pusher.send("inbox:changed", { ...inbox, rev: pusher.nextRev("inbox") });
      showInbox(inbox);
    },
    onSessions: () => pusher.send("sessions:changed", {}),
    onStopped: (s) => notifier.stopped({ ...s, click: () => landOn(s.sessionId) }),
  });

  // a test root lands the way a notification click or a tray row does, with neither to click
  if (appEnv.customRoot) {
    (globalThis as { groveTest?: unknown }).groveTest = {
      reveal: (sessionId: string) => landOn(sessionId),
      trayTitle: () => trayTitle,
      trayMenu: () =>
        trayMenu.map(({ label, sublabel, enabled, role }) => ({ label, sublabel, enabled, role })),
      trayClick: (i: number) => (trayMenu[i]?.click as (() => void) | undefined)?.(),
      closeMain: () => win?.close(),
      isMainVisible: () => !!win?.isVisible(),
      notifications: () => noted,
    };
  }

  const menu = (editorLabel: string) =>
    installMenu({
      isDev: appEnv.isDev,
      editorLabel,
      send: (id: MenuCommandId) => pusher.send("menu:command", { id }),
    });

  await electron.app.whenReady();
  // this is what macOS draws the window frame and the native menus from. the page has its own
  // copy of the setting, because nativeTheme does not reach the renderer's media queries.
  electron.nativeTheme.themeSource = settings.appearance;
  serveRenderer(rendererDir);
  denyAllPermissions();

  await combos.load();
  if (cleanRecord) {
    const gone = await removeRecordRuntime(appEnv.appRoot);
    if (gone.length) log.info("removed 0.10's record runtime:", gone.join(", "));
  }
  // what was dismissed under 0.10 is filed under each project's card prefix: it moves to its id
  await reviewed.load(cleanRecord ? await recordPrefixes(combos.list()) : undefined);
  await recaps.load();
  await sessions.loadCached(combos.list());

  const handlers = registerIpc({
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
      // File > Open Project in {editor} names it
      if (s.editor !== settings.editor) menu(resolveEditor(s).label);
      const recapsMoved = (s.recaps !== false) !== (settings.recaps !== false);
      settings = s;
      if (recapsMoved) projects.recapsSwitched();
      electron.nativeTheme.themeSource = s.appearance;
    },
    sessions,
    live,
    combos,
    projects,
    recaps,
    background,
    reveals,
    notifier,
    editor,
    pusher,
    window: () => win,
  });

  win = await createMainWindow({
    preload: preloadFile,
    stateFile: path.join(electron.app.getPath("userData"), "window-state.json"),
    fixedSize: !!appEnv.customRoot,
    url: entryUrl(appEnv.devServerUrl ?? APP_ENTRY_URL, settings.appearance),
    show: !startHidden,
  });
  lockDown(win.webContents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  menu(editor.current().label);
  // no tray under a test root unless the test asks: its menu is still built, for groveTest
  if (!appEnv.customRoot || process.env.GROVE_TRAY === "1") tray = createTray();
  showInbox(projects.inbox());

  // the close button hides: the app lives in the menu bar until it is quit
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  // work that would only slow down the first paint. it fires for a hidden window too
  win.webContents.once("did-finish-load", () => {
    void sessions.refresh();
    sessions.start();
    combos.watchFile();
    void combos.reconcileAll();
    void editor.status(true).then((status) => pusher.send("editor:status", status));
    void (async () => {
      await live.start().catch((e) => log.warn("session status:", e));
      // stopped and finished background sessions have no process, so the registry never says
      void background.read();
      // combos made before status tracking get it without anyone opening them
      await combos.syncAll();
      // after live.start(), never beside it: the interruptions it found are the baseline, so
      // what stopped while the app was closed shows in the inbox and does not notify
      projects.start();
      started = true;
    })();
    if (settings.trackAllSessions) void live.trackAllSessions(true).catch((e) => log.warn(e));
  });
  win.on("focus", () => {
    sessions.refreshThrottled();
    combos.reconcileOnFocus();
    // catches a settings file a session put back while the app was closed. the watch has the rest.
    void combos.syncAll();
    void live.syncUserHooks();
    void background.read();
  });
  // the page follows the media query on its own. this is only the frame behind it.
  electron.nativeTheme.on("updated", () => {
    win?.setBackgroundColor(canvasColor(electron.nativeTheme.shouldUseDarkColors));
  });
  electron.powerMonitor.on("resume", () => void sessions.refresh());

  electron.app.on("web-contents-created", (_event, contents) => {
    lockDown(contents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  });
  electron.app.on("activate", showMain);
  // only while quitting now: the close button hides the window
  electron.app.on("window-all-closed", () => electron.app.quit());
  electron.app.on("before-quit", () => {
    quitting = true;
    combos.dispose();
    live.dispose();
    projects.dispose();
    void sessions.dispose();
  });
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
