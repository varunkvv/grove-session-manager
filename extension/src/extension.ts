import { realpathSync } from "node:fs";
import path from "node:path";
import {
  assignCombos,
  buildResumeCommand,
  CLAUDE_EXTENSION_ID,
  createSessionIndex,
  formatRelativeTime,
  getAppRoot,
  getProjectsDir,
  getStateDir,
  loadCombos,
  loadSettings,
  pendingDir,
  repairCombo,
  type SessionView,
  searchSessions,
} from "@grove/core";
import * as vscode from "vscode";
import { openCombo, openSession, toggleLongWork } from "./commands.ts";
import type { Deps, StatusView } from "./deps.ts";
import { drainIntents } from "./drain.ts";
import { checkDrift, currentCombo, runStartup } from "./startup.ts";

function firstFolderRoot(): string | undefined {
  // folder 0 and only folder 0: that is the one the Claude Code panel uses as its cwd
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder?.uri.scheme !== "file") return undefined;
  // same normalisation the Claude Code panel applies to its cwd
  try {
    return realpathSync.native(folder.uri.fsPath).normalize("NFC");
  } catch {
    return folder.uri.fsPath.normalize("NFC");
  }
}

async function buildDeps(
  context: vscode.ExtensionContext,
  status: vscode.StatusBarItem,
): Promise<Deps> {
  const config = vscode.workspace.getConfiguration("grove");
  const appRoot = getAppRoot({ appRoot: config.get<string>("root") || undefined });
  const shared = await loadSettings(appRoot);
  const output = vscode.window.createOutputChannel("Grove");
  context.subscriptions.push(output);

  return {
    appRoot,
    stateDir: getStateDir(appRoot),
    projectsDir: getProjectsDir({
      claudeConfigDir: config.get<string>("claudeConfigDir") || shared.claudeConfigDir || undefined,
    }),
    gitPath: config.get<string>("gitPath") || shared.gitPath || undefined,
    uriScheme: vscode.env.uriScheme,
    settings: {
      reconcileOnStartup: config.get<boolean>("reconcileOnStartup", true),
      syncAdditionalDirectories: config.get<boolean>("syncAdditionalDirectories", true),
    },
    workspace: () => ({
      root: firstFolderRoot(),
      workspaceFile: vscode.workspace.workspaceFile?.fsPath,
    }),
    isTrusted: () => vscode.workspace.isTrusted,
    isFocused: () => vscode.window.state.focused,
    onDidFocus: (cb) => vscode.window.onDidChangeWindowState((s) => s.focused && cb()),
    activateClaude: async () => {
      const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
      if (!ext) return false;
      await ext.activate();
      return true;
    },
    executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
    openExternalPinned: async (uri) =>
      vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(uri, true))),
    openFolder: async (target, newWindow) => {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
        forceNewWindow: newWindow,
      });
    },
    copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
    info: (message, ...actions) =>
      Promise.resolve(vscode.window.showInformationMessage(message, ...actions)),
    warn: (message, ...actions) =>
      Promise.resolve(vscode.window.showWarningMessage(message, ...actions)),
    log: (message) => output.appendLine(`${new Date().toISOString()} ${message}`),
    memory: {
      get: (key) => context.workspaceState.get(key),
      set: (key, value) => Promise.resolve(context.workspaceState.update(key, value)),
    },
    setStatus: (view) => renderStatus(status, view),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function renderStatus(item: vscode.StatusBarItem, view: StatusView): void {
  const drift = view.drift ?? [];
  item.text = view.combo ? `$(layers) ${view.combo}` : "$(layers)";
  item.backgroundColor = drift.length
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  item.tooltip = drift.length
    ? `Grove - ${view.combo}\n\n${drift.join("\n")}\n\nClick to switch combo.`
    : view.combo
      ? `Grove - combo "${view.combo}". Click to switch.`
      : "Grove - open a combo";
  item.show();
}

interface SessionItem extends vscode.QuickPickItem {
  session?: SessionView;
}

const TERMINAL: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("terminal"),
  tooltip: "Resume in a terminal",
};
const COPY: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("copy"),
  tooltip: "Copy the resume command",
};

