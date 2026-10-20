import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentView,
  type Combo,
  classifyPath,
  conversationMarkdown,
  conversationView,
  type EditorTarget,
  editDiff,
  filesWritten,
  findAgentFile,
  isValidSessionId,
  MESSAGE_MAX,
  openInEditor,
  prepareFolderOpen,
  projectIdOf,
  type Runtime,
  readAgentTimeline,
  readConversation,
  readEditDiff,
  runDetached,
  runGit,
  type SessionAgent,
  type Settings,
  saveSettings,
  type TimelineState,
  wantsModel,
  workspaceFolders,
  ZED_AGENT_LINK,
  ZED_AGENT_LINK_DELAY_MS,
} from "@grove/core";
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import * as electron from "electron";
import type {
  Api,
  AppSettings,
  Bootstrap,
  ChatAgent,
  ChatApi,
  ChatChange,
  ChatMode,
  ChatTarget,
  ChatWindowView,
  OpenReport,
  Outcome,
  PathInfoView,
  ProjectId,
  SessionHit,
  SessionKey,
  SessionRow,
} from "../shared/ipc.ts";
import type { ChatWindows } from "./chatWindows.ts";
import type { AppEnv } from "./env.ts";
import { AppError, toOutcomeError } from "./errors.ts";
import { log } from "./log.ts";
import { externalUrl, isTrustedUrl } from "./origin.ts";
import type { Pusher } from "./push.ts";
import type { BackgroundService } from "./services/background.ts";
import {
  type ChatHost,
  type ChatWhere,
  isText,
  parseAnswer,
  parseAttachments,
} from "./services/chat.ts";
import type { ComboService } from "./services/combos.ts";
import type { DecisioningService } from "./services/decisioning.ts";
import { parseDraft } from "./services/draft.ts";
import { compareVersions, type EditorService } from "./services/editor.ts";
import { frequentFolders } from "./services/frequentFolders.ts";
import type { LiveService } from "./services/live.ts";
import { backgroundArgs, NEW_CONVERSATION_COMPANION } from "./services/newSession.ts";
import type { Notifier } from "./services/notify.ts";
import type { ProjectsService } from "./services/projects.ts";
import type { RecapService } from "./services/recaps.ts";
import {
  claudeScriptBody,
  isResumeScriptName,
  isValidShortId,
  RESUME_SCRIPT_MAX_AGE_MS,
  resolveClaudeBin,
  resumeScriptPath,
} from "./services/resumeScript.ts";
import type { Reveals } from "./services/reveal.ts";
import type { SessionService } from "./services/sessions.ts";
import { parseStartAgent } from "./services/startAgent.ts";
import { keptFolderToast } from "./services/views.ts";
import { listFiles, readText, TEMP_ROOTS, walkFiles, within } from "./sessionFiles.ts";

export interface Deps {
  env: AppEnv;
  projectsDir: string;
  settings: () => Settings;
  setSettings: (s: Settings) => void;
  sessions: SessionService;
  live: LiveService;
  combos: ComboService;
  projects: ProjectsService;
  recaps: RecapService;
  /** judgment day odds: a local model judging the person's prompts */
  decisioning: DecisioningService;
  /** Claude Code's supervisor, through its own commands */
  background: BackgroundService;
  /** where a notification click or a tray row is taking the page */
  reveals: Reveals;
  notifier: Notifier;
  editor: EditorService;
  /** the person's shell environment, asked again each time. zed starts with it */
  shellEnv: () => Promise<NodeJS.ProcessEnv>;
  pusher: Pusher;
  window: () => BrowserWindow | null;
  /** the main window to the front, wherever it was */
  showMain: () => void;
  /** grove chat: the sessions grove runs itself, and their windows */
  chat: ChatHost;
  chatWindows: ChatWindows;
  /** sessions made in grove chat (cmd-N) whose transcript is not in the list yet */
  fresh: FreshChats;
  /** why grove cannot hold this summon key, or null when it can */
  summonProblem: (key: string) => string | null;
}

/** a session grove made, by id, and where it runs, until its transcript is in the list */
export type FreshChats = Map<string, { project?: ProjectId; where: ChatWhere }>;

/**
 * the handlers return plain values and throw on failure. the wrapper below turns a method whose
 * contract is an Outcome into `{ ok }`, so no handler has to remember to build one.
 */
