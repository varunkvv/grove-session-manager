import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL,
  GAVEL,
  loadSettings,
  modelUrl,
  needing,
  pendingTitlesDir,
  projectIdOf,
  recordPrefixes,
  removeRecordRuntime,
  resolveEditor,
  type Settings,
  saveSettings,
  sessionsRegistryDir,
  stepTextScale,
  wantsModel,
} from "@grove/core";
import type { BrowserWindow, MenuItemConstructorOptions, Tray } from "electron";
import * as electron from "electron";
import type { FromScorer } from "../scorer/protocol.ts";
import { DEFAULT_SUMMON_KEY, type MenuCommandId } from "../shared/ipc.ts";
import { ChatWindows } from "./chatWindows.ts";
import { CHIME, installChime } from "./chime.ts";
import { type AppEnv, resolveAppEnv, resolveProjectsDir, userDataDirFor } from "./env.ts";
import { chatRoots, type FreshChats, registerIpc } from "./ipc.ts";
import { keepAwake, leftRunningCount, runningCount, watchingCount, working } from "./keepAwake.ts";
import { log } from "./log.ts";
import { installMenu } from "./menu.ts";
import type { TrayView } from "./menuTemplate.ts";
import { OpQueue } from "./opQueue.ts";
import { APP_ENTRY_URL, entryUrl, isTrustedUrl } from "./origin.ts";
import { registerAppScheme, serveRenderer, serveSessionFiles } from "./protocol.ts";
import { Pusher } from "./push.ts";
import { BackgroundService } from "./services/background.ts";
import { ChatHost } from "./services/chat.ts";
import { ComboService, type Lane } from "./services/combos.ts";
import { DecisioningService, decisioningSetup } from "./services/decisioning.ts";
import { EditorService } from "./services/editor.ts";
import { LiveService } from "./services/live.ts";
import { LoginEnv } from "./services/loginEnv.ts";
import { Notifier, toldTurn } from "./services/notify.ts";
import { ProjectsService } from "./services/projects.ts";
import { PrService, resolveGhBin } from "./services/prs.ts";
import { RecapService, Slots } from "./services/recaps.ts";
import { resolveClaudeBin } from "./services/resumeScript.ts";
import { Reveals } from "./services/reveal.ts";
import { ReviewedService } from "./services/reviewed.ts";
import { SessionService } from "./services/sessions.ts";
import { TitleService } from "./services/titles.ts";
import { sweepUploads } from "./services/uploads.ts";
import { createTray, updateTray } from "./tray.ts";
import { createMainWindow, denyAllPermissions, lockDown } from "./window.ts";

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
/** a PR on a row quiet longer than this is not asked about */
const PR_RECENT_MS = 7 * 24 * 60 * 60_000;
/** the chat window a notification or tray click just opened, and when */
let landed: { sessionId: string; at: number } | null = null;
/** how long after a landing an `activate` is taken to be the same click's */
const LANDED_MS = 2000;
// a tray with no reference is collected and disappears
let tray: Tray | null = null;
let quitting = false;
/** the person said yes to quitting with chats mid-turn */
let quitConfirmed = false;
/** under a test root, the quits that would have asked */
let quitAsks = 0;

