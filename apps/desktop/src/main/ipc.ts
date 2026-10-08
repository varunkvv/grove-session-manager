import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Combo,
  classifyPath,
  derivePrefix,
  isInside,
  isValidSessionId,
  openInEditor,
  prepareFolderOpen,
  projectIdOf,
  runDetached,
  type Settings,
  saveSettings,
  sessionTail,
  validatePrefix,
} from "@grove/core";
import { CARD_ID, CONCLUSION_ID, readProject, transcriptFile, turnAround } from "@grove/record";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import * as electron from "electron";
import type {
  Api,
  AppSettings,
  Bootstrap,
  OpenReport,
  Outcome,
  PathInfoView,
  SessionKey,
  SessionRow,
} from "../shared/ipc.ts";
import type { AppEnv } from "./env.ts";
import { AppError, toOutcomeError } from "./errors.ts";
import { log } from "./log.ts";
import { externalUrl, isTrustedUrl } from "./origin.ts";
import type { Pusher } from "./push.ts";
import type { BackgroundService } from "./services/background.ts";
import type { ComboService } from "./services/combos.ts";
import { parseDraft } from "./services/draft.ts";
import { compareVersions, type EditorService } from "./services/editor.ts";
import { frequentFolders } from "./services/frequentFolders.ts";
import type { LiveService } from "./services/live.ts";
import { backgroundArgs, NEW_CONVERSATION_COMPANION } from "./services/newSession.ts";
import type { Notifier } from "./services/notify.ts";
import type { ProjectRecordService } from "./services/projectRecord.ts";
import type { ProjectsService } from "./services/projects.ts";
import {
  claudeScriptBody,
  isResumeScriptName,
  isValidShortId,
  RESUME_SCRIPT_MAX_AGE_MS,
  resolveClaudeBin,
  resumeScriptPath,
} from "./services/resumeScript.ts";
import type { Reveals } from "./services/reveal.ts";
import type { ServerChecks } from "./services/serverCheck.ts";
import type { SessionService } from "./services/sessions.ts";
import { parseStartAgent, startPrompt } from "./services/startAgent.ts";
import { keptFolderToast } from "./services/views.ts";

export interface Deps {
  env: AppEnv;
  projectsDir: string;
  settings: () => Settings;
  setSettings: (s: Settings) => void;
  sessions: SessionService;
  live: LiveService;
  combos: ComboService;
  record: ProjectRecordService;
  projects: ProjectsService;
  /** null in a dev build outside GROVE_ROOT, which installs no record runtime */
  serverChecks: ServerChecks | null;
  /** Claude Code's supervisor, through its own commands */
  background: BackgroundService;
  /** where a notification click or a tray row is taking the page */
  reveals: Reveals;
  notifier: Notifier;
  editor: EditorService;
  pusher: Pusher;
  window: () => BrowserWindow | null;
}

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
  "startAgent",
  "createProject",
  "updateProject",
  "deleteProject",
  "repairProject",
  "openProject",
  "setLongWork",
  "installCompanion",
  "updateSettings",
  "reveal",
  "copyText",
  "openExternal",
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

/** a claude command that failed, as something a person can read */
function claudeFailure(what: string, out: { code: number | null; stderr: string; stdout: string }) {
  const said = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
  return new AppError("claude-failed", said ? `${what}: ${said}` : `${what} (exit ${out.code}).`);
}