type Unwrap<T> = T extends Outcome<infer V> ? V : T;
export type Handlers = {
  [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<Unwrap<Awaited<ReturnType<Api[K]>>>>;
};

const OUTCOME_METHODS: ReadonlySet<keyof Api> = new Set<keyof Api>([
  "refresh",
  "review",
  "openSession",
  "openChat",
  "sessionAnswer",
  "sessionReply",
  "startAgent",
  "createProject",
  "updateProject",
  "deleteProject",
  "setArchived",
  "repairProject",
  "openProject",
  "setLongWork",
  "installCompanion",
  "updateSettings",
  "openExternal",
  "downloadModel",
  "deleteModel",
]);

function toAppSettings(s: Settings): AppSettings {
  return { ...s };
}

async function isDirectory(p: string | undefined): Promise<boolean> {
  if (!p) return false;
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function requireSession(deps: Deps, key: SessionKey): SessionRow {
  const row = typeof key === "string" ? deps.sessions.get(key) : undefined;
  if (!row) throw new AppError("no-session", "That session is no longer in the list.");
  return row;
}

async function sweepResumeScripts(stateDir: string): Promise<void> {
  const dir = path.join(stateDir, "run");
  try {
    for (const name of await readdir(dir)) {
      if (!isResumeScriptName(name)) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > RESUME_SCRIPT_MAX_AGE_MS)
        await unlink(file).catch(() => {});
    }
  } catch {
    // nothing written yet
  }
}

function claudeBin(deps: Deps): Promise<string> {
  return resolveClaudeBin(deps.env.home, deps.env.claudeBinOverride ?? deps.settings().claudePath);
}

/** a .command file in the run dir, opened by Terminal. the body is built by the caller. */
async function openInTerminal(deps: Deps, sessionId: string, body: string): Promise<void> {
  const file = resumeScriptPath(deps.env.stateDir, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
  const opened = await runDetached(deps.env.openBin, [file]);
  if (!opened.ok) throw new AppError(opened.error.code, opened.error.message);
  void sweepResumeScripts(deps.env.stateDir);
}

/** the short id of a session the supervisor knows, checked before anything runs it */
function shortIdOf(deps: Deps, row: SessionRow): string {
  const id = deps.background.get(row.sessionId)?.id ?? row.background?.id;
  if (!isValidShortId(id)) {
    throw new AppError(
      "no-background",
      "Claude Code has not said which background session this is.",
    );
  }
  return id;
}

function notTrusted(cwd: string): AppError {
  return new AppError(
    "not-trusted",
    `Claude Code has not been trusted in ${cwd} from a terminal yet. Continue in Terminal asks once - after that, sessions there go to the background from here directly.`,
  );
}

const TERMINAL_MESSAGE =
  "Opened in Terminal. Accept the trust prompt there, and it goes to the background.";

/**
 * a second process on a live conversation is a copy of it. what to say instead of landing, or
 * null to land. vs code and cursor land on one live in an editor in the window that has it. zed
 * cannot, so it would start a second claude on the transcript. a thread live in zed itself is
 * `sdk-ts` in Claude Code's session file, which is "elsewhere" (seen 2026-10-16)
 */
function liveElsewhere(runtime: Runtime, editor: Pick<EditorTarget, "id" | "label">) {
  if (runtime === "terminal") {
    return `This agent is running in a terminal. Quit it there, then open it in ${editor.label}.`;
  }
  if (runtime === "elsewhere") {
    return editor.id === "zed"
      ? "This agent is already open in Zed, or running in claude -p or an SDK app. Open it here once it has finished."
      : `This agent is running outside ${editor.label}, in claude -p or an SDK app. Open it here once it has finished.`;
  }
  if (runtime === "vscode" && editor.id === "zed") {
    return "This agent is open in another editor window. Close it there, then open it in Zed.";
  }
  return null;
}

/**
 * the supervisor holds it: a resume anywhere else would be refused. `claude stop`, never
 * `claude rm` - rm reasons about worktrees, and a project's working copies are ones
 */
async function releaseBackground(deps: Deps, row: SessionRow): Promise<void> {
  const id = shortIdOf(deps, row);
  const out = await deps.background.stop(id);
  if (out.code !== 0) throw claudeFailure(`claude stop ${id} failed`, out);
  if (!(await deps.background.waitReleased(row.sessionId))) {
    throw new AppError(
      "still-held",
      `Stopped ${id}, but Claude Code still holds it. Try again in a moment.`,
    );
  }
}

/** a claude command that failed, as something a person can read */
function claudeFailure(what: string, out: { code: number | null; stderr: string; stdout: string }) {
  const said = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
  return new AppError("claude-failed", said ? `${what}: ${said}` : `${what} (exit ${out.code}).`);
}

function buildHandlers(deps: Deps): Handlers {
  const { sessions, combos, projects, editor, pusher, env } = deps;
  let lastPickedDir: string | undefined;

  /** zed, landing: the new window's agent panel, once that window is up. see ZED_AGENT_LINK */
  function openZedAgentPanelSoon(): void {
    if (editor.current().id !== "zed") return;
    setTimeout(() => void runDetached(env.openBin, [ZED_AGENT_LINK]), ZED_AGENT_LINK_DELAY_MS);
  }

  /**
   * zed, started by its cli, keeps the cli's environment, which is the app's: from the Dock, a
   * PATH with nothing of the person's in it. so it gets their shell's, as from a terminal. vs code
   * and cursor look up their own. asked before a handoff is written: zed's agent times the link
   * from the handoff
   */
  async function editorEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    return editor.current().id === "zed" ? deps.shellEnv() : undefined;
  }

  /** the project's window in the editor, on a session when one is given */
  async function openWindow(combo: Combo, sessionId?: string): Promise<OpenReport> {
    const env = await editorEnv();
    const report = await combos.open(combo, sessionId, { editor: editor.current().id });
    const launched = await openInEditor(
      editor.current(),
      { workspaceFile: report.workspaceFile, folders: workspaceFolders(combo) },
      env,
    );
    if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
    if (sessionId) openZedAgentPanelSoon();
    for (const warning of report.warnings) {
      pusher.send("toast", { level: "error", title: `${combo.name}: ${warning}` });
    }
    return {
      launched: true,
      landing: Boolean(sessionId) && (await editor.companionInstalled()),
      outcomes: report.outcomes,
      warnings: report.warnings,
    };
  }

  /**
   * a deleted project's folder, to the Trash. a test root keeps it inside itself, in
   * `.grove/trash/`: nothing a test deletes lands in the Trash of whoever runs it
   */
  async function trash(root: string): Promise<void> {
    // a root that combos.json points at the home folder or at grove's own is not one project's
    if (root === env.home || root === env.appRoot) {
      throw new Error("That folder holds more than this project.");
    }
    if (!env.customRoot) return electron.shell.trashItem(root);
    const dir = path.join(env.stateDir, "trash");
    await mkdir(dir, { recursive: true });
    // two projects deleted in one run can share a folder name
    await rename(root, path.join(dir, `${path.basename(root)}-${Date.now()}`));
  }

  /** a clean draft, or every problem with it in one error */
  async function cleanDraft(raw: unknown, self?: string) {
    const { draft, problems } = await parseDraft(raw);
    if (!draft) throw new AppError("invalid", problems.join(" "));
    const all = [...problems, ...combos.problemsWithDraft(draft, self)];
    if (all.length > 0) throw new AppError("invalid", all.join(" "));
    return draft;
  }

  /** the chat window's own handlers, for the session card's answer and reply: one set of rules */
  let chat: ChatHandlers | undefined;
  const chatOf = () => {
    chat ??= buildChatHandlers(deps, api);
    return chat;
  };
  const chatOn = () => {
    if (deps.settings().chat !== true) {
      throw new AppError("chat-off", "Grove chat is switched off in Settings.");
    }
  };

  const api: Handlers = {
    async bootstrap(): Promise<Bootstrap> {
      const editorStatus = await editor.status();
      // the views first: reading them can run a compute, which stamps revs of its own
      const { projects: list, problem } = projects.views();
      const inbox = projects.inbox();
      return {
        revs: pusher.currentRevs(),
        env: {
          appRoot: env.appRoot,
          projectsDir: deps.projectsDir,
          home: env.home,
          platform: process.platform,
          isDev: env.isDev,
        },
        settings: toAppSettings(deps.settings()),
        editor: editorStatus,
        projects: list,
        ...(problem ? { projectsProblem: problem } : {}),
        inbox,
      };
    },

    async refresh() {
      await Promise.all([
        sessions.refresh(),
        (async () => {
          // hand-editable, so a refresh is how an edit made outside the app lands
          await combos.load(true);
          await combos.syncAll();
          await combos.reconcileAll();
        })(),
      ]);
    },

    async review(project, keys, reviewed) {
      await projects.review(project, keys, reviewed);
    },

    async openSession(key) {
      const row = requireSession(deps, key);
      if (!isValidSessionId(row.sessionId)) {
        throw new AppError("bad-session-id", "That session has no usable ID.");
      }
      const label = editor.current().label;
      // again at call time: the plan the page showed may have moved since
      let runtime = projects.runtimeFor(row.sessionId, row);
      if (runtime === "grove") {
        // one host per session: grove lets go of it before the editor resumes it. the registry
        // can still list the process a moment after, so it is closed from here on
        await deps.chat.release(row.sessionId);
        runtime = "closed";
      }
      const combo = combos.list().find((c) => c.name === row.comboName);
      const elsewhere = liveElsewhere(runtime, editor.current());
      if (elsewhere) {
        // the project opens, nothing lands
        if (combo) await openWindow(combo);
        return { message: elsewhere };
      }
      if (runtime === "background") await releaseBackground(deps, row);
      // landing on a session is looking at it. its chat window, if it had one, is not where it is
      deps.live.markSeen([row.sessionId]);
      deps.chatWindows.close(row.sessionId);
      const missing = {
        message: `${label} opened without landing: Grove is not set up there.`,
      };
      if (combo && row.comboRelation === "root") {
        return (await openWindow(combo, row.sessionId)).landing ? {} : missing;
      }
      // anywhere else, its own folder: what the Claude panel wants as workspaceFolders[0]
      if (!(await isDirectory(row.cwd))) {
        throw new AppError("cwd-missing", "That session's folder no longer exists.");
      }
      const folder = row.cwd as string;
      const launchEnv = await editorEnv();
      const prepared = await prepareFolderOpen(env.appRoot, folder, {
        sessionId: row.sessionId,
        source: "app",
        editor: editor.current().id,
      });
      if (!prepared.ok) throw new AppError(prepared.error.code, prepared.error.message);
      const launched = await openInEditor(editor.current(), { folders: [folder] }, launchEnv);
      if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
      openZedAgentPanelSoon();
      return (await editor.companionInstalled()) ? {} : missing;
    },

    async openChat(key, show) {
      chatOn();
      const row = requireSession(deps, key);
      if (!isValidSessionId(row.sessionId)) {
        throw new AppError("bad-session-id", "That session has no usable ID.");
      }
      // a path is checked again when the viewer reads it: only the session's files are shown
      const s = show as Record<string, unknown> | undefined;
      const pane =
        s && isText(s.file, 4096) && s.file
          ? { file: s.file }
          : s?.agents === true
            ? { agents: true as const }
            : undefined;
      deps.chatWindows.open(row.sessionId, pane);
      deps.live.markSeen([row.sessionId]);
    },

    async sessionHost(key) {
      if (deps.settings().chat !== true) return null;
      return deps.chat.status(requireSession(deps, key).sessionId);
    },

    async sessionAnswer(key, askId, answer) {
      chatOn();
      await chatOf().chatAnswer(requireSession(deps, key).sessionId, askId, answer);
    },

    async sessionReply(key, text) {
      chatOn();
      await chatOf().chatSend(requireSession(deps, key).sessionId, text);
    },

    async newChat(project) {
      if (deps.settings().chat !== true) {
        throw new AppError("chat-off", "Grove chat is switched off in Settings.");
      }
      if (typeof project !== "string" || !project) throw new AppError("invalid", "No project.");
      const combo = combos.byId(project);
      if (!(await isDirectory(combo.root))) {
        throw new AppError("cwd-missing", `${combo.root} does not exist.`);
      }
      // the id is grove's from the start, so the window has its session before claude is up
      const id = randomUUID();
      deps.fresh.set(id, {
        project,
        where: { cwd: combo.root, dirs: workspaceFolders(combo).slice(1), fresh: true },
      });
      deps.chatWindows.open(id);
    },

    async chatWindows(): Promise<ChatWindowView[]> {
      const asks = new Map(projects.inbox().rows.map((r) => [r.sessionId, r]));
      return deps.chatWindows.windows().flatMap((id) => {
        const hit = projects.hitFor(id) ?? freshHit(deps, id);
        if (!hit) return [];
        const row = asks.get(id);
        // the hooks say nothing of a session in no project: grove's own claude always does
        const host = deps.chat.status(id);
        return [
          {
            hit,
            ...(row ? { row } : {}),
            ...(host.asks.length > 0 ? { asking: true as const } : {}),
            ...(host.running ? { running: true as const } : {}),
          },
        ];
      });
    },

    async showWindow(id) {
      if (id === null) {
        deps.showMain();
        pusher.send("menu:command", { id: "go-inbox" });
        // only a window that is open: this never opens a session
      } else if (typeof id === "string" && deps.chatWindows.has(id)) deps.chatWindows.open(id);
    },

    async startAgent(raw) {
      const req = parseStartAgent(raw);
      const combo = combos.byId(req.project);
      if (!(await isDirectory(combo.root))) {
        throw new AppError("cwd-missing", `${combo.root} does not exist.`);
      }
      const label = editor.current().label;

      if (req.where === "editor") {
        if (editor.current().id === "zed") {
          // zed's own + is the new thread. nothing outside zed can start one in its window
          await openWindow(combo);
          return {
            message: `Opened ${combo.name} in Zed - start a new thread there with +`,
          };
        }
        const { companionVersion } = await editor.status();
        // an older companion cannot start a conversation, and an unpinned link would go to
        // whichever window has focus. the project still opens, and the person starts it there.
        if (
          !companionVersion ||
          compareVersions(companionVersion, NEW_CONVERSATION_COMPANION) < 0
        ) {
          await openWindow(combo);
          return {
            message: `Opened ${combo.name} - start a new Claude conversation there`,
            body: companionVersion
              ? `The Grove extension in ${label} is older than ${NEW_CONVERSATION_COMPANION}, so it cannot start the conversation.`
              : `The Grove extension is not installed in ${label}, so it cannot start the conversation.`,
          };
        }
        const report = await combos.open(combo, undefined, { newConversation: true });
        const launched = await openInEditor(editor.current(), {
          workspaceFile: report.workspaceFile,
          folders: workspaceFolders(combo),
        });
        if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
        for (const warning of report.warnings) {
          pusher.send("toast", { level: "error", title: `${combo.name}: ${warning}` });
        }
        return { message: `Opening ${combo.name} in ${label} on a new conversation` };
      }

      // the project root as the cwd, so its CLAUDE.md and its hooks load
      // what the person typed, and nothing added: the project's CLAUDE.md says the rest
      const args = backgroundArgs({}, req.prompt);
      if (req.throughTerminal) {
        await openInTerminal(
          deps,
          randomUUID(),
          claudeScriptBody({ cwd: combo.root, claudeBin: await claudeBin(deps), args }),
        );
        return { message: TERMINAL_MESSAGE };
      }
      const res = await deps.background.dispatch(args, { cwd: combo.root });
      if (!res.ok) {
        throw res.notTrusted
          ? notTrusted(combo.root)
          : claudeFailure("claude --bg failed", res.out);
      }
      return { message: res.id ? `started in background · ${res.id}` : "started in background" };
    },

    async findSessions(query, scope) {
      // no scope is the palette's search. a scope that is neither a project's id nor null finds nothing
      if (scope !== undefined && scope !== null && typeof scope !== "string") return [];
      return projects.findSessions(typeof query === "string" ? query : "", scope);
    },

    async listSessions(scope) {
      // a project's id, or null for every project's. anything else lists nothing
      return typeof scope === "string" || scope === null ? projects.listSessions(scope) : [];
    },

    async sessionConversation(key) {
      // only a transcript grove indexed is ever read: the key is a path, and the page sent it
      const row = typeof key === "string" ? sessions.get(key) : undefined;
      if (!row) return null;
      // its panel opened: a recap is written when there is none for where it stands now
      void deps.recaps.want(row);
      // folded whole on every look: 60MB takes 90ms. it throws when Claude Code has deleted it
      return readConversation(row.key).then(conversationView, () => null);
    },

    async writeRecap(key) {
      const row = typeof key === "string" ? sessions.get(key) : undefined;
      if (row) void deps.recaps.want(row, { again: true });
    },

    async nameSessions(keys) {
      if (Array.isArray(keys)) projects.nameSessions(keys);
    },

    async usage() {
      const { projects: list } = projects.views();
      const view = sessions.usage(new Map(list.map((p) => [p.name, p.id])));
      // titles and projects as the lists say them: one hit per session id
      const hits = new Map(projects.listSessions(null).map((h) => [h.sessionId, h]));
      const odds = deps.decisioning.odds((key) => {
        const row = sessions.get(key);
        const hit = row && hits.get(row.sessionId);
        return hit ? { title: hit.title, project: hit.project ?? null } : null;
      });
      return odds ? { ...view, odds } : view;
    },

    async decisioningStatus() {
      return deps.decisioning.status();
    },

    async downloadModel() {
      if (!wantsModel(deps.settings())) {
        throw new AppError("decisioning-off", "No feature that needs the model is switched on.");
      }
      void deps.decisioning.fetchModel();
    },

    async deleteModel() {
      await deps.decisioning.deleteModel();
    },

    async takeLanding() {
      return deps.reveals.take();
    },

    async setVisibleProject(id, all) {
      deps.notifier.setVisible(typeof id === "string" ? id : null, all === true);
    },

    async validateProjectName(name, self) {
      return combos.validateName(String(name ?? ""), self ? combos.byId(self).name : undefined);
    },

    async validateProjectDraft(raw, self) {
      const { draft, problems } = await parseDraft(raw);
      if (!draft) return { problems };
      const own = self ? combos.byId(self).name : undefined;
      return { problems: [...problems, ...combos.problemsWithDraft(draft, own)] };
    },

    async pickDirectories() {
      const win = deps.window();
      const options: OpenDialogOptions = {
        title: "Add folders to this project",
        // electron 43+ defaults to ~/Downloads when no defaultPath is given
        defaultPath: lastPickedDir ?? env.home,
        properties: ["openDirectory", "multiSelections", "createDirectory"],
      };
      const result = win
        ? await electron.dialog.showOpenDialog(win, options)
        : await electron.dialog.showOpenDialog(options);
      if (result.canceled) return [];
      lastPickedDir = path.dirname(result.filePaths[0] ?? env.home);
      return result.filePaths;
    },

    async frequentFolders() {
      const rows = sessions.list();
      const lastByCombo = new Map<string, number>();
      for (const r of rows) {
        if (r.comboName) {
          lastByCombo.set(r.comboName, Math.max(lastByCombo.get(r.comboName) ?? 0, r.activityMs));
        }
      }
      const weekAgo = Date.now() - 7 * 24 * 3_600_000;
      return frequentFolders({
        sessions: rows,
        comboFolders: combos
          .list()
          .flatMap((c) =>
            c.folders.map((f) => ({ path: f.path, atMs: lastByCombo.get(c.name) ?? weekAgo })),
          ),
        home: env.home,
        appRoot: env.appRoot,
        claudeDir: path.dirname(deps.projectsDir),
        // a test root lives in a temp dir, with its repos next to it. nobody else sets one.
        ...(env.customRoot ? { scratch: [] } : {}),
      });
    },

    async inspectPath(target): Promise<PathInfoView> {
      if (typeof target !== "string" || !path.isAbsolute(target)) {
        throw new AppError("bad-path", "That is not an absolute path.");
      }
      const info = await classifyPath(target, { gitPath: deps.settings().gitPath });
      return {
        path: info.path,
        exists: info.exists,
        isGitRepo: info.isGitRepo,
        canBeWorktree: info.allowedModes.includes("worktree"),
        ...(info.currentBranch ? { currentBranch: info.currentBranch } : {}),
        ...(info.head ? { head: info.head } : {}),
        branches: info.branches,
        suggestedDirName: info.suggestedDirName,
      };
    },

    async createProject(raw) {
      const combo = await combos.create(await cleanDraft(raw));
      // the folders appear as "not created yet" and fill in as git works
      void combos.ensure(combo, "create");
      return { id: projectIdOf(combo) };
    },

    async updateProject(id, raw) {
      const before = combos.byId(id);
      const { combo, kept } = await combos.update(before.name, await cleanDraft(raw, before.name));
      for (const outcome of kept) pusher.send("toast", keptFolderToast(outcome));
      void combos.ensure(combo, "update");
      return { id: projectIdOf(combo) };
    },

    async deleteProject(id) {
      const combo = combos.byId(id);
      const { remaining } = await combos.remove(combo.name);
      if (remaining.length > 0) return { remaining };
      // delete is for the disk, so the folder goes too. it holds the person's CLAUDE.md, .claude
      // settings, plans and notes: the Trash, where it can still be taken back from
      if (await isDirectory(combo.root)) {
        await trash(combo.root).catch((e: unknown) => {
          log.warn("trash project root:", e);
          // the project has left the list already: what is still on the disk has to be said
          pusher.send("toast", {
            level: "error",
            title: `Could not move ${combo.name}'s folder to the Trash`,
            body: `It is still at ${combo.root}.`,
            detail: e instanceof Error ? e.message : String(e),
          });
        });
      }
      return { remaining: [] };
    },

    async setArchived(id, archived) {
      if (typeof archived !== "boolean") {
        throw new AppError("invalid", "A project is either archived or not.");
      }
      await combos.setArchived(combos.byId(id).name, archived);
    },

    async repairProject(id) {
      return combos.repair(combos.byId(id));
    },

    async openProject(id) {
      return openWindow(combos.byId(id));
    },

    async setLongWork(id, mode) {
      if (mode !== "background" && mode !== "foreground") {
        throw new AppError("invalid", "Long work is either background or foreground.");
      }
      await combos.setLongWork(combos.byId(id).name, mode);
    },

    async editorStatus(refresh) {
      const status = await editor.status(refresh ?? false);
      pusher.send("editor:status", status);
      return status;
    },

    async installCompanion() {
      await editor.installCompanion();
      pusher.send("editor:status", await editor.status(true));
    },

    async updateSettings(patch) {
      const key = (patch as Partial<Settings> | undefined)?.summonKey;
      if (typeof key === "string" && key.trim() && key !== "none") {
        const why = deps.summonProblem(key.trim());
        if (why) throw new AppError("summon-key", why);
      }
      const next = await saveSettings(env.appRoot, patch as Partial<Settings>);
      deps.setSettings(next);
      editor.applySettings(next);
      pusher.send("editor:status", await editor.status(true));
      return toAppSettings(next);
    },

    async openExternal(url) {
      const safe = externalUrl(url);
      if (!safe) throw new AppError("bad-link", "Only web links open from here.");
      await electron.shell.openExternal(safe);
    },

    async reportCspViolation(detail) {
      log.warn("csp violation:", detail);
    },
  };
  return api;
}

// ---------- grove chat: calls from a chat window, about its own session only

const CHAT_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);
const CHAT_OUTCOMES: ReadonlySet<keyof ChatApi> = new Set<keyof ChatApi>([
  "chatChangeDiff",
  "chatExport",
  "chatCopy",
  "chatUnqueue",
  "chatBackground",
  "chatRename",
  "chatMcp",
  "chatMcpReconnect",
  "chatSetFast",
  "chatSetThinking",
  "chatSetStyle",
  "chatRewind",
  "chatFork",
  "chatSide",
  "chatReadFile",
  "chatWatch",
  "chatWarm",
  "chatSend",
  "chatInterrupt",
  "chatSetMode",
  "chatSetModel",
  "chatSetEffort",
  "chatSetUltracode",
  "chatStopAgent",
  "chatAnswer",
  "chatOpenInEditor",
]);

