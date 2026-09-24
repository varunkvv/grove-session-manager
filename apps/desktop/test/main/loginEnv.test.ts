import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENV_MARKER,
  fallbackPath,
  finishEnv,
  LoginEnv,
  loginShellArgs,
  parseEnvDump,
  type ShellRun,
} from "../../src/main/services/loginEnv.ts";

const HOME = "/Users/you";
const dump = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}\0`)
    .join("");

describe("the login shell's environment", () => {
  it("asks an interactive login shell for `env -0` behind a marker", () => {
    expect(loginShellArgs()).toEqual(["-ilc", `printf '${ENV_MARKER}\\0'; env -0`]);
  });

  it("reads what follows the marker, whatever the rc files printed first", () => {
    const out =
      "Last login: today\n\x1b[1mwelcome\x1b[0m\n" +
      `${ENV_MARKER}\0` +
      dump({ PATH: "/opt/homebrew/bin:/usr/bin", NOTE: "two\nlines", EMPTY: "", EQ: "a=b" });
    expect(parseEnvDump(out)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      NOTE: "two\nlines",
      EMPTY: "",
      EQ: "a=b",
    });
  });

  it("no marker, or nothing like an environment after it, is no answer", () => {
    expect(parseEnvDump("")).toBeNull();
    expect(parseEnvDump(dump({ PATH: "/usr/bin" }))).toBeNull();
    expect(parseEnvDump(`${ENV_MARKER}\0`)).toBeNull();
    expect(parseEnvDump(`${ENV_MARKER}\0${dump({ HOME })}`)).toBeNull();
    // the marker text alone, without its NUL, is not the marker
    expect(parseEnvDump(`${ENV_MARKER}${dump({ PATH: "/usr/bin" })}`)).toBeNull();
  });

  it("the fallback puts where claude and node usually live ahead of Finder's PATH, once", () => {
    expect(fallbackPath(HOME, "/usr/bin:/bin:/usr/sbin:/sbin")).toBe(
      "/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    expect(fallbackPath(HOME, "/opt/homebrew/bin:/usr/bin")).toBe(
      "/Users/you/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin",
    );
    expect(fallbackPath(HOME)).toBe("/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  it("drops what Electron and the shell leave behind, and names a config dir only when it is not the default", () => {
    const env = {
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      VSCODE_PID: "1",
      PWD: "/Users/you",
      OLDPWD: "/",
      SHLVL: "2",
      _: "/usr/bin/env",
      KEEP: "yes",
    };
    expect(finishEnv(env, { home: HOME, claudeConfigDir: `${HOME}/.claude` })).toEqual({
      PATH: "/usr/bin",
      KEEP: "yes",
    });
    expect(
      finishEnv({ PATH: "/usr/bin" }, { home: HOME, claudeConfigDir: "/tmp/claude" })
        .CLAUDE_CONFIG_DIR,
    ).toBe("/tmp/claude");
    // the shell's own stays when grove reads the default
    expect(
      finishEnv(
        { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/x" },
        { home: HOME, claudeConfigDir: `${HOME}/.claude` },
      ).CLAUDE_CONFIG_DIR,
    ).toBe("/x");
  });

  it("is asked once per app run, and a shell that fails falls back to the app's own plus the usual places", async () => {
    let calls = 0;
    const run: ShellRun = async () => {
      calls++;
      return calls === 1 ? null : `${ENV_MARKER}\0${dump({ PATH: "/never" })}`;
    };
    const env = new LoginEnv({
      home: HOME,
      base: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", GROVE_X: "1" },
      claudeConfigDir: () => `${HOME}/.claude`,
      useShell: true,
      shell: "/bin/zsh",
      run,
    });
    const first = await env.get();
    const second = await env.get();
    expect(calls).toBe(1);
    expect(first.PATH).toBe("/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    expect(first.GROVE_X).toBe("1");
    expect(first.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(second).toEqual(first);
  });

  it("a test root never runs the shell at all", async () => {
    let calls = 0;
    const env = new LoginEnv({
      home: HOME,
      base: { PATH: "/usr/bin" },
      claudeConfigDir: () => "/fixture/claude",
      useShell: false,
      run: async () => {
        calls++;
        return null;
      },
    });
    expect((await env.get()).CLAUDE_CONFIG_DIR).toBe("/fixture/claude");
    expect(calls).toBe(0);
  });

  it("runs a real shell with stdin closed and reads its dump", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-shell-")));
    const shell = path.join(dir, "fake-zsh");
    // ignores -ilc like no real shell would, and reads stdin like a careless rc file does
    writeFileSync(
      shell,
      `#!/bin/sh\necho "motd: $1"\nread -r answer\nprintf '${ENV_MARKER}\\000'\nFROM_SHELL=yes PATH=/from/shell /usr/bin/env -0\n`,
    );
    chmodSync(shell, 0o755);
    const env = await new LoginEnv({
      home: HOME,
      base: { PATH: "/usr/bin:/bin" },
      claudeConfigDir: () => `${HOME}/.claude`,
      useShell: true,
      shell,
    }).get();
    expect(env.FROM_SHELL).toBe("yes");
    expect(env.PATH).toBe("/from/shell");
  });
});