async function findSession(deps: Deps): Promise<void> {
  const pick = vscode.window.createQuickPick<SessionItem>();
  pick.placeholder = "Find a Claude Code session - title, prompt, combo, branch, #PR";
  pick.matchOnDescription = false;
  pick.busy = true;
  pick.show();

  const index = createSessionIndex({
    projectsDir: deps.projectsDir,
    cacheDir: deps.stateDir,
    persist: "if-cold",
  });
  await index.load();
  await index.refresh();
  const { combos } = await loadCombos(deps.appRoot);
  const here = deps.workspace().root;
  const hereCombo = (await currentCombo(deps))?.name;
  const views = assignCombos(index.list(), combos).filter((v) => !v.stub);

  const toItem = (s: SessionView): SessionItem => {
    const where = s.comboName ?? (s.cwd ? path.basename(s.cwd) : s.projectDirName);
    return {
      label: s.title ?? "Untitled session",
      description: [formatRelativeTime(s.activityMs), where, s.gitBranch]
        .filter(Boolean)
        .join("  ·  "),
      detail: s.firstPrompt && s.firstPrompt !== s.title ? s.firstPrompt.slice(0, 140) : undefined,
      // our own filter decides what matches. without this VS Code filters the labels again.
      alwaysShow: true,
      buttons: [TERMINAL, COPY],
      session: s,
    };
  };

  const render = () => {
    const matches = searchSessions(views, pick.value);
    const mine = (s: SessionView) => (hereCombo ? s.comboName === hereCombo : s.cwd === here);
    const groups: Array<[string, SessionView[]]> = [
      ["This workspace", matches.filter(mine)],
      ["Other combos", matches.filter((s) => !mine(s) && s.comboName)],
      ["Other folders", matches.filter((s) => !mine(s) && !s.comboName)],
    ];
    pick.items = groups.flatMap(([label, rows]) =>
      rows.length
        ? [{ label, kind: vscode.QuickPickItemKind.Separator } as SessionItem, ...rows.map(toItem)]
        : [],
    );
  };
  render();
  pick.busy = false;
  pick.onDidChangeValue(render);

  pick.onDidTriggerItemButton(async ({ item, button }) => {
    if (!item.session) return;
    const cwd = item.session.relocatedCwd ?? item.session.cwd;
    const command = buildResumeCommand(item.session.sessionId, cwd);
    if (button === COPY) {
      await deps.copy(command);
      void deps.info("Resume command copied.");
    } else {
      const terminal = vscode.window.createTerminal({ name: `claude: ${item.label.slice(0, 24)}` });
      terminal.show();
      terminal.sendText(command);
    }
    pick.hide();
  });
  pick.onDidAccept(async () => {
    const session = pick.selectedItems[0]?.session;
    pick.hide();
    if (session) await openSession(deps, session);
  });
  pick.onDidHide(() => pick.dispose());
}

async function pickCombo(deps: Deps): Promise<void> {
  const { combos, status } = await loadCombos(deps.appRoot);
  if (combos.length === 0) {
    void deps.info(
      status === "invalid"
        ? "combos.json could not be parsed. Fix it in the Grove app."
        : "No combos yet. Create one in the Grove app.",
    );
    return;
  }
  const current = (await currentCombo(deps))?.name;
  const choice = await vscode.window.showQuickPick(
    combos.map((c) => ({
      label: c.name,
      description: c.name === current ? "current" : undefined,
      detail: c.folders
        .map(
          (f) =>
            `${f.mode === "worktree" ? "$(git-branch)" : "$(folder)"} ${f.as ?? path.basename(f.path)}`,
        )
        .join("   "),
      combo: c,
    })),
    { placeHolder: "Open a combo in a new window" },
  );
  if (choice) await openCombo(deps, choice.combo);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "grove.openCombo";
  context.subscriptions.push(status);
  const deps = await buildDeps(context, status);

  context.subscriptions.push(
    vscode.commands.registerCommand("grove.findSession", () => findSession(deps)),
    vscode.commands.registerCommand("grove.openCombo", () => pickCombo(deps)),
    vscode.commands.registerCommand("grove.toggleLongWork", () => toggleLongWork(deps)),
    vscode.commands.registerCommand("grove.repairCombo", async () => {
      const combo = await currentCombo(deps);
      if (!combo) return void deps.info("This window is not a combo.");
      await repairCombo(combo, { gitPath: deps.gitPath });
      await checkDrift(deps, combo, false);
    }),
  );

  // an intent can arrive long after activation, when the app re-opens a workspace that is already open
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(pendingDir(deps.appRoot)), "*.json"),
  );
  watcher.onDidCreate(() => void drainIntents(deps, "watch"));
  watcher.onDidChange(() => void drainIntents(deps, "watch"));
  context.subscriptions.push(
    watcher,
    deps.onDidFocus(() => void drainIntents(deps, "focus")),
  );

  // activation stays cheap. everything else runs in the background.
  void runStartup(deps).catch((e) => deps.log(`startup failed: ${String(e)}`));
}

export function deactivate(): void {}