type ChatHandlers = {
  [K in keyof ChatApi]: (
    sessionId: string,
    ...args: Parameters<ChatApi[K]>
  ) => Promise<Unwrap<Awaited<ReturnType<ChatApi[K]>>>>;
};

/** the newest transcript of it: a session id can have more than one */
const newestRow = (deps: Pick<Deps, "sessions">, id: string): SessionRow | undefined =>
  deps.sessions.byId(id).sort((a, b) => b.activityMs - a.activityMs)[0];

/** a session grove chat made (cmd-N, /clear), named as its window names it until its transcript lands */
function freshHit(
  deps: Pick<Deps, "fresh" | "combos" | "chat">,
  id: string,
): SessionHit | undefined {
  const fresh = deps.fresh.get(id);
  if (!fresh) return undefined;
  return {
    key: "",
    sessionId: id,
    title: "New session",
    // /clear in a session that is in no project: its folder says where
    where: fresh.project ? deps.combos.byId(fresh.project).name : path.basename(fresh.where.cwd),
    runtime: deps.chat.status(id).live ? "grove" : "closed",
    open: {},
    activityMs: Date.now(),
    ...(fresh.project ? { project: fresh.project } : {}),
  };
}

/** the rule vs code and zed use: a project's own sessions run at its root, with its folders */
async function whereOf(deps: Pick<Deps, "combos">, row: SessionRow): Promise<ChatWhere> {
  const combo = deps.combos.list().find((c) => c.name === row.comboName);
  const where =
    combo && row.comboRelation === "root"
      ? { cwd: combo.root, dirs: workspaceFolders(combo).slice(1) }
      : { cwd: row.cwd ?? "", dirs: [] };
  if (!(await isDirectory(where.cwd))) {
    throw new AppError("cwd-missing", "That session's folder no longer exists.");
  }
  return where;
}

