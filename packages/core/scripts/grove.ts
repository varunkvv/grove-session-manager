// dev CLI over the core.
//   pnpm grove list | search <query>         sessions            [--json] [--cache] [--stubs]
//   pnpm grove combos | reconcile <combo>    combos and their folder states
//   pnpm grove open <combo> [--session <id>] [--no-launch]
//   pnpm grove migrate-references [--apply]  working copies -> references + task worktrees (dry run unless --apply)
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assignCombos,
  type Combo,
  createSessionIndex,
  formatRelativeTime,
  getAppRoot,
  getProjectsDir,
  getStateDir,
  loadCombos,
  loadSettings,
  migrateReferences,
  openInEditor,
  prepareComboOpen,
  reconcileCombo,
  resolveEditor,
  searchSessions,
  workspaceFolders,
} from "../src/index.ts";

const [cmd = "list", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--session");

async function loadCombosIfAny(): Promise<Combo[]> {
  return (await loadCombos(getAppRoot())).combos;
}

async function findCombo(name: string | undefined): Promise<Combo> {
  const combo = (await loadCombosIfAny()).find((c) => c.name === name);
  if (!combo) {
    console.error(`no combo named ${JSON.stringify(name)} in ${getAppRoot()}/combos.json`);
    process.exit(1);
  }
  return combo;
}

async function sessions() {
  const index = createSessionIndex({
    projectsDir: getProjectsDir(),
    // the real cache only on request, so a dev listing never creates ~/claude-ws
    cacheDir: flags.has("--cache") ? getStateDir(getAppRoot()) : null,
  });
  await index.load();
  const started = performance.now();
  const stats = await index.refresh();
  const ms = Math.round(performance.now() - started);
  return { index, stats, ms, views: assignCombos(index.list(), await loadCombosIfAny()) };
}

function cell(s: string | undefined, width: number): string {
  const v = s ?? "";
  return v.length > width ? `${v.slice(0, width - 1)}…` : v.padEnd(width);
}

if (cmd === "list" || cmd === "search") {
  const { index, stats, ms, views } = await sessions();
  const real = flags.has("--stubs") ? views : views.filter((v) => !v.stub);
  const rows = cmd === "search" ? searchSessions(real, args.join(" ")) : real;
  if (flags.has("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const r of rows) {
      const where = r.comboName ?? (r.cwd ? path.basename(r.cwd) : r.projectDirName);
      console.log(
        [
          cell(formatRelativeTime(r.activityMs), 8),
          cell(where, 22),
          cell(r.gitBranch, 26),
          cell(r.titleSource ?? "-", 12),
          cell(r.title ?? `(untitled) ${path.basename(r.path)}`, 90),
        ].join(" "),
      );
    }
    console.error(
      `\n${rows.length} of ${real.length} sessions. ${stats.cacheHits} cached, ${stats.parsed} parsed in ${ms}ms. health: ${index.health()}`,
    );
  }
} else if (cmd === "combos") {
  for (const c of await loadCombosIfAny()) {
    console.log(`${c.name}  ${c.root}`);
    for (const f of c.folders)
      console.log(`  ${f.mode.padEnd(9)} ${f.path}${f.branch ? `  (${f.branch.kind})` : ""}`);
  }
} else if (cmd === "reconcile") {
  for (const s of await reconcileCombo(await findCombo(args[0]), { dirty: true })) {
    console.log(
      `${s.state.padEnd(14)} ${s.target}  ${s.branch ?? ""}${s.dirty ? " (dirty)" : ""}  ${s.message ?? ""}`,
    );
  }
} else if (cmd === "open") {
  const combo = await findCombo(args[0]);
  const sessionAt = rest.indexOf("--session");
  const editor = resolveEditor(await loadSettings(getAppRoot()));
  const report = await prepareComboOpen(getAppRoot(), combo, {
    sessionId: sessionAt >= 0 ? rest[sessionAt + 1] : undefined,
    source: "cli",
    editor: editor.id,
  });
  for (const o of report.outcomes)
    console.log(`${o.action.padEnd(16)} ${o.target}  ${o.message ?? ""}`);
  console.log(
    `workspace: ${report.workspaceFile}${report.intentFile ? `\nintent:    ${report.intentFile}` : ""}`,
  );
  if (!flags.has("--no-launch")) {
    const res = await openInEditor(editor, {
      workspaceFile: report.workspaceFile,
      folders: workspaceFolders(combo),
    });
    console.log(res.ok ? `launched ${res.value.bin}` : `could not launch: ${res.error.message}`);
  }
} else if (cmd === "migrate-references") {
  const apply = flags.has("--apply");
  if (apply) {
    // the app edits combos.json too
    const running = (() => {
      try {
        return execFileSync("pgrep", ["-x", "Grove"]).length > 0;
      } catch {
        return false;
      }
    })();
    if (running) {
      console.error("Grove.app is running and edits combos.json. quit it, then run this again.");
      process.exit(1);
    }
  }
  const report = await migrateReferences(getAppRoot(), await loadCombosIfAny(), { apply });
  for (const c of report.combos) {
    if (!c.folders.length && !c.claudeMd.length) continue;
    console.log(c.combo);
    for (const f of c.folders)
      console.log(
        `  ${f.action.padEnd(7)} ${f.path}  ${f.from}${f.to ? ` -> ${f.to}` : ""}  ${f.message}`,
      );
    for (const m of c.claudeMd) console.log(`  CLAUDE.md  ${m}`);
  }
  console.log(
    `\n${apply ? "" : "dry run, nothing changed. "}${apply ? "moved" : "would move"} ${report.moved} worktrees, flipped ${report.flipped} folders, ${report.kept} left as is`,
  );
  if (!apply) console.log("run with --apply to do it");
} else {
  console.error(
    "usage: grove list | search <query> | combos | reconcile <combo> | open <combo> [--session <id>] [--no-launch] | migrate-references [--apply]",
  );
  process.exit(2);
}