function buildHandlers(deps: Deps): Handlers {
  const { sessions, combos, projects, editor, pusher, env } = deps;
  let lastPickedDir: string | undefined;

  /** the project's window in the editor, on a session when one is given */
  async function openWindow(combo: Combo, sessionId?: string): Promise<OpenReport> {
    const report = await combos.open(combo, sessionId);
    const launched = await openInEditor(report.workspaceFile, editor.current());
    if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
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

  /** a clean draft, or every problem with it in one error */
  async function cleanDraft(raw: unknown, self?: string) {
    const { draft, problems } = await parseDraft(raw);
    if (!draft) throw new AppError("invalid", problems.join(" "));
    const all = [...problems, ...combos.problemsWithDraft(draft, self)];
    if (all.length > 0) throw new AppError("invalid", all.join(" "));
    return draft;
  }

  const api: Handlers = {
    async bootstrap(): Promise<Bootstrap> {
      const editorStatus = await editor.status();
      // the views first: reading them can run a compute, which stamps revs of its own
      const { projects: list, problem } = projects.views();
      const record = projects.recordViews();
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
        record,
        inbox,
      };
    },

    async refresh() {
      await Promise.all([
        sessions.refresh(),
        (async () => {
          // hand-editable, so a refresh is how an edit made outside the app lands
          await combos.load(true);
          await combos.backfillPrefixes();
          await combos.syncAll();
          deps.record.check();
          await Promise.all([combos.reconcileAll(), deps.serverChecks?.runAll(combos.list())]);
        })(),
      ]);
    },

    async card(project, cardId) {
      const id = typeof cardId === "string" ? cardId.toUpperCase() : "";
      if (typeof project !== "string" || !CARD_ID.test(id)) return null;
      return projects.card(project, id);
    },

    async conclusionTurn(project, conclusionId) {
      const id = typeof conclusionId === "string" ? conclusionId.toUpperCase() : "";
      if (typeof project !== "string" || !CONCLUSION_ID.test(id)) return null;
      const c = deps.record.snapshot(project)?.conclusions.find((x) => x.id === id);
      if (!c?.toolUseId) return null;
      // the record's own reader, the one conclusion_search answers an agent with. it reads a
      // bounded part of the file and gives null for anything it cannot read
      const file = transcriptFile(deps.projectsDir, c.session);
      const turn = file ? turnAround(file, c.toolUseId) : null;
      return turn?.prompt || turn?.text ? turn : null;
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
      const runtime = projects.runtimeFor(row.sessionId, row);
      const combo = combos.list().find((c) => c.name === row.comboName);
      if (runtime === "terminal" || runtime === "elsewhere") {
        // a second process on a live conversation is a copy of it. the project opens, nothing lands
        if (combo) await openWindow(combo);
        return {
          message:
            runtime === "terminal"
              ? `This agent is running in a terminal. Quit it there, then open it in ${label}.`
              : `This agent is running outside ${label}, in claude -p or an SDK app. Open it here once it has finished.`,
        };
      }
      if (runtime === "background") {
        // the supervisor holds it: the editor's resume would be refused. `claude stop`, never
        // `claude rm` - rm reasons about worktrees, and a project's working copies are ones
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
      // landing on a session is looking at it
      deps.live.markSeen([row.sessionId]);
      const missing = {
        message: `${label} opened without landing: the companion extension is missing.`,
      };
      if (combo && row.comboRelation === "root") {
        return (await openWindow(combo, row.sessionId)).landing ? {} : missing;
      }
      // anywhere else, its own folder: what the Claude panel wants as workspaceFolders[0]
      if (!(await isDirectory(row.cwd))) {
        throw new AppError("cwd-missing", "That session's folder no longer exists.");
      }
      const folder = row.cwd as string;
      const prepared = await prepareFolderOpen(env.appRoot, folder, {
        sessionId: row.sessionId,
        source: "app",
      });
      if (!prepared.ok) throw new AppError(prepared.error.code, prepared.error.message);
      const launched = await openInEditor(folder, editor.current());
      if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
      return (await editor.companionInstalled()) ? {} : missing;
    },

    async startAgent(raw) {
      const req = parseStartAgent(raw);
      const combo = combos.byId(req.project);
      const prompt = startPrompt({
        root: combo.root,
        rootExists: await isDirectory(combo.root),
        goal: combo.note,
        ...(req.cardId
          ? { cardId: req.cardId, card: projects.startCard(req.project, req.cardId) }
          : {}),
      });
      const label = editor.current().label;

      if (req.where === "editor") {
        const { companionVersion } = await editor.status();
        // an older companion cannot start a conversation, and an unpinned link would go to
        // whichever window has focus. the project still opens; the prompt waits on the clipboard.
        if (
          !companionVersion ||
          compareVersions(companionVersion, NEW_CONVERSATION_COMPANION) < 0
        ) {
          await openWindow(combo);
          electron.clipboard.writeText(prompt);
          projects.addStart(req.project, "editor", req.cardId);
          return {
            message: "Prompt copied - paste it into a new Claude conversation",
            body: companionVersion
              ? `The Grove extension in ${label} is older than ${NEW_CONVERSATION_COMPANION}, so it cannot start the conversation.`
              : `The Grove extension is not installed in ${label}, so it cannot start the conversation.`,
          };
        }
        const report = await combos.open(combo, undefined, { newConversation: true, prompt });
        const launched = await openInEditor(report.workspaceFile, editor.current());
        if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
        for (const warning of report.warnings) {
          pusher.send("toast", { level: "error", title: `${combo.name}: ${warning}` });
        }
        projects.addStart(req.project, "editor", req.cardId);
        return {
          message: `Opening ${combo.name} in ${label} on a new conversation`,
          // the panel only fills the box
          body: "The prompt is in the Claude panel. Send it to start the agent.",
        };
      }

      // the project root as the cwd, so its CLAUDE.md, hooks and the record's server load
      const args = backgroundArgs({}, prompt);
      if (req.throughTerminal) {
        await openInTerminal(
          deps,
          randomUUID(),
          claudeScriptBody({ cwd: combo.root, claudeBin: await claudeBin(deps), args }),
        );
        projects.addStart(req.project, "background", req.cardId);
        return { message: TERMINAL_MESSAGE };
      }
      const res = await deps.background.dispatch(args, { cwd: combo.root });
      if (!res.ok) {
        throw res.notTrusted
          ? notTrusted(combo.root)
          : claudeFailure("claude --bg failed", res.out);
      }
      projects.addStart(req.project, "background", req.cardId);
      return { message: res.id ? `started in background · ${res.id}` : "started in background" };
    },

    async findSessions(query) {
      return projects.findSessions(typeof query === "string" ? query : "");
    },

    async projectSessions(project) {
      return typeof project === "string" ? projects.projectSessions(project) : [];
    },

    async sessionTail(key) {
      // only a transcript grove indexed is ever read: the key is a path, and the page sent it
      const row = typeof key === "string" ? sessions.get(key) : undefined;
      if (!row) return null;
      const tail = sessionTail(row.key);
      // past the reader's reach: the start of the turn's first prompt, from the index
      return { ...tail, prompt: tail.prompt ?? row.lastPrompt };
    },

    async takeLanding() {
      return deps.reveals.take();
    },

    async setVisibleProject(id) {
      deps.notifier.setVisibleProject(typeof id === "string" ? id : null);
    },

    async validateProjectName(name, self, prefix) {
      const own = self ? combos.byId(self) : undefined;
      const v = combos.validateName(String(name ?? ""), own?.name);
      // the stored one never changes. else what the form says, what the folder's project file
      // says (the record refuses a prefix change once there are cards), or one from the name
      const given = typeof prefix === "string" ? prefix.trim().toUpperCase() : "";
      const p =
        own?.prefix ?? (given || readProject(v.root)?.prefix || derivePrefix(String(name ?? "")));
      const prefixProblem = own ? undefined : validatePrefix(p, combos.list());
      return { ...v, prefix: p, ...(prefixProblem ? { prefixProblem } : {}) };
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

    async deleteProject(id, trashRoot) {
      const combo = combos.byId(id);
      const { remaining } = await combos.remove(combo.name);
      if (remaining.length > 0) return { remaining };
      if (trashRoot) {
        // the root holds the person's CLAUDE.md, .claude settings and the record, so it goes to the Trash
        await electron.shell.trashItem(combo.root).catch((e: unknown) => {
          log.warn("trash project root:", e);
        });
      }
      return { remaining: [] };
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
      const next = await saveSettings(env.appRoot, patch as Partial<Settings>);
      deps.setSettings(next);
      editor.applySettings(next);
      pusher.send("editor:status", await editor.status(true));
      return toAppSettings(next);
    },

    async reveal(project, relative) {
      const { root } = combos.byId(project);
      const file = typeof relative === "string" && relative ? path.resolve(root, relative) : "";
      // an agent wrote the path. Finder shows it, and only when it is inside the project
      if (!file || !isInside(file, root)) {
        throw new AppError("bad-path", "That file is not inside the project folder.");
      }
      electron.shell.showItemInFolder(file);
    },

    async copyText(text) {
      if (typeof text !== "string") throw new AppError("bad-text", "Nothing to copy.");
      electron.clipboard.writeText(text);
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

export function registerIpc(deps: Deps): Handlers {
  const handlers = buildHandlers(deps);
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
