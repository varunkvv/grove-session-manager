import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { validateBranchName } from "../../src/git/branch.ts";
import { runGit } from "../../src/git/exec.ts";
import { makeRepo } from "../helpers/git.ts";
import { makeSandbox } from "../helpers/transcript.ts";

const VALID = [
  "dev/eng-218",
  "prod-debug",
  "main",
  "release/2026.09",
  "a@b",
  "fix_#12",
  "ünï/çode",
];

const INVALID = [
  "",
  "-x",
  "a..b",
  "a b",
  "x.lock",
  "a/x.lock/b",
  "/x",
  "x/",
  "a//b",
  "@",
  "HEAD",
  "a~1",
  "a^",
  "a:b",
  "a?",
  "a*",
  "a[0]",
  "a\\b",
  "a@{1}",
  ".hidden",
  "a/.b",
  "trailing.",
  "tab\there",
  "del\x7f",
];

describe("validateBranchName", () => {
  it.each(VALID)("accepts %j", (name) => {
    expect(validateBranchName(name)).toBeNull();
  });

  it.each(INVALID)("rejects %j with a sentence", (name) => {
    const problem = validateBranchName(name);
    expect(problem).toEqual(expect.any(String));
    expect(problem!.length).toBeGreaterThan(5);
  });
});

describe("validateBranchName against git itself", () => {
  const repo = path.join(makeSandbox("grove-git-branch-"), "repo");

  beforeAll(async () => {
    await makeRepo(repo);
  });

  it("agrees with `git check-ref-format --branch`, except for '@' which git lets through", async () => {
    // "" never reaches git as an argument worth asking about, and a NUL-free name is all execFile takes
    for (const name of [...VALID, ...INVALID.filter((n) => n !== "" && n !== "@")]) {
      const verdict = await runGit(["check-ref-format", "--branch", name], { cwd: repo });
      expect([name, verdict.ok]).toEqual([name, validateBranchName(name) === null]);
    }
    expect((await runGit(["check-ref-format", "--branch", "@"], { cwd: repo })).ok).toBe(true);
  });
});
