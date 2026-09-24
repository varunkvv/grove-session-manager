import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildResumeCommand,
  classifyPath,
  isValidSessionId,
  needsYou,
  openInEditor,
  prepareFolderOpen,
  runDetached,
  type Settings,
  samePath,
  saveSettings,
  targetDirFor,
} from "@grove/core";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import * as electron from "electron";
import type {
  Api,
  AppSettings,
  Bootstrap,
  Outcome,
  PathInfoView,
  SessionAction,
  SessionKey,
  SessionRow,
} from "../shared/ipc.ts";
import type { AppEnv } from "./env.ts";
import { AppError, toOutcomeError } from "./errors.ts";
import { log } from "./log.ts";
import { externalUrl, isTrustedUrl } from "./origin.ts";
import type { Pusher } from "./push.ts";
import type { AgentInspector } from "./services/agentInspector.ts";
import type { ArchiveService } from "./services/archive.ts";
import type { BackgroundService } from "./services/background.ts";
import type { ComboService } from "./services/combos.ts";
import { parseDraft } from "./services/draft.ts";
import type { EditorService } from "./services/editor.ts";
import { frequentFolders } from "./services/frequentFolders.ts";
import type { LiveService } from "./services/live.ts";
import {
  isResumeScriptName,
  isValidShortId,
  RESUME_SCRIPT_MAX_AGE_MS,
  resolveClaudeBin,
  resumeScriptBody,
  resumeScriptPath,
} from "./services/resumeScript.ts";
import { daemonHeld, sessionActionList } from "./services/sessionActions.ts";
import type { SessionService } from "./services/sessions.ts";
import { keptFolderToast } from "./services/views.ts";

export interface Deps {
  env: AppEnv;
  projectsDir: string;
  settings: () => Settings;
  setSettings: (s: Settings) => void;
  sessions: SessionService;
  live: LiveService;
  combos: ComboService;
  archive: ArchiveService;
  /** Claude Code's supervisor, through its own commands */
  background: BackgroundService;
  inspector: AgentInspector;
  /** these agents of a session are on screen: a finished one gets its line, once */
  seen?: (key: SessionKey, agentIds: string[]) => void;
  editor: EditorService;
  pusher: Pusher;
  window: () => BrowserWindow | null;
}

/**
 * the handlers return plain values and throw on failure. the wrapper below turns a method whose
 * contract is an Outcome into `{ ok }`, so no handler has to remember to build one.
 */
type Unwrap<T> = T extends Outcome<infer V> ? V : T;
type Handlers = {
  [K in keyof Api]: (...args: Parameters<Api[K]>) => Promise<Unwrap<Awaited<ReturnType<Api[K]>>>>;
};