/**
 * the folders a chat window may show files from: its session's, and the temp folder. none for a
 * session with no window open, so nothing else can be reached through the session schemes
 */
export async function chatRoots(
  deps: Pick<Deps, "sessions" | "combos" | "chatWindows" | "fresh">,
  id: string,
): Promise<string[] | null> {
  if (!deps.chatWindows.has(id)) return null;
  const row = newestRow(deps, id);
  const where = row
    ? await whereOf(deps, row).catch(() => null)
    : (deps.fresh.get(id)?.where ?? null);
  return where ? [where.cwd, ...where.dirs, ...TEMP_ROOTS] : null;
}

/** the folder's files, as `git ls-files` has them, or a few levels of it when it is no repo */
async function filesIn(folder: string, gitPath?: string): Promise<string[]> {
  const out = await runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: folder,
    gitPath,
  });
  return out.ok ? out.stdout.split("\0").filter(Boolean) : walkFiles(folder);
}

/** what `<session>/workflows/<run>.json` says of a workflow run, as claude code writes it */
export interface WorkflowRun {
  workflowName?: string;
  summary?: string;
  status?: string;
  startTime?: number;
  durationMs?: number;
}

/** a workflow run's own file, beside its agents' folder. only what the agents list shows */
async function readWorkflowRun(transcript: string, run: string): Promise<WorkflowRun | null> {
  if (!/^wf_[A-Za-z0-9_-]{1,64}$/.test(run)) return null;
  const file = path.join(transcript.replace(/\.jsonl$/, ""), "workflows", `${run}.json`);
  const o = await readFile(file, "utf8").then(
    (t) => JSON.parse(t) as Record<string, unknown>,
    () => null,
  );
  if (!o || typeof o !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const r: WorkflowRun = {};
  for (const [k, v] of [
    ["workflowName", str(o.workflowName)],
    ["summary", str(o.summary)],
    ["status", str(o.status)],
    ["startTime", num(o.startTime)],
    ["durationMs", num(o.durationMs)],
  ] as const) {
    if (v !== undefined) (r as Record<string, unknown>)[k] = v;
  }
  return r;
}

const RUN_STATE: Record<string, ChatAgent["state"] | undefined> = {
  completed: "done",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

/**
 * a session's subagents: what its claude says of them now over what their transcripts say. a
 * transcript scan only knows running or done, and calls an agent done two quiet minutes in. a
 * workflow's agents sit under its row: the live run's when claude named them, else a row made
 * from the run's own file
 */
export function agentsOf(
  live: readonly ChatAgent[],
  scanned: readonly SessionAgent[],
  runs: Readonly<Record<string, WorkflowRun>> = {},
): ChatAgent[] {
  const byId = new Map(live.map((a) => [a.id, a]));
  /** a run folder, by the live workflow row whose agents are in it */
  const runOf = new Map<string, string>();
  for (const a of scanned) {
    const now = a.workflow && byId.get(a.id)?.workflow;
    if (a.workflow && now) runOf.set(a.workflow, now);
  }
  for (const a of scanned) {
    const now = byId.get(a.id);
    const step = a.summary ?? a.lastTool;
    if (now) {
      if (!now.step && step) byId.set(a.id, { ...now, step });
      continue;
    }
    const workflow = a.workflow && (runOf.get(a.workflow) ?? a.workflow);
    if (workflow && !byId.has(workflow)) {
      const run = runs[workflow] ?? {};
      const state = RUN_STATE[run.status ?? ""] ?? "done";
      const since = run.startTime ?? a.startedAt;
      byId.set(workflow, {
        id: workflow,
        kind: "workflow",
        description: run.summary ?? run.workflowName ?? "Workflow",
        state,
        since,
        ...(run.durationMs !== undefined ? { ended: since + run.durationMs } : {}),
      });
    }
    byId.set(a.id, {
      id: a.id,
      description: a.description ?? a.asked ?? a.agentType,
      agentType: a.agentType,
      ...(a.toolUseId ? { toolUseId: a.toolUseId } : {}),
      ...(workflow ? { workflow } : {}),
      state: a.state,
      since: a.startedAt,
      ...(a.state === "done" ? { ended: a.lastActivityAt } : {}),
      ...(step ? { step } : {}),
    });
  }
  // running first, the newest first in each
  return [...byId.values()].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running") || b.since - a.since,
  );
}

function buildChatHandlers(deps: Deps, handlers: Handlers): ChatHandlers {
  const { projects, chat, editor } = deps;

  const rowOf = (id: string): SessionRow => {
    const row = newestRow(deps, id);
    if (!row) throw new AppError("no-session", "That session is no longer in the list.");
    return row;
  };
  const where = (row: SessionRow) => whereOf(deps, row);
  /** `@`'s lists, by folder: read again when a window asks for fresh ones */
  const paths = new Map<string, Promise<string[]>>();
  /** an agent's transcript as last read, by file: the next read starts where it stopped */
  const folds = new Map<string, TimelineState>();

  /** where claude runs it, once nothing else holds it: made here, or claimed from where it was */
  async function runWhere(id: string): Promise<ChatWhere> {
    const row = newestRow(deps, id);
    const fresh = deps.fresh.get(id);
    if (!row && fresh) return fresh.where;
    if (!row) throw new AppError("no-session", "That session is no longer in the list.");
    return chat.hosts(id) ? where(row) : claim(id, row);
  }

  /** a path the page sent, as long as it is a file of the session's */
  async function allowed(id: string, file: unknown): Promise<string> {
    const roots = isText(file, 4096) && (await chatRoots(deps, id));
    const real = roots && (await within(roots, file as string));
    if (!real) throw new AppError("not-allowed", "That file is not in this session's folders.");
    return real;
  }

  /** why it cannot be talked to from here: another app has it. one process per session */
  function readOnly(id: string, row: SessionRow): string | undefined {
    const runtime = projects.runtimeFor(id, row);
    const label = editor.current().label;
    if (runtime === "vscode") return `It is open in ${label}. Close it there to talk to it here.`;
    if (runtime === "terminal")
      return "It is running in a terminal. Quit it there to talk to it here.";
    if (runtime === "elsewhere") {
      return "It is running somewhere else: Zed, claude -p or another app. Talk to it here once it has finished.";
    }
    return undefined;
  }

  /** before claude starts on it here: nothing else may have it */
  async function claim(id: string, row: SessionRow): Promise<ChatWhere> {
    const refused = readOnly(id, row);
    if (refused) throw new AppError("live-elsewhere", refused);
    if (projects.runtimeFor(id, row) === "background") await releaseBackground(deps, row);
    return where(row);
  }

  return {
    async chatTarget(id): Promise<ChatTarget | null> {
      const hit = projects.hitFor(id);
      const fresh = deps.fresh.get(id);
      // a window that was still loading when it was given a file, the agents or a fork's words
      const show = deps.chatWindows.takeShow(id);
      const made = !hit && fresh && freshHit(deps, id);
      if (made && fresh) {
        const { activityMs, project, ...session } = made;
        return {
          session,
          ...(project ? { project } : {}),
          cwd: fresh.where.cwd,
          at: activityMs,
          appearance: deps.settings().appearance,
          palette: deps.settings().palette,
          editor: editor.current().label,
          status: chat.status(id),
          text: chat.text(id),
          fresh: true,
          ...(show ? { show } : {}),
        };
      }
      if (!hit) return null;
      const row = rowOf(id);
      const refused = readOnly(id, row);
      const at = await where(row).catch(() => ({ cwd: row.cwd ?? "" }));
      return {
        session: hit,
        ...(hit.project ? { project: hit.project } : {}),
        cwd: at.cwd,
        at: hit.activityMs,
        appearance: deps.settings().appearance,
        palette: deps.settings().palette,
        editor: editor.current().label,
        status: chat.status(id),
        text: chat.text(id),
        ...(refused ? { readOnly: refused } : {}),
        ...(show ? { show } : {}),
      };
    },

    async chatConversation(id, turns) {
      const row = newestRow(deps, id);
      if (!row) return null;
      const n =
        typeof turns === "number" && turns > 0 && turns <= 100_000 ? Math.floor(turns) : undefined;
      return readConversation(row.key).then(
        // whole messages: the panel's view is a preview, this is where they are read
        (state) => ({
          ...conversationView(state, {
            textMax: MESSAGE_MAX,
            chat: true,
            ...(n ? { turns: n } : {}),
          }),
          written: filesWritten(state),
        }),
        () => null,
      );
    },

    async chatExport(id, to) {
      const row = rowOf(id);
      const title = projects.hitFor(id)?.title ?? "Session";
      const md = conversationMarkdown(await readConversation(row.key), title);
      if (to === "clipboard") {
        electron.clipboard.writeText(md);
        return {};
      }
      if (to !== "file") throw new AppError("invalid", "Copy it or save it.");
      const win = electron.BrowserWindow.getFocusedWindow();
      const options = {
        title: "Export the conversation",
        defaultPath: path.join(
          electron.app.getPath("downloads"),
          `${
            title
              .replace(/[/\\:*?"<>|]+/g, " ")
              .trim()
              .slice(0, 80) || "session"
          }.md`,
        ),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const picked = win
        ? await electron.dialog.showSaveDialog(win, options)
        : await electron.dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return {};
      await writeFile(picked.filePath, md);
      return { path: picked.filePath };
    },

    async chatFiles(id) {
      const row = newestRow(deps, id);
      const combo = row && deps.combos.list().find((c) => c.name === row.comboName);
      if (!combo) return { plans: [], artifacts: [] };
      const [plans, artifacts] = await Promise.all([
        listFiles(path.join(combo.root, "plans")),
        listFiles(path.join(combo.root, "artifacts")),
      ]);
      return { plans, artifacts };
    },

    async chatChanges(id) {
      const row = newestRow(deps, id);
      const at = row ? await where(row).catch(() => null) : null;
      if (!at) return [];
      const gitPath = deps.settings().gitPath;
      const lists = await Promise.all(
        [at.cwd, ...at.dirs].map(async (folder) => {
          const [diff, fresh] = await Promise.all([
            runGit(["diff", "HEAD", "--numstat", "-z"], { cwd: folder, gitPath }),
            runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: folder, gitPath }),
          ]);
          // no repo here (a combo's root): nothing to say
          if (!diff.ok) return [];
          const changed = diff.stdout
            .split("\0")
            .filter(Boolean)
            .flatMap((l): ChatChange[] => {
              const [a, r, rel] = l.split("\t");
              if (!rel) return [];
              return [
                {
                  path: path.join(folder, rel),
                  ...(a !== "-" ? { added: Number(a), removed: Number(r) } : {}),
                },
              ];
            });
          const added = fresh.ok
            ? fresh.stdout
                .split("\0")
                .filter(Boolean)
                .map((rel) => ({ path: path.join(folder, rel), fresh: true }))
            : [];
          return [...changed, ...added];
        }),
      );
      return lists.flat().slice(0, 300);
    },

    async chatChangeDiff(id, file) {
      const real = await allowed(id, file);
      const at = await where(rowOf(id));
      const folder = [at.cwd, ...at.dirs].find(
        (f) => real === f || real.startsWith(`${f}${path.sep}`),
      );
      if (!folder) throw new AppError("not-allowed", "That file is not in this session's folders.");
      const out = await runGit(["diff", "HEAD", "--", path.relative(folder, real)], {
        cwd: folder,
        gitPath: deps.settings().gitPath,
      });
      const lines = out.ok ? out.stdout.split("\n") : [];
      const from = lines.findIndex((l) => l.startsWith("@@"));
      if (from >= 0) {
        const hunks = lines.slice(from).filter((l) => /^[@ +\-\\]/.test(l) && !l.startsWith("\\"));
        return hunks.length > 400
          ? [...hunks.slice(0, 400), `… ${hunks.length - 400} more lines`]
          : hunks;
      }
      // a file git has never seen: all of it is new
      const got = await readText(real);
      return "text" in got ? (editDiff("Write", { content: got.text }) ?? []) : ["… not text"];
    },

    async chatReadFile(id, file) {
      return readText(await allowed(id, file));
    },

    async chatWatch(id, file) {
      chat.watch(id, file === null ? null : await allowed(id, file));
    },

    async chatWarm(id) {
      const fresh = deps.fresh.get(id);
      if (fresh && !newestRow(deps, id)) return chat.warm(id, fresh.where);
      const row = rowOf(id);
      // a background agent is stopped by a send, which asks first. a keystroke never stops one
      if (projects.runtimeFor(id, row) === "background" || readOnly(id, row)) return;
      await chat.warm(id, await where(row));
    },

    async chatSend(id, text, rawFiles) {
      const files = parseAttachments(rawFiles);
      if (!isText(text) || (!text.trim() && files.length === 0)) {
        throw new AppError("invalid", "There is nothing to send.");
      }
      const at = await runWhere(id);
      deps.live.markSeen([id]);
      await chat.send(id, at, text.trim() ? text : "", files);
    },

    async chatCommands(id) {
      return chat.commands(id);
    },

    async chatPaths(id, fresh) {
      const at = newestRow(deps, id) ? await where(rowOf(id)) : (deps.fresh.get(id)?.where ?? null);
      if (!at) return [];
      const folders = [at.cwd, ...at.dirs];
      const lists = await Promise.all(
        folders.map((f) => {
          let list = paths.get(f);
          if (!list || fresh === true) {
            list = filesIn(f, deps.settings().gitPath);
            paths.set(f, list);
          }
          return list;
        }),
      );
      // the session's own folder by its relative path, which is how claude names them too. the
      // project's other folders whole, under their name in the menu
      return lists.flatMap((files, i) =>
        i === 0
          ? files.map((f) => ({ insert: f, shown: f }))
          : files.map((f) => ({
              insert: path.join(folders[i] as string, f),
              shown: `${path.basename(folders[i] as string)}/${f}`,
            })),
      );
    },

    async chatInterrupt(id) {
      await chat.interrupt(id);
    },

    async chatSetMode(id, mode) {
      if (typeof mode !== "string" || !CHAT_MODES.has(mode)) {
        throw new AppError("invalid", "That is not a permission mode.");
      }
      await chat.setMode(id, await runWhere(id), mode as ChatMode);
    },

    async chatSetModel(id, model) {
      if (!isText(model, 200) || !model.trim())
        throw new AppError("invalid", "That is not a model.");
      await chat.setModel(id, model);
    },

    async chatSetEffort(id, level) {
      if (!isText(level, 20)) throw new AppError("invalid", "That is not an effort level.");
      await chat.setEffort(id, await runWhere(id), level);
    },

    async chatSetUltracode(id, on) {
      if (typeof on !== "boolean") throw new AppError("invalid", "That is not on or off.");
      await chat.setUltracode(id, await runWhere(id), on);
    },

    async chatAgents(id) {
      const row = newestRow(deps, id);
      const scanned = row?.agents ?? [];
      const ids = [...new Set(scanned.flatMap((a) => (a.workflow ? [a.workflow] : [])))];
      const runs = Object.fromEntries(
        (
          await Promise.all(
            ids.map(async (w) => [w, row && (await readWorkflowRun(row.key, w))] as const),
          )
        ).filter((e): e is readonly [string, WorkflowRun] => !!e[1]),
      );
      return agentsOf(chat.status(id).agents ?? [], scanned, runs);
    },

    async chatAgent(id, agentId) {
      const row = newestRow(deps, id);
      const file = row && isText(agentId, 64) ? await findAgentFile(row.key, agentId) : null;
      if (!file) return null;
      // a running agent's viewer asks every couple of seconds: each read takes up where the last
      // stopped. the oldest go once there are more than a few dozen
      const state = await readAgentTimeline(file, {}, folds.get(file)).catch(() => null);
      if (!state) return null;
      folds.delete(file);
      folds.set(file, state);
      if (folds.size > 32) folds.delete(folds.keys().next().value as string);
      return agentView(state);
    },

    async chatRewind(id, uuid, dry) {
      if (!isText(uuid, 100) || typeof dry !== "boolean")
        throw new AppError("invalid", "That is not a message.");
      return chat.rewind(id, await runWhere(id), uuid, dry);
    },

    async chatFork(id, upTo, draft) {
      if ((upTo !== null && !isText(upTo, 100)) || !isText(draft)) {
        throw new AppError("invalid", "That is not a place to fork from.");
      }
      const row = rowOf(id);
      const at = await where(row);
      const project = projects.hitFor(id)?.project;
      let to: string;
      if (upTo === null) {
        // from before the first message: a new session in the same place
        to = randomUUID();
        deps.fresh.set(to, { ...(project ? { project } : {}), where: { ...at, fresh: true } });
      } else {
        const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
        // its own transcript, next to this one's: it resumes like any session
        to = (await forkSession(id, { dir: at.cwd, upToMessageId: upTo })).sessionId;
        deps.fresh.set(to, { ...(project ? { project } : {}), where: { ...at, fresh: false } });
      }
      deps.chatWindows.open(to, draft ? { draft } : undefined);
    },

    async chatSide(id, question) {
      if (!isText(question, 10_000) || !question.trim())
        throw new AppError("invalid", "Ask it something.");
      return chat.side(id, await runWhere(id), question.trim());
    },

    async chatSetFast(id, on) {
      if (typeof on !== "boolean") throw new AppError("invalid", "That is not on or off.");
      await chat.setFast(id, await runWhere(id), on);
    },

    async chatSetThinking(id, on) {
      if (typeof on !== "boolean") throw new AppError("invalid", "That is not on or off.");
      await chat.setThinking(id, await runWhere(id), on);
    },

    async chatSetStyle(id, style) {
      if (!isText(style, 100)) throw new AppError("invalid", "That is not an output style.");
      await chat.setStyle(id, await runWhere(id), style);
    },

    async chatMcp(id) {
      return chat.mcp(id, await runWhere(id));
    },

    async chatMcpReconnect(id, name) {
      if (!isText(name, 200)) throw new AppError("invalid", "That is not a server.");
      await chat.mcpReconnect(id, name);
    },

    async chatRename(id, title) {
      const name = isText(title, 200) ? title.trim() : "";
      if (!name || /[\r\n]/.test(name)) throw new AppError("invalid", "That is not a name.");
      const row = newestRow(deps, id);
      if (!row)
        throw new AppError("fresh", "Send it something first: there is nothing to name yet.");
      // another app has it: its own claude keeps the name it has
      if (readOnly(id, row)) throw new AppError("live-elsewhere", readOnly(id, row) as string);
      await chat.rename(id, await where(row), name);
      // the list reads the transcript again: the name the person gave it wins over grove's own
      deps.projects.sessionsChanged();
    },

    async chatBackground(id) {
      return chat.background(id);
    },

    async chatUnqueue(id, uuid) {
      if (!isText(uuid, 100)) throw new AppError("invalid", "That is not a queued message.");
      return chat.unqueue(id, uuid);
    },

    async chatCopy(_id, text) {
      if (!isText(text, 5_000_000)) throw new AppError("invalid", "That is too much to copy.");
      electron.clipboard.writeText(text);
    },

    async chatStepDiff(id, toolUseId) {
      const row = newestRow(deps, id);
      if (!row || !isText(toolUseId, 200)) return null;
      return readEditDiff(row.key, toolUseId).catch(() => null);
    },

    async chatStopAgent(id, agentId) {
      if (!isText(agentId, 64)) throw new AppError("invalid", "That is not an agent.");
      await chat.stopAgent(id, agentId);
    },

    async chatAnswer(id, askId, raw) {
      if (!isText(askId, 100)) throw new AppError("invalid", "That is not a question.");
      deps.live.markSeen([id]);
      try {
        chat.answer(id, askId, parseAnswer(raw));
      } catch (e) {
        throw e instanceof AppError
          ? e
          : new AppError("stale", e instanceof Error ? e.message : String(e));
      }
    },

    async chatOpenInEditor(id, when) {
      if (!newestRow(deps, id) && deps.fresh.has(id)) {
        throw new AppError("fresh", "Send it something first: there is nothing to open yet.");
      }
      const row = rowOf(id);
      const label = editor.current().label;
      if (when === "after" && chat.running(id)) {
        chat.afterTurn(id, () => {
          handlers
            .openSession(row.key)
            .catch((e) => pusher(deps, `Could not open it in ${label}`, e));
        });
        return { message: `Opens in ${label} once this turn has finished` };
      }
      return handlers.openSession(row.key);
    },
  };
}

