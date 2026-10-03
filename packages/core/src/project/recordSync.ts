import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  allowRules,
  HOOK_MARKER,
  hookGroup,
  isLauncherAllowRule,
  mcpServerEntry,
  RULES_FILE,
  readProject,
  renderRules,
  SERVER_NAME,
  syncProject,
} from "@grove/record";
import { syncLongWorkPolicy } from "../combos/longWork.ts";
import { targetDirFor } from "../combos/schema.ts";
import { settingsLocalPath } from "../combos/settingsSync.ts";
import { isObject, readJsonGuarded, stringifyLike, writeFileAtomic } from "../fsx.ts";
import { getStateDir } from "../paths.ts";
import {
  type HookSyncStatus,
  statusEventsDir,
  statusHookCommand,
  syncComboStatusHooks,
  withStatusHooks,
} from "../sessions/liveStatus.ts";
import type { Combo, Warning } from "../types.ts";

/**
 * grove merges the record's files into a combo. @grove/record renders every byte of them, so
 * what grove writes cannot drift from the package that reads it. core only decides what to keep.
 */
export interface RecordInstall {
  /** <appRoot>/.grove/bin/record */
  launcher: string;
}

/** `hooks` with every group carrying the record's marker removed, then `group` added to SessionStart. the status groups are left alone. */
export function withRecordHook(hooks: unknown, group: object): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(hooks) ? { ...hooks } : {};
  const ours = (g: unknown) =>
    isObject(g) &&
    Array.isArray(g.hooks) &&
    g.hooks.some(
      (h) => isObject(h) && typeof h.command === "string" && h.command.includes(HOOK_MARKER),
    );
  for (const event of Object.keys(out)) {
    if (!Array.isArray(out[event])) continue;
    const kept = (out[event] as unknown[]).filter((g) => !ours(g));
    if (kept.length) out[event] = kept;
    else delete out[event];
  }
  out.SessionStart = [...(Array.isArray(out.SessionStart) ? out.SessionStart : []), group];
  return out;
}

/** the record's keys merged into a parsed settings.local.json. pure */
export function withRecordSettings(
  root: Record<string, unknown>,
  install: RecordInstall,
  comboRoot: string,
): { next: Record<string, unknown>; warning?: Warning; disabled?: boolean } {
  const file = path.join(comboRoot, ".claude", "settings.local.json");
  const next = { ...root };
  let warning: Warning | undefined;
  const warn = (message: string) => {
    warning = {
      code: "settings-record",
      message: warning ? `${warning.message} ${message}` : message,
    };
  };

  // the person said no in claude code's dialog: leave both lists alone
  const disabled =
    Array.isArray(root.disabledMcpjsonServers) && root.disabledMcpjsonServers.includes(SERVER_NAME);
  const enabled = root.enabledMcpjsonServers ?? [];
  if (!Array.isArray(enabled) || !enabled.every((s) => typeof s === "string")) {
    warn(
      `enabledMcpjsonServers in ${file} is not a list of names, so the grove server was not turned on.`,
    );
  } else if (!disabled && !enabled.includes(SERVER_NAME)) {
    next.enabledMcpjsonServers = [...enabled, SERVER_NAME];
  }

  const perms = root.permissions ?? {};
  if (!isObject(perms) || (perms.allow !== undefined && !Array.isArray(perms.allow))) {
    warn(`permissions.allow in ${file} is not a list, so the grove tools were not allowed.`);
  } else {
    const want = allowRules(install.launcher);
    // a launcher at an old path leaves a rule behind. any other entry is the person's
    const allow = ((perms.allow as unknown[] | undefined) ?? []).filter(
      (e) => !(typeof e === "string" && isLauncherAllowRule(e) && e !== want[1]),
    );
    for (const rule of want) if (!allow.includes(rule)) allow.push(rule);
    next.permissions = { ...perms, allow };
  }

  next.hooks = withRecordHook(
    root.hooks,
    hookGroup({ launcher: install.launcher, root: comboRoot }),
  );
  return { next, warning, ...(disabled ? { disabled } : {}) };
}

/** the status hooks and the record's keys in one read and one write of the combo's settings.local.json */
export async function syncComboSettings(
  appRoot: string,
  combo: Combo,
  install: RecordInstall,
): Promise<{ status: HookSyncStatus; warning?: Warning; disabled?: boolean }> {
  const file = settingsLocalPath(combo);
  const read = await readJsonGuarded(file);
  if (read.status === "invalid") {
    return {
      status: "skipped-invalid-json",
      warning: {
        code: "settings-invalid-json",
        message: `${file} is not valid JSON, so session status hooks were not added.`,
      },
    };
  }
  const root = read.status === "ok" ? read.value : {};
  if (!isObject(root) || (root.hooks !== undefined && !isObject(root.hooks))) {
    return { status: "skipped-unexpected-shape" };
  }
  const command = statusHookCommand(statusEventsDir(getStateDir(appRoot)));
  const { next, warning, disabled } = withRecordSettings(
    { ...root, hooks: withStatusHooks(root.hooks, command) },
    install,
    combo.root,
  );
  const extra = { ...(warning ? { warning } : {}), ...(disabled ? { disabled } : {}) };
  if (read.status === "ok" && JSON.stringify(next) === JSON.stringify(root)) {
    return { status: "unchanged", ...extra };
  }
  await writeFileAtomic(file, stringifyLike(next, read.status === "ok" ? read.text : undefined));
  return { status: read.status === "ok" ? "written" : "created", ...extra };
}