/** the window, wherever it was: hidden by its close button, minimised, or behind something */
function showMain(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** the summon key grove holds now, if any */
let summoned: string | null = null;

/** the key that brings grove forward from any app: grove chat's, unless the person switched it off */
const summonKeyOf = (s: Settings): string | null =>
  s.chat !== true || s.summonKey === "none" ? null : (s.summonKey ?? DEFAULT_SUMMON_KEY);

/** from another app: grove is made the active app, and its window comes forward */
function summonMain(): void {
  electron.app.focus({ steal: true });
  showMain();
}

/** holds the settings' summon key, and lets go of the one before. a test root takes no key from the desk */
function summon(s: Settings): void {
  const key = summonKeyOf(s);
  if (key === summoned) return;
  if (summoned) electron.globalShortcut.unregister(summoned);
  summoned = null;
  if (!key || appEnv.customRoot) return;
  try {
    if (electron.globalShortcut.register(key, summonMain)) summoned = key;
    else log.warn(`summon key ${key}: another app has it`);
  } catch (e) {
    log.warn(`summon key ${key}:`, e);
  }
}

/** why grove cannot have this key, or null when it can */
function summonProblem(key: string): string | null {
  if (key === summoned || appEnv.customRoot) return null;
  try {
    if (!electron.globalShortcut.register(key, () => {})) return "Another app has that key.";
    electron.globalShortcut.unregister(key);
    return null;
  } catch {
    return "That is not a key Grove can listen for.";
  }
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
  const editor = new EditorService(
    settings,
    [
      // packaged, then a checkout where `pnpm ext:package` has run
      path.join(process.resourcesPath ?? outDir, "extension"),
      path.join(packageDir, "..", "..", "extension", "dist"),
    ],
    // zed's agent: packaged, then this build's own
    [
      path.join(process.resourcesPath ?? outDir, "acp-proxy", "grove-acp.cjs"),
      path.join(outDir, "acp-proxy", "grove-acp.cjs"),
    ].find((f) => existsSync(f)) ?? null,
    appEnv.appRoot,
    // the Grove binary when packaged, electron's in a checkout. zed runs the proxy with it
    process.execPath,
  );

  /** recaps, titles and descriptions are written: the switch, and a claude this may run */
  const writing = () =>
    settings.recaps !== false && (!appEnv.customRoot || appEnv.claudeBinOverride !== undefined);
  // the calls through the person's own login: two at a time, recaps first
  const slots = new Slots();
  const titles = new TitleService({
    stateDir: appEnv.stateDir,
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    env: () => loginEnv.get(),
    // a test root never runs the real claude, only a stub it names
    enabled: writing,
    renames: () => settings.renameSessions !== false,
    // a name reaches the page with its session's row
    onChange: () => sessions.retitle(),
    slots,
    row: (key) => sessions.get(key),
  });

  // made once loginEnv is: a row is built before then, with no PR status yet
  let prs: PrService | undefined;
  const sessions = new SessionService({
    projectsDir,
    cacheDir: appEnv.stateDir,
    maxParsed: settings.maxParsedSessions,
    onChange: () => {
      projects.sessionsChanged();
      prs?.poke();
    },
    named: (record) => titles.named(record),
    prStatus: (url) => prs?.get(url),
  });

  const reveals = new Reveals({ raise: showMain, notify: () => pusher.send("app:land", {}) });

  // a test root shows no notifications, so it has no sound to put in the person's Library
  if (!appEnv.customRoot && process.platform === "darwin") {
    void installChime(appEnv.home).catch((e) => log.warn("chime:", e));
  }
  /** what a test root would have shown: it shows no notifications */
  const noted: Array<{ title: string; body: string; at: number }> = [];
  const notifier = new Notifier({
    enabled: () =>
      settings.notifications !== false &&
      (!!appEnv.customRoot || electron.Notification.isSupported()),
    focused: () => !!win?.isFocused(),
    watching: (sessionId) => chatWindows.focusedSession() === sessionId,
    create: (n) => {
      // grove's own chime in place of the macOS default. macOS still decides whether it sounds
      if (!appEnv.customRoot) {
        return new electron.Notification({ ...n, silent: false, sound: CHIME });
      }
      noted.push({ ...n, at: Date.now() });
      return { on: () => {}, show: () => {} };
    },
    land: (target) => reveals.land(target),
  });
  /**
   * a click on a notification about a session: its row, with its panel open. a session in no
   * project has no screen in grove, so it opens in the editor. landing marks nothing seen
   */
  const landOn = (sessionId: string) => {
    // grove chat: the session's own window, which is where it is talked to
    if (settings.chat === true && sessions.byId(sessionId)[0]) {
      landed = { sessionId, at: Date.now() };
      return chatWindows.open(sessionId);
    }
    const target = projects.landing(sessionId);
    if (target) return void reveals.land(target);
    const session = sessions.byId(sessionId)[0];
    if (session) handlers.openSession(session.key).catch((e) => log.warn("open session:", e));
  };

  const awake = keepAwake(electron.powerSaveBlocker);
  const live = new LiveService({
    stateDir: appEnv.stateDir,
    claudeSettingsFile: path.join(path.dirname(projectsDir), "settings.json"),
    registryDir: sessionsRegistryDir(path.dirname(projectsDir)),
    // the title hook goes in beside the status hooks while both switches are on
    titles: () =>
      settings.recaps !== false && settings.renameSessions !== false
        ? pendingTitlesDir(appEnv.stateDir)
        : undefined,
    onChange: (statuses, agentRuns, alive, tasks) => {
      sessions.setLive(statuses, agentRuns, alive, tasks);
      // a session that closed while idle changes no row, and its list still has to say Closed
      projects.sessionsChanged();
      const { running, watchers, left } = holding();
      awake.set(settings.keepAwake !== false && running + left > 0);
      // one with no transcript yet moves no list, and the menu bar still counts it
      if (
        running !== trayView?.running ||
        watchers !== trayView.watchers ||
        awake.since() !== trayView.awakeSince
      ) {
        showTray();
      }
    },
    onNeedsYou: (sessionId, status) => {
      const row = sessions.byId(sessionId)[0];
      if (!row) return;
      const note = (needs?: string) =>
        notifier.live(status, {
          sessionId,
          title: row.title,
          project: projects.projectOf(sessionId),
          needs,
          click: () => landOn(sessionId),
        });
      // a permission prompt and a failure are told at once. so is a turn too short to notify of
      if (!toldTurn(status)) return note();
      // a long turn's end, or a wake-up's, waits a moment for its recap: what is asked of the
      // person says more than the start of the last message
      void recaps.soon(row).then((needs) => {
        // answered, dismissed or moved on while it waited. one claude's own turn keeps is still it
        const now = needing(live.list().get(sessionId));
        if (now?.state === status.state && now.at === status.at) note(needs);
      });
    },
    onBackgroundMoved: () => void background.read(),
    onInterrupted: (interrupted) => {
      sessions.setInterrupted(interrupted);
      projects.interruptedChanged(interrupted);
    },
  });

  /**
   * what keeps the mac awake: the turns in flight or ended with a background agent at work, and
   * the sessions between turns that left a command or a wake-up running. `watchers` is the ones
   * the lists show, a minute in
   */
  const holding = (now = Date.now()) => ({
    running: runningCount(live.list(), now),
    watchers: watchingCount(live.tasks(), live.list(), now),
    left: leftRunningCount(live.tasks(), live.list(), now),
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

  prs = new PrService({
    stateFile: path.join(appEnv.stateDir, "prs.json"),
    ghBin: () => resolveGhBin(appEnv.ghBinOverride),
    env: () => loginEnv.get(),
    // a test root never runs the real gh, only a stub it names
    enabled: () => !appEnv.customRoot || appEnv.ghBinOverride !== undefined,
    visible: () =>
      electron.BrowserWindow.getAllWindows().some((w) => w.isVisible() && !w.isMinimized()),
    // open rows only: live, or active in the last week. a PR never moves a row
    wanted: () => {
      const now = Date.now();
      return sessions
        .list()
        .filter((r) => r.prs && (r.live || now - r.activityMs < PR_RECENT_MS))
        .flatMap((r) => {
          const busy = working(r.live, now);
          return (r.prs ?? []).map((p) => ({ url: p.url, working: busy }));
        });
    },
    onChange: () => sessions.prsChanged(),
  });
  const prService = prs;
  void prService.load().then(() => {
    sessions.prsChanged();
    prService.kick();
  });

  const recaps = new RecapService({
    stateDir: appEnv.stateDir,
    claudeBin: () => resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath),
    env: () => loginEnv.get(),
    enabled: writing,
    // a recap reaches the page with its session's row
    onChange: () => projects.sessionsChanged(),
    slots,
  });

  // grove chat. nothing of it runs, and the sdk is not even loaded, until a chat window sends
  // what is attached in it is kept here, a folder per session, until the session's transcript goes
  const uploads = path.join(electron.app.getPath("userData"), "uploads");
  void sweepUploads(uploads, projectsDir)
    .then((gone) => gone.length && log.info(`removed the uploads of ${gone.length} gone sessions`))
    .catch((e) => log.warn("uploads sweep:", e));
  const chat = new ChatHost({
    claudeBin: async () => {
      // a test root never runs the real claude, only a stub it names
      if (appEnv.customRoot && appEnv.claudeBinOverride === undefined) {
        throw new Error("A test root runs no claude but the one GROVE_CLAUDE_BIN names.");
      }
      return resolveClaudeBin(appEnv.home, appEnv.claudeBinOverride ?? settings.claudePath);
    },
    env: () => loginEnv.get(),
    uploads,
    // where a session runs moved: its rows say Grove, or no longer do
    onChange: () => projects.sessionsChanged(),
    claudeSettings: path.join(path.dirname(projectsDir), "settings.json"),
    // /clear: a new session in the same window, made as cmd-N makes one, until its transcript lands
    onReset: (from, to, where) => {
      const project = fresh.get(from)?.project ?? projects.hitFor(from)?.project;
      fresh.delete(from);
      fresh.set(to, { ...(project ? { project } : {}), where });
      chatWindows.rekey(from, to);
    },
    // the main window's session card: what it waits on and what it is doing, never its tokens
    onStatus: (sessionId, status) => pusher.send("chat:host", { sessionId, status }),
    // on quit this runs before live.dispose(), which writes the flag out with the rest
    letGo: (ids) => live.letGo(ids),
    // a dialog or an MCP server's form: no hook says it, so the host does
    onCard: (id, asks) => live.card(id, asks),
  });
  /** sessions grove chat made, until their transcript is in the list */
  const fresh: FreshChats = new Map();
  const chatWindows = new ChatWindows({
    preload: preloadFile,
    url: () =>
      entryUrl(
        appEnv.devServerUrl ?? APP_ENTRY_URL,
        settings.appearance,
        settings.palette,
        settings.textScale,
      ),
    palette: () => settings.palette,
    textScale: () => settings.textScale,
    attach: (id, contents) => chat.attach(id, contents),
    detach: (id, contents) => chat.detach(id, contents),
    fixedSize: !!appEnv.customRoot,
    stateFile: path.join(electron.app.getPath("userData"), "chat-window-state.json"),
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

  // decisioning (beta): judgment day odds. a test root never downloads or loads a real model: it
  // judges with the keyword stub, and fetches only from the stand-in server GROVE_MODEL_URL names
  /** under a test root, how many scorer processes started: none while the switch is off */
  let scorerSpawns = 0;
  const decided = decisioningSetup({
    env: process.env,
    customRoot: appEnv.customRoot,
    stateDir: appEnv.stateDir,
    appData: electron.app.getPath("appData"),
    model: DEFAULT_MODEL,
    url: modelUrl(DEFAULT_MODEL),
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    totalMemory: os.totalmem(),
  });
  const decisioning = new DecisioningService({
    ...decided,
    rubric: GAVEL,
    enabled: () => wantsModel(settings),
    transcripts: () => sessions.transcripts(),
    onBattery: () =>
      appEnv.customRoot
        ? process.env.GROVE_ON_BATTERY === "1"
        : electron.powerMonitor.isOnBatteryPower(),
    busy: () => sessions.usageCounting(),
    spawn: () => {
      scorerSpawns += 1;
      return electron.utilityProcess.fork(path.join(outDir, "scorer", "index.cjs"), [], {
        serviceName: "Grove scorer",
      });
    },
    fetch: (url, init) => electron.net.fetch(url, init),
    onStatus: (s) => pusher.send("decisioning:status", s),
  });

  /** the last tray menu and title. kept so a test root can read and click them with no tray */
  let trayMenu: MenuItemConstructorOptions[] = [];
  let trayTitle = "";
  /** what the menu bar was last drawn from */
  let trayView: TrayView | undefined;
  let drawing = false;
  const showTray = () => {
    // reading the inbox can finish a compute, which calls back here. the outer call draws it
    if (drawing) return;
    drawing = true;
    try {
      const listed = projects.listSessions(null);
      const now = Date.now();
      // by the status, as the counts are: a turn that ended with an agent at work is working
      const busy = (id: string) => working(live.list().get(id), now);
      trayView = {
        inbox: projects.inbox(),
        working: listed.filter((s) => busy(s.sessionId)),
        watching: listed.filter((s) => !busy(s.sessionId) && s.tasks?.length),
        ...holding(now),
        awakeSince: awake.since(),
        keepAwake: settings.keepAwake !== false,
        now,
      };
    } finally {
      drawing = false;
    }
    trayMenu = updateTray(tray, trayView, {
      land: (target) => void reveals.land(target),
      open: landOn,
      showMain,
    });
    trayTitle = trayView.inbox.rows.length > 0 ? String(trayView.inbox.rows.length) : "";
    electron.app.dock?.setBadge(trayTitle);
  };
  // "for 12m" is only as fresh as the menu's last build
  const trayTick = setInterval(() => {
    if (!trayView?.running && !trayView?.watchers) return;
    // a background agent that went quiet lets go of the mac with no event to say so
    const { running, left } = holding();
    awake.set(settings.keepAwake !== false && running + left > 0);
    showTray();
  }, 60_000);
  trayTick.unref();

  const projects = new ProjectsService({
    combos,
    sessions,
    live,
    reviewed,
    recaps,
    titles,
    chat,
    onInbox: (inbox) => {
      pusher.send("inbox:changed", { ...inbox, rev: pusher.nextRev("inbox") });
      showTray();
    },
    // a session started or stopped working, or was renamed
    onSessions: () => {
      pusher.send("sessions:changed", {});
      // a transcript grew: a new prompt to judge, maybe
      decisioning.kick();
      showTray();
      // a session made in grove chat is in the list now: its window shows it as any other
      for (const id of fresh.keys()) {
        if (!sessions.byId(id)[0]) continue;
        fresh.delete(id);
        chatWindows.reload(id);
      }
      // grove named one that has a window open: its header says so
      for (const id of chatWindows.windows()) {
        const hit = projects.hitFor(id);
        if (hit) chatWindows.named(hit);
      }
    },
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
      /** how many busy chats a quit would have asked about */
      quitAsks: () => quitAsks,
      /** the key a summon would be held on, and the summon itself: a test root holds no key */
      summonKey: () => summonKeyOf(settings),
      summon: summonMain,
      /** decisioning's scorer: how many processes started, and whether one runs now */
      scorer: () => ({ spawned: scorerSpawns, running: decisioning.scorerRunning }),
      /** the packaged app's check: the scorer's process starts and its native runtime loads. no model */
      probeScorer: () =>
        new Promise<FromScorer>((resolve) => {
          const child = electron.utilityProcess.fork(path.join(outDir, "scorer", "index.cjs"));
          const done = (m: FromScorer) => {
            clearTimeout(timer);
            child.kill();
            resolve(m);
          };
          const timer = setTimeout(
            () => done({ type: "probed", gpu: false, error: "no answer in 60s" }),
            60_000,
          );
          child.on("message", (m: FromScorer) => {
            if (m.type === "probed") done(m);
          });
          child.postMessage({ type: "probe" });
        }),
    };
  }

  const menu = (editorLabel: string) =>
    installMenu({
      isDev: appEnv.isDev,
      editorLabel,
      chat: settings.chat === true,
      send: (id: MenuCommandId) => {
        const from = chatWindows.focusedSession();
        // cmd-N in a chat window: a new session in that one's project, and the main window stays
        // where it is
        const project = from && (projects.projectOf(from) ?? fresh.get(from)?.project);
        if (id === "new-chat" && project) {
          handlers.newChat(project).catch((e) => log.warn("new chat:", e));
          return;
        }
        // ⌘F finds where it was pressed: a chat window looks in its own conversation
        if (from && id === "focus-search") {
          chatWindows.find(from);
          return;
        }
        // the menu's commands are the main window's: from a chat window they bring it forward
        if (from && id !== "new-chat") showMain();
        pusher.send("menu:command", { id });
      },
      textSize: (dir) => void textSize(dir).catch((e) => log.warn("text size:", e)),
    });

  let sizing = Promise.resolve();
  /**
   * the Text size setting a step bigger, smaller or back to 100, saved as Settings would save it.
   * every window follows. at either end nothing happens.
   * one after another, so a held key never skips a step
   */
  const textSize = (dir: -1 | 0 | 1): Promise<void> => {
    const step = async () => {
      const now = settings.textScale ?? 100;
      const next = stepTextScale(now, dir);
      if (next === now) return;
      const saved = await saveSettings(appEnv.appRoot, {
        textScale: next === 100 ? undefined : next,
      });
      applySettings(saved);
    };
    const done = sizing.then(step);
    sizing = done.catch(() => {});
    return done;
  };

  await electron.app.whenReady();
  // this is what macOS draws the window frame and the native menus from. the page has its own
  // copy of the setting, because nativeTheme does not reach the renderer's media queries.
  electron.nativeTheme.themeSource = settings.appearance;
  serveRenderer(rendererDir);
  serveSessionFiles((id) => chatRoots({ sessions, combos, chatWindows, fresh, chat }, id));
  denyAllPermissions();

  await combos.load();
  if (cleanRecord) {
    const gone = await removeRecordRuntime(appEnv.appRoot);
    if (gone.length) log.info("removed 0.10's record runtime:", gone.join(", "));
  }
  // what was dismissed under 0.10 is filed under each project's card prefix: it moves to its id
  await reviewed.load(cleanRecord ? await recordPrefixes(combos.list()) : undefined);
  await recaps.load();
  await titles.load();
  await sessions.loadCached(combos.list());

  /** settings saved, from the dialog or a key: everything that hangs off one moves with it */
  const applySettings = (s: Settings) => {
    const tracking = s.trackAllSessions === true;
    if (tracking !== (settings.trackAllSessions === true)) {
      void live
        .trackAllSessions(tracking)
        .catch((e) =>
          pusher.send("toast", { level: "error", title: "Session status", body: String(e) }),
        );
    }
    // File > Open Project in {editor} names it, and grove chat's switch moves cmd-N
    const menuMoved =
      s.editor !== settings.editor || (s.chat === true) !== (settings.chat === true);
    const recapsMoved = (s.recaps !== false) !== (settings.recaps !== false);
    const renamesMoved = (s.renameSessions !== false) !== (settings.renameSessions !== false);
    const chatMoved = (s.chat === true) !== (settings.chat === true);
    const decisioningMoved = wantsModel(s) !== wantsModel(settings);
    const lookMoved =
      s.appearance !== settings.appearance ||
      s.palette !== settings.palette ||
      s.textScale !== settings.textScale;
    settings = s;
    if (menuMoved) menu(resolveEditor(s).label);
    summon(s);
    // the spare chat window is there only while grove chat is on, and in the page's appearance and
    // text size. an open chat window draws in them too
    if (chatMoved) chatWindows.setSpare(s.chat === true);
    // the main window has no frame colour to repaint: it is the desktop's material, and the page
    // paints the rest
    if (lookMoved) chatWindows.appearance(s.appearance);
    if (decisioningMoved) decisioning.switched(wantsModel(s));
    if (recapsMoved) projects.recapsSwitched();
    if (recapsMoved || renamesMoved) {
      sessions.retitle();
      // the title hook in or out of every file grove manages, and nothing left pending when out
      void titles.switched();
      void combos.syncAll();
      void live.syncUserHooks();
    }
    const { running, left } = holding();
    awake.set(s.keepAwake !== false && running + left > 0);
    showTray();
    electron.nativeTheme.themeSource = s.appearance;
    // the main window's store has what was saved, from wherever it was saved (a key, a chat window)
    pusher.send("settings:changed", s);
  };

  const handlers = registerIpc({
    env: appEnv,
    projectsDir,
    settings: () => settings,
    setSettings: applySettings,
    textSize,
    sessions,
    live,
    combos,
    projects,
    recaps,
    decisioning,
    background,
    prs: prService,
    reveals,
    notifier,
    editor,
    shellEnv: () => loginEnv.fresh(),
    pusher,
    window: () => win,
    showMain,
    chat,
    chatWindows,
    fresh,
    summonProblem,
  });

  win = await createMainWindow({
    preload: preloadFile,
    stateFile: path.join(electron.app.getPath("userData"), "window-state.json"),
    fixedSize: !!appEnv.customRoot,
    url: entryUrl(
      appEnv.devServerUrl ?? APP_ENTRY_URL,
      settings.appearance,
      settings.palette,
      settings.textScale,
    ),
    show: !startHidden,
  });
  lockDown(win.webContents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  menu(editor.current().label);
  // no tray under a test root unless the test asks: its menu is still built, for groveTest
  if (!appEnv.customRoot || process.env.GROVE_TRAY === "1") tray = createTray();
  showTray();

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
    // after the main window, which has to be the first window there is
    chatWindows.setSpare(settings.chat === true);
    void sessions.refresh();
    sessions.start();
    combos.watchFile();
    void combos.reconcileAll();
    void editor.status(true).then((status) => pusher.send("editor:status", status));
    void decisioning.load().catch((e) => log.warn("decisioning:", e));
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
    prService.kick();
  });
  // the page follows the media query on its own. this is only the frame behind a chat window's
  electron.nativeTheme.on("updated", () => chatWindows.repaint());
  summon(settings);
  electron.powerMonitor.on("resume", () => {
    void sessions.refresh();
    prService.kick();
  });
  // the backfill waits for AC power
  electron.powerMonitor.on("on-ac", () => decisioning.kick());

  electron.app.on("web-contents-created", (_event, contents) => {
    lockDown(contents, (url) => isTrustedUrl(url, appEnv.devServerUrl));
  });
  // the dock icon, and macOS reopening grove. a notification click can do that too, right after it
  // opened the session's chat window: that window stays in front, not the main one over it
  electron.app.on("activate", () => {
    const l = landed;
    landed = null;
    if (l && Date.now() - l.at < LANDED_MS && chatWindows.has(l.sessionId)) {
      chatWindows.open(l.sessionId);
      return;
    }
    showMain();
  });
  // only while quitting now: the close button hides the window
  electron.app.on("window-all-closed", () => electron.app.quit());
  electron.app.on("before-quit", (e) => {
    // a chat mid-turn is cut short by a quit, an update's included: asked first, once
    const busy = chat.busy().length;
    if (busy > 0 && !quitConfirmed) {
      e.preventDefault();
      void confirmQuit(busy).then((yes) => {
        if (!yes) return;
        quitConfirmed = true;
        electron.app.quit();
      });
      return;
    }
    quitting = true;
    electron.globalShortcut.unregisterAll();
    chat.dispose();
    chatWindows.dispose();
    clearInterval(trayTick);
    awake.set(false);
    combos.dispose();
    live.dispose();
    projects.dispose();
    void decisioning.dispose();
    prService.dispose();
    void sessions.dispose();
  });
}

/** quit with chats mid-turn? a test root asks nobody and counts it */
async function confirmQuit(busy: number): Promise<boolean> {
  if (appEnv.customRoot) {
    quitAsks += 1;
    return true;
  }
  const { response } = await electron.dialog.showMessageBox({
    type: "warning",
    message:
      busy === 1
        ? "Claude is still working in a chat."
        : `Claude is still working in ${busy} chats.`,
    detail:
      "Quitting stops it mid-turn. The conversation is kept, and your next message there carries on from it.",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
