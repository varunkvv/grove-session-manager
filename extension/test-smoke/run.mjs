// opt-in: `pnpm --filter grove-companion smoke`. opens a throwaway VS Code window with an
// isolated profile, the built companion, and a fake anthropic.claude-code. no download: it uses the
// installed editor.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectSlug, pendingDir, writeIntent } from "@grove/core";
import { runTests } from "@vscode/test-electron";

const here = import.meta.dirname;
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-smoke-")));
const appRoot = path.join(base, "claude-ws");
const claudeDir = path.join(base, "claude");
const folder = path.join(base, "src", "api");
const session = "5eed5eed-0000-4000-8000-000000000001";
mkdirSync(folder, { recursive: true });

const project = path.join(claudeDir, "projects", claudeProjectSlug(folder));
mkdirSync(project, { recursive: true });
writeFileSync(
  path.join(project, `${session}.jsonl`),
  `${JSON.stringify({ type: "user", cwd: folder, sessionId: session, message: { content: "hi" } })}\n`,
);
await writeIntent(appRoot, { sessionId: session, cwd: folder, prompt: "continue from the app" });

// when this runs from a terminal inside VS Code, these make the editor binary behave like plain node
for (const key of Object.keys(process.env)) {
  if (key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS" || key.startsWith("VSCODE_"))
    delete process.env[key];
}

const editor =
  process.env.GROVE_SMOKE_EDITOR ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
await runTests({
  vscodeExecutablePath: editor,
  extensionDevelopmentPath: [path.join(here, ".."), path.join(here, "fake-claude")],
  extensionTestsPath: path.join(here, "suite.cjs"),
  launchArgs: [
    folder,
    "--disable-extensions",
    "--disable-workspace-trust",
    `--user-data-dir=${path.join(base, "user-data")}`,
  ],
  extensionTestsEnv: {
    GROVE_ROOT: appRoot,
    CLAUDE_CONFIG_DIR: claudeDir,
    GROVE_SMOKE_OUT: path.join(base, "opened.json"),
    GROVE_SMOKE_SESSION: session,
    GROVE_SMOKE_PENDING: pendingDir(appRoot),
  },
});
console.log("smoke ok: intent -> companion -> claude-vscode.primaryEditor.open(session, prompt)");