const OUTCOME_METHODS: ReadonlySet<keyof Api> = new Set<keyof Api>([
  "rescan",
  "archiveSessions",
  "runSessionAction",
  "createCombo",
  "updateCombo",
  "deleteCombo",
  "reconcile",
  "ensureCombo",
  "repairFolder",
  "repairCombo",
  "teardownCombo",
  "forceRemoveFolder",
  "openCombo",
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
  const row = deps.sessions.get(key);
  if (!row) throw new AppError("no-session", "That session is no longer in the list.");
  return row;
}

/**
 * where a session's own folder is. for a session inside a combo that is the worktree it ran in,
 * which is what the Claude Code panel wants as workspaceFolders[0].
 */
function folderForSession(row: SessionRow): string | undefined {
  return row.cwd;
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

/** rows are keyed by transcript path, the archive by session id: one conversation, wherever it sits */
function archiveByKey(deps: Deps, keys: SessionKey[], archived: boolean): Promise<void> {
  const ids = keys.flatMap((k) => (typeof k === "string" ? [deps.sessions.get(k)?.sessionId] : []));
  return deps.archive.set(
    ids.filter((id): id is string => !!id),
    archived,
  );
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

/** a claude command that failed, as something a person can read */
function claudeFailure(what: string, out: { code: number | null; stderr: string; stdout: string }) {
  const said = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
  return new AppError("claude-failed", said ? `${what}: ${said}` : `${what} (exit ${out.code}).`);
}

function buildHandlers(deps: Deps): Handlers {
  const { sessions, combos, editor, pusher, env } = deps;
  let lastPickedDir: string | undefined;

  const api: Handlers = {
    async bootstrap(): Promise<Bootstrap> {
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
        editor: await editor.status(),
        combos: combos.views(),
        ...(combos.problemMessage() ? { combosProblem: combos.problemMessage() } : {}),
        sessions: sessions.list(),
        index: sessions.status(),
      };
    },

    async rescan() {
      await Promise.all([
        sessions.refresh(),
        // hand-editable, so a refresh is how an edit made outside the app lands
        deps.archive.load(),
        combos.load(true).then(() => combos.reconcileAll()),
      ]);
    },

    async sessionActions(key): Promise<SessionAction[]> {
      const row = requireSession(deps, key);
      const holder = deps.live.holder(row.sessionId);
      return sessionActionList({
        row,
        editorLabel: editor.current().label,
        companion: await editor.companionInstalled(),
        folderExists: await isDirectory(folderForSession(row)),
        needsYou: needsYou(row.live),
        ...(holder ? { holder } : {}),
      });
    },

    async inspectSession(key) {
      if (typeof key !== "string" || !sessions.get(key)) return null;
      return deps.inspector.inspect(key);
    },

    async followAgent(key, agentId, find) {
      if (agentId !== null && (typeof key !== "string" || !sessions.get(key))) return null;
      // an agent on screen is one being looked at
      if (typeof agentId === "string") deps.seen?.(key, [agentId]);
      return deps.inspector.follow(
        key,
        agentId,
        typeof find === "string" ? find.slice(0, 500) : "",
      );
    },

    async agentsSeen(key, agentIds) {
      if (typeof key !== "string" || !sessions.get(key) || !Array.isArray(agentIds)) return;
      deps.seen?.(key, agentIds.filter((id): id is string => typeof id === "string").slice(0, 50));
    },

    async agentStep(key, agentId, stepId) {
      if (typeof key !== "string" || !sessions.get(key)) return null;
      return deps.inspector.step(key, agentId, stepId);
    },

    async openExternal(url) {
      const safe = externalUrl(url);
      if (!safe) throw new AppError("bad-link", "Only web links open from here.");
      await electron.shell.openExternal(safe);
    },

    async searchSessions(query) {
      if (typeof query !== "string") throw new AppError("bad-query", "Nothing to search for.");
      return { query, hits: await sessions.search(query.slice(0, 500)) };
    },

    async markSeen(keys) {
      if (!Array.isArray(keys)) return;
      const ids = keys.flatMap((k) =>
        typeof k === "string" ? [deps.sessions.get(k)?.sessionId] : [],
      );
      deps.live.markSeen(ids.filter((id): id is string => !!id));
    },

    async archiveSessions(keys, archived) {
      if (!Array.isArray(keys) || typeof archived !== "boolean") {
        throw new AppError("invalid", "Nothing to archive.");
      }
      await archiveByKey(deps, keys, archived);
    },

    async runSessionAction(key, action) {
      const row = requireSession(deps, key);
      // landing on a session is looking at it
      if (["combo-land", "folder-land", "attach", "stop-land"].includes(action)) {
        deps.live.markSeen([row.sessionId]);
      }
      if (!isValidSessionId(row.sessionId)) {
        throw new AppError("bad-session-id", "That session has no usable ID.");
      }
      const folder = folderForSession(row);
      if (action === "mark-seen") {
        deps.live.markSeen([row.sessionId]);
        return {};
      }
      // the inspector is the renderer's own: nothing to do here
      if (action === "inspect") return {};
      if (action === "archive" || action === "unarchive") {
        await archiveByKey(deps, [key], action === "archive");
        return {};
      }
      const landFolder = async (): Promise<{ message?: string }> => {
        if (!(await isDirectory(folder))) {
          throw new AppError("cwd-missing", "That session's folder no longer exists.");
        }
        const prepared = await prepareFolderOpen(env.appRoot, folder as string, {
          sessionId: row.sessionId,
          source: "app",
        });
        if (!prepared.ok) throw new AppError(prepared.error.code, prepared.error.message);
        const launched = await openInEditor(folder as string, editor.current());
        if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
        return (await editor.companionInstalled())
          ? {}
          : {
              message: `${editor.current().label} opened without landing: the companion extension is missing.`,
            };
      };
      const landCombo = async (): Promise<{ message?: string }> => {
        if (!row.comboName) throw new AppError("no-combo", "That session is not in a combo.");
        await api.openCombo(row.comboName, key);
        return {};
      };
      // the supervisor holds it: the editor's resume, or a terminal's, would be refused
      const refuseHeld = () => {
        if (daemonHeld({ row, holder: deps.live.holder(row.sessionId) })) {
          throw new AppError(
            "held",
            "Claude Code is running this session in the background. Open it in Terminal (attach), or stop it first.",
          );
        }
      };
      switch (action) {
        case "combo-land":
          refuseHeld();
          return landCombo();
        case "folder-land":
          refuseHeld();
          return landFolder();
        case "terminal": {
          refuseHeld();
          await openInTerminal(
            deps,
            row.sessionId,
            resumeScriptBody({
              sessionId: row.sessionId,
              cwd: (await isDirectory(folder)) ? folder : undefined,
              claudeBin: await claudeBin(deps),
            }),
          );
          return {};
        }
        case "attach": {
          await openInTerminal(
            deps,
            row.sessionId,
            resumeScriptBody({
              sessionId: row.sessionId,
              claudeBin: await claudeBin(deps),
              attach: shortIdOf(deps, row),
            }),
          );
          return {};
        }
        case "stop":
        case "stop-land": {
          const id = shortIdOf(deps, row);
          const out = await deps.background.stop(id);
          if (out.code !== 0) throw claudeFailure(`claude stop ${id} failed`, out);
          if (action === "stop") return { message: `Stopped ${id}` };
          if (!(await deps.background.waitReleased(row.sessionId))) {
            throw new AppError(
              "still-held",
              `Stopped ${id}, but Claude Code still holds it. Try again in a moment.`,
            );
          }
          // not through combo-land's check: the registry can lag the supervisor by a beat
          return row.comboName ? landCombo() : landFolder();
        }
        case "copy-command": {
          const cwd = (await isDirectory(folder)) ? folder : undefined;
          electron.clipboard.writeText(
            buildResumeCommand(row.sessionId, cwd, await claudeBin(deps)),
          );
          return { message: "Resume command copied" };
        }
        case "copy-id":
          electron.clipboard.writeText(row.sessionId);
          return { message: "Session ID copied" };
        case "reveal":
          electron.shell.showItemInFolder(row.key);
          return {};
      }
    },

    async validateComboName(name, self) {
      return combos.validateName(name, self);
    },

    async validateDraft(raw, self) {
      const { draft, problems } = await parseDraft(raw);
      if (!draft) return { problems };
      return { problems: [...problems, ...combos.problemsWithDraft(draft, self)] };
    },

    async pickDirectories() {
      const win = deps.window();
      const options: OpenDialogOptions = {
        title: "Add folders to this combo",
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

    async createCombo(raw) {
      const { draft, problems } = await parseDraft(raw);
      if (!draft) throw new AppError("invalid", problems.join(" "));
      const all = [...problems, ...combos.problemsWithDraft(draft)];
      if (all.length > 0) throw new AppError("invalid", all.join(" "));
      const combo = await combos.create(draft);
      // the folders appear as "not created yet" and fill in as git works
      void combos.ensure(combo, "create");
      return { name: combo.name };
    },

    async updateCombo(name, raw) {
      const { draft, problems } = await parseDraft(raw);
      if (!draft) throw new AppError("invalid", problems.join(" "));
      const all = [...problems, ...combos.problemsWithDraft(draft, name)];
      if (all.length > 0) throw new AppError("invalid", all.join(" "));
      const { combo, kept } = await combos.update(name, draft);
      for (const outcome of kept) pusher.send("toast", keptFolderToast(outcome));
      void combos.ensure(combo, "update");
      return { name: combo.name };
    },

    async deleteCombo(name, trashRoot) {
      const combo = combos.find(name);
      const { remaining } = await combos.remove(name);
      if (remaining.length > 0) return { remaining };
      if (trashRoot) {
        // the root holds the person's CLAUDE.md and .claude settings, so it goes to the Trash
        await electron.shell.trashItem(combo.root).catch((e: unknown) => {
          log.warn("trash combo root:", e);
        });
      }
      return { remaining: [] };
    },

    async reconcile(name, withDirty) {
      if (name) await combos.reconcile(combos.find(name), withDirty ?? false);
      else await combos.reconcileAll(withDirty ?? false);
    },

    async ensureCombo(name) {
      return combos.ensure(combos.find(name), "ensure");
    },

    async repairFolder(name, folderPath) {
      return combos.repair(combos.find(name), folderPath);
    },

    async repairCombo(name) {
      return combos.repair(combos.find(name));
    },

    async teardownCombo(name) {
      const outcomes = await combos.teardown(combos.find(name));
      return outcomes.filter((o) => o.folder.mode === "worktree");
    },

    async forceRemoveFolder(name, folderPath) {
      return combos.forceRemove(combos.find(name), folderPath);
    },

    async openCombo(name, sessionKey) {
      const combo = combos.find(name);
      let sessionId: string | undefined;
      if (sessionKey) {
        const row = requireSession(deps, sessionKey);
        if (isValidSessionId(row.sessionId)) sessionId = row.sessionId;
      }
      const report = await combos.open(combo, sessionId);
      const launched = await openInEditor(report.workspaceFile, editor.current());
      if (!launched.ok) throw new AppError(launched.error.code, launched.error.message);
      for (const warning of report.warnings) {
        pusher.send("toast", { level: "error", title: `${name}: ${warning}` });
      }
      return {
        launched: true,
        landing: Boolean(sessionId) && (await editor.companionInstalled()),
        outcomes: report.outcomes,
        warnings: report.warnings,
      };
    },

    async setLongWork(name, mode) {
      if (mode !== "background" && mode !== "foreground") {
        throw new AppError("invalid", "Long work is either background or foreground.");
      }
      await combos.setLongWork(name, mode);
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

    async getSettings() {
      return toAppSettings(deps.settings());
    },

    async updateSettings(patch) {
      const next = await saveSettings(env.appRoot, patch as Partial<Settings>);
      deps.setSettings(next);
      editor.applySettings(next);
      pusher.send("editor:status", await editor.status(true));
      return toAppSettings(next);
    },

    async reveal(target) {
      if (target.kind === "session") {
        electron.shell.showItemInFolder(requireSession(deps, target.key).key);
        return;
      }
      if (target.kind === "agent") {
        requireSession(deps, target.key);
        const file = deps.inspector.agentFile(target.key, target.agentId);
        if (!file) throw new AppError("no-agent", "That agent's transcript is gone.");
        electron.shell.showItemInFolder(file);
        return;
      }
      const combo = combos.find(target.name);
      if (target.kind === "combo") {
        electron.shell.showItemInFolder(combo.root);
        return;
      }
      const folder = combo.folders.find((f) => samePath(f.path, target.folderPath));
      electron.shell.showItemInFolder(folder ? targetDirFor(combo, folder) : combo.root);
    },

    async copyText(text) {
      if (typeof text !== "string") throw new AppError("bad-text", "Nothing to copy.");
      electron.clipboard.writeText(text);
    },

    async reportCspViolation(detail) {
      log.warn("csp violation:", detail);
    },
  };
  return api;
}

/** the handlers, for the main process's own use (a notification that lands on a session) */
export type AppHandlers = Handlers;

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
