import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Combo, combosFilePath, ensureRoot, ensureWorktrees, writeIntent } from "@grove/core";
import { describe, expect, it } from "vitest";
import { runStartup } from "../src/startup.ts";
import { fakeDeps, SID, writeSession } from "./helpers/fakeDeps.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

/**
 * the working tree only. git tidies its own directory in the background after a commit (a lock
 * or temp file can be there one moment and gone the next), and none of that is our doing. that
 * we never run git is asserted separately, with a git binary that does not exist.
 */
function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f !== ".git" && !f.startsWith(`.git${path.sep}`))
    .sort();
}

describe("startup", () => {
  it("a non-combo window only drains: zero writes, zero git calls", async () => {
    const probe = fakeDeps();
    const plain = repo(path.join(probe.base, "src", "api"));
    const f = fakeDeps({ root: plain, gitPath: "/nonexistent/git-must-not-run" });
    const before = listTree(plain);
    expect(await runStartup(f.deps)).toEqual({});
    expect(listTree(plain)).toEqual(before);
    expect(existsSync(path.join(plain, ".claude"))).toBe(false);
    expect(f.warnings).toEqual([]);
  });

  it("a non-combo window still lands on a handed-over session", async () => {
    const probe = fakeDeps();
    const plain = repo(path.join(probe.base, "src", "api"));
    const f = fakeDeps({ root: plain });
    writeSession(f.deps.projectsDir, plain, SID.a);
    await writeIntent(f.deps.appRoot, { sessionId: SID.a, cwd: plain });
    await runStartup(f.deps);
    expect(f.commands.map((c) => c.args[0])).toEqual([SID.a]);
  });

  it("a combo window: drain, then sync references, then reconcile and surface drift once, quietly", async () => {
    const probe = fakeDeps();
    const api = repo(path.join(probe.base, "src", "api"));
    const logs = path.join(probe.base, "src", "logs");
    mkdirSync(logs, { recursive: true });
    const f = fakeDeps();
    const combo: Combo = {
      name: "prod-debug",
      root: path.join(f.deps.appRoot, "prod-debug"),
      folders: [
        { path: api, mode: "worktree", branch: { kind: "detach" } },
        { path: logs, mode: "reference" },
      ],
    };
    writeFileSync(combosFilePath(f.deps.appRoot), JSON.stringify({ combos: [combo] }));
    await ensureRoot(combo);
    await ensureWorktrees(combo);
    const deps = { ...f.deps, workspace: () => ({ root: combo.root }) };

    expect(await runStartup(deps)).toEqual({ combo: "prod-debug" });
    const settings = JSON.parse(
      readFileSync(path.join(combo.root, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.permissions.additionalDirectories).toEqual([logs]);
    expect(f.warnings).toEqual([]);
    expect(f.status.at(-1)).toEqual({ combo: "prod-debug", drift: [] });

    // someone removes the worktree behind git's back. drift is a normal state: one quiet notice.
    rmSync(path.join(combo.root, "api"), { recursive: true, force: true });
    await runStartup(deps);
    expect(f.warnings).toHaveLength(1);
    expect(f.status.at(-1)!.drift).toHaveLength(1);
    await runStartup(deps);
    expect(f.warnings).toHaveLength(1);
  });
});