/** what went wrong after the page stopped waiting, as a toast in the main window */
function pusher(deps: Deps, title: string, e: unknown): void {
  log.warn(`${title}:`, e);
  deps.pusher.send("toast", { level: "error", title, body: toOutcomeError(e).message });
}

function registerChatIpc(deps: Deps, handlers: Handlers): void {
  const chat = buildChatHandlers(deps, handlers);
  const api = chat as unknown as Record<
    string,
    (id: string, ...args: unknown[]) => Promise<unknown>
  >;
  for (const name of Object.keys(api) as Array<keyof ChatApi>) {
    electron.ipcMain.handle(`grove:${name}`, async (event: IpcMainInvokeEvent, ...args) => {
      if (!isTrustedUrl(event.senderFrame?.url, deps.env.devServerUrl)) throw new Error("blocked");
      const outcome = CHAT_OUTCOMES.has(name);
      try {
        // the window's own session, from main's map: never one the page names
        const id = deps.chatWindows.sessionOf(event.sender);
        if (!id) {
          if (name === "chatTarget" || name === "chatConversation") return null;
          throw new AppError("no-chat", "This window has no session.");
        }
        const value = await api[name]?.(id, ...args);
        return outcome ? { ok: true, value } : value;
      } catch (e) {
        const error = toOutcomeError(e);
        if (error.code === "internal") log.error(`ipc ${name}:`, e);
        if (!outcome) throw new Error(error.message);
        return { ok: false, error };
      }
    });
  }
}

export function registerIpc(deps: Deps): Handlers {
  const handlers = buildHandlers(deps);
  registerChatIpc(deps, handlers);
  const api = handlers as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of Object.keys(api) as Array<keyof Api>) {
    electron.ipcMain.handle(`grove:${name}`, async (event, ...args) => {
      // only our own page may call in. a frame that navigated elsewhere is not it.
      if (!isTrustedUrl(event.senderFrame?.url, deps.env.devServerUrl)) {
        throw new Error("blocked");
      }
      try {
        const value = await api[name]?.(...args);
        return OUTCOME_METHODS.has(name) ? { ok: true, value } : value;
      } catch (e) {
        const error = toOutcomeError(e);
        if (!OUTCOME_METHODS.has(name)) {
          log.error(`ipc ${name}:`, e);
          throw new Error(error.message);
        }
        if (error.code === "internal") log.error(`ipc ${name}:`, e);
        return { ok: false, error };
      }
    });
  }
  return handlers;
}
