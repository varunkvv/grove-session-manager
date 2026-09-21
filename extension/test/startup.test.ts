import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Combo, combosFilePath, ensureRoot, ensureWorktrees, writeIntent } from "@grove/core";
import { describe, expect, it } from "vitest";
import { openSession, toggleLongWork } from "../src/commands.ts";
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

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
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

describe("switching where long work runs, from inside the editor", () => {
  it("flips combos.json and the policy file a running session reads", async () => {
    const f = fakeDeps();
    const combo: Combo = {
      name: "prod-debug",
      root: path.join(f.deps.appRoot, "prod-debug"),
      folders: [],
    };
    writeFileSync(combosFilePath(f.deps.appRoot), JSON.stringify({ combos: [combo] }));
    await ensureRoot(combo);
    const deps = { ...f.deps, workspace: () => ({ root: combo.root }) };
    const policy = () => readFileSync(path.join(combo.root, ".claude", "long-work.md"), "utf8");

    expect(await toggleLongWork(deps)).toBe("foreground");
    expect(policy()).toContain("Do not hand it to the `long-task` agent");
    expect(
      JSON.parse(readFileSync(combosFilePath(f.deps.appRoot), "utf8")).combos[0].longWork,
    ).toBe("foreground");

    expect(await toggleLongWork(deps)).toBe("background");
    expect(policy()).toContain("to the `long-task`");
    expect(f.infos).toHaveLength(2);
  });

  it("a window that is not a combo has nothing to switch, and nothing is written", async () => {
    const probe = fakeDeps();
    const plain = repo(path.join(probe.base, "src", "api"));
    const f = fakeDeps({ root: plain });
    expect(await toggleLongWork(f.deps)).toBeNull();
    expect(existsSync(path.join(plain, ".claude"))).toBe(false);
  });
});

describe("find session -> open", () => {
  it("a session of this workspace resumes in place", async () => {
    const probe = fakeDeps();
    const here = repo(path.join(probe.base, "src", "api"));
    const f = fakeDeps({ root: here });
    writeSession(f.deps.projectsDir, here, SID.a);
    const view = { sessionId: SID.a, cwd: here } as never;
    expect(await openSession(f.deps, view)).toBe("command");
    expect(f.opened).toEqual([]);
  });

  it("a session from another folder writes an intent and opens that folder in a new window", async () => {
    const probe = fakeDeps();
    const here = repo(path.join(probe.base, "src", "api"));
    const there = repo(path.join(probe.base, "src", "web"));
    const f = fakeDeps({ root: here });
    expect(await openSession(f.deps, { sessionId: SID.b, cwd: there } as never)).toBe(
      "opened-folder",
    );
    expect(f.opened).toEqual([{ target: there, newWindow: true }]);
    expect(f.commands).toEqual([]);
  });

  it("a session whose folder is gone copies the resume command", async () => {
    const f = fakeDeps({ root: "/somewhere" });
    expect(await openSession(f.deps, { sessionId: SID.b, cwd: "/no/longer/here" } as never)).toBe(
      "copied",
    );
    expect(f.clipboard).toEqual([`claude --resume ${SID.b}`]);
  });
});
