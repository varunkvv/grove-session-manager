import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gitEnv, resolveGitBinary, runGit, toTrace } from "../../src/git/exec.ts";
import { makeRepo } from "../helpers/git.ts";
import { makeSandbox } from "../helpers/transcript.ts";

describe("runGit", () => {
  const base = makeSandbox("grove-git-exec-");
  const repo = path.join(base, "repo");

  beforeAll(async () => {
    await makeRepo(repo);
  });

  it("ignores an inherited GIT_DIR that points somewhere bogus", async () => {
    const env = {
      ...process.env,
      GIT_DIR: "/nonexistent/bogus/.git",
      GIT_WORK_TREE: "/nonexistent/bogus",
      GIT_INDEX_FILE: "/nonexistent/bogus/index",
    };
    const viaOpts = await runGit(["rev-parse", "--show-toplevel"], { cwd: repo, env });
    expect(viaOpts).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(viaOpts.stdout.trim()).toBe(repo);

    // the way it really arrives: a hook or an editor terminal put it in our own environment
    process.env.GIT_DIR = "/nonexistent/bogus/.git";
    try {
      const inherited = await runGit(["rev-parse", "--show-toplevel"], { cwd: repo });
      expect(inherited.stdout.trim()).toBe(repo);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it("a failing command comes back as ok:false with stderr, and nothing throws", async () => {
    const bad = await runGit(["rev-parse", "--verify", "refs/heads/nope"], { cwd: repo });
    expect(bad).toMatchObject({ ok: false, exitCode: 128, timedOut: false });
    expect(bad.stderr).toContain("fatal");
    expect(bad.args).toEqual(["rev-parse", "--verify", "refs/heads/nope"]);

    const gone = await runGit(["status"], { cwd: path.join(base, "never-existed") });
    expect(gone.ok).toBe(false);
    expect(gone.stderr).toContain("cannot change to");

    // execFile itself throws on this one, before git ever runs
    const nul = await runGit(["rev-parse", "a\0b"], { cwd: repo });
    expect(nul).toMatchObject({ ok: false, exitCode: null, timedOut: false });
    expect(nul.stderr).not.toBe("");

    expect(toTrace(bad)).toEqual({
      args: ["rev-parse", "--verify", "refs/heads/nope"],
      exitCode: 128,
      stderr: bad.stderr.trim(),
    });
  });

  it("a timeout comes back as timedOut:true without waiting for the command", async () => {
    const started = Date.now();
    // blocks on a stdin that never ends
    const slow = await runGit(["hash-object", "--stdin"], { cwd: repo, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, exitCode: null, timedOut: true });
    expect(slow.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps the config overrides, drops the repo-local variables, extends PATH", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      GIT_DIR: "/x/.git",
      GIT_COMMON_DIR: "/x/.git",
      GIT_PREFIX: "sub/",
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
      GIT_PAGER: "cat",
    });
  });
});

describe("resolveGitBinary", () => {
  it("finds a real git, never a version-manager shim, and remembers the answer", async () => {
    const found = await resolveGitBinary();
    expect(path.isAbsolute(found)).toBe(true);
    expect(found).not.toContain("/shims/");
    expect(resolveGitBinary()).toBe(resolveGitBinary());
  });

  it("honours a configured path that works, falls through one that does not, and skips shims", async () => {
    const base = makeSandbox("grove-git-bin-");
    const fake = (dir: string) => {
      mkdirSync(path.join(base, dir));
      const file = path.join(base, dir, "git");
      writeFileSync(file, '#!/bin/sh\necho "git version 9.9.9"\n');
      chmodSync(file, 0o755);
      return file;
    };
    const configured = fake("bin");
    expect(await resolveGitBinary(configured)).toBe(configured);

    const fallback = await resolveGitBinary();
    expect(await resolveGitBinary("/nonexistent/bin/git")).toBe(fallback);
    // works when run, and is still passed over: a shim only works near a version file
    expect(await resolveGitBinary(fake("shims"))).toBe(fallback);
    expect(await resolveGitBinary("git")).toBe(fallback);
  });
});