/** <root>/.mcp.json. grove owns mcpServers.grove and nothing else in it */
export async function syncMcpJson(
  combo: Combo,
  install: RecordInstall,
): Promise<{ status: HookSyncStatus; warning?: Warning }> {
  const file = path.join(combo.root, ".mcp.json");
  const entry = mcpServerEntry({ launcher: install.launcher, root: combo.root });
  const read = await readJsonGuarded(file);
  if (read.status === "missing") {
    await writeFileAtomic(file, stringifyLike({ mcpServers: { [SERVER_NAME]: entry } }));
    return { status: "created" };
  }
  if (read.status === "invalid") {
    return {
      status: "skipped-invalid-json",
      warning: {
        code: "mcp-invalid-json",
        message: `${file} is not valid JSON, so the grove server was not added.`,
      },
    };
  }
  const root = read.value;
  if (!isObject(root) || !isObject(root.mcpServers)) return { status: "skipped-unexpected-shape" };
  if (JSON.stringify(root.mcpServers[SERVER_NAME]) === JSON.stringify(entry)) {
    return { status: "unchanged" };
  }
  const next = { ...root, mcpServers: { ...root.mcpServers, [SERVER_NAME]: entry } };
  await writeFileAtomic(file, stringifyLike(next, read.text));
  return { status: "written" };
}

/** working copies whose own .mcp.json declares a server called grove. sessions started there use it instead of the project's */
export async function findShadowingServers(combo: Combo): Promise<string[]> {
  const dirs = combo.folders
    .filter((f) => f.mode === "worktree")
    .map((f) => targetDirFor(combo, f));
  const hits = await Promise.all(
    dirs.map(async (dir) => {
      const read = await readJsonGuarded(path.join(dir, ".mcp.json"));
      return read.status === "ok" &&
        isObject(read.value) &&
        isObject(read.value.mcpServers) &&
        Object.hasOwn(read.value.mcpServers, SERVER_NAME)
        ? dir
        : null;
    }),
  );
  return hits.filter((d) => d !== null);
}

export interface ComboSyncReport {
  root: string;
  skipped?: "no-root";
  settings: HookSyncStatus;
  mcp?: HookSyncStatus;
  rules?: "written" | "unchanged";
  project?: "written" | "unchanged" | "failed";
  /** the grove server is in disabledMcpjsonServers */
  disabled?: boolean;
  warnings: Warning[];
  /** working copies whose own .mcp.json declares a server called grove */
  shadowed: string[];
}

/** everything grove keeps current in one combo. install is undefined in the extension and in a dev build outside GROVE_ROOT */
export async function syncComboFiles(
  appRoot: string,
  combo: Combo,
  prefix: string,
  install?: RecordInstall,
): Promise<ComboSyncReport> {
  const report: ComboSyncReport = {
    root: combo.root,
    settings: "unchanged",
    warnings: [],
    shadowed: [],
  };
  // every write below would recreate a deleted root with only .claude in it
  const rootIsDir = await stat(combo.root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!rootIsDir) return { ...report, skipped: "no-root" };
  await syncLongWorkPolicy(combo);
  if (!install) {
    const s = await syncComboStatusHooks(appRoot, combo);
    if (s.warning) report.warnings.push(s.warning);
    return { ...report, settings: s.status };
  }

  const settings = await syncComboSettings(appRoot, combo, install);
  report.settings = settings.status;
  if (settings.warning) report.warnings.push(settings.warning);
  if (settings.disabled) report.disabled = true;

  const mcp = await syncMcpJson(combo, install);
  report.mcp = mcp.status;
  if (mcp.warning) report.warnings.push(mcp.warning);

  const rulesFile = path.join(combo.root, RULES_FILE);
  const rules = renderRules({ launcher: install.launcher, prefix, root: combo.root });
  report.rules = "unchanged";
  if ((await readFile(rulesFile, "utf8").catch(() => null)) !== rules) {
    await writeFileAtomic(rulesFile, rules);
    report.rules = "written";
  }

  // rev only goes up when syncProject wrote, so compare it rather than the result's wording
  const rev = readProject(combo.root)?.rev;
  const project = syncProject(combo.root, { prefix, name: combo.name, goal: combo.note ?? "" });
  if (!project.ok) {
    report.project = "failed";
    report.warnings.push({ code: "project-refused", message: project.text });
  } else {
    report.project = readProject(combo.root)?.rev === rev ? "unchanged" : "written";
  }

  report.shadowed = await findShadowingServers(combo);
  return report;
}
