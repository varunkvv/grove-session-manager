import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectSlug } from "@grove/core";

export interface Fixture {
  dir: string;
  /** GROVE_ROOT */
  root: string;
  /** CLAUDE_CONFIG_DIR */
  claudeDir: string;
  projectsDir: string;
  extensionsDir: string;
  fakeCode: string;
  fakeOpen: string;
  execLog: string;
}

export interface FixtureOptions {
  withCompanion?: boolean;
  withClaude?: boolean;
}

const COMPANION_ID = "varunkvv.grove-companion";
const CLAUDE_ID = "anthropic.claude-code";

/** argv recorder. stands in for `code` and for `open`, so no window ever appears during a test. */
function writeFakeBin(file: string, label: string): void {
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '{"bin":"%s","argv":%s}\\n' "${label}" "$(printf '%s\\n' "$@" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | awk 'BEGIN{printf "["} {printf "%s\\"%s\\"", sep, $0; sep=","} END{printf "]"}')" >> "$GROVE_FAKE_LOG"\n`,
  );
  chmodSync(file, 0o755);
}

export function makeFixture(o: FixtureOptions = {}): Fixture {
  // realpath at once: /var/folders/... resolves to /private/var/..., and every slug, git
  // porcelain path and combo membership check compares real paths
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-e2e-")));
  const fx: Fixture = {
    dir,
    root: path.join(dir, "claude-ws"),
    claudeDir: path.join(dir, "claude"),
    projectsDir: path.join(dir, "claude", "projects"),
    extensionsDir: path.join(dir, "ext"),
    fakeCode: path.join(dir, "bin", "fake-code"),
    fakeOpen: path.join(dir, "bin", "fake-open"),
    execLog: path.join(dir, "exec.log"),
  };
  for (const d of [
    fx.root,
    fx.projectsDir,
    fx.extensionsDir,
    path.join(dir, "bin"),
    path.join(dir, "src"),
  ]) {
    mkdirSync(d, { recursive: true });
  }
  writeFakeBin(fx.fakeCode, "code");
  writeFakeBin(fx.fakeOpen, "open");
  writeFileSync(fx.execLog, "");

  const installed: unknown[] = [];
  if (o.withCompanion) {
    installed.push({
      identifier: { id: COMPANION_ID },
      version: "9.9.9",
      relativeLocation: "companion-9.9.9",
    });
  }
  if (o.withClaude) {
    installed.push({
      identifier: { id: CLAUDE_ID },
      version: "2.1.278",
      relativeLocation: "claude-2.1.278",
    });
  }
  writeFileSync(path.join(fx.extensionsDir, "extensions.json"), JSON.stringify(installed));
  return fx;
}

export interface SessionOptions {
  cwd: string;
  sessionId: string;
  title?: string;
  prompt?: string;
  branch?: string;
  /** what Claude said back. only the full-text search reads this far into a transcript. */
  reply?: string;
  /** how long ago the last message was. drives both the timestamps and the file's mtime. */
  ageMs?: number;
}

/** a transcript shaped like the real thing: entries first, appended title record last */
export function writeSession(fx: Fixture, o: SessionOptions): string {
  const at = Date.now() - (o.ageMs ?? 60_000);
  const stamp = (offset: number) => new Date(at + offset).toISOString();
  const envelope = {
    isSidechain: false,
    userType: "external",
    entrypoint: "claude-vscode",
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: "2.1.278",
    ...(o.branch ? { gitBranch: o.branch } : {}),
  };
  const lines = [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: stamp(-2000),
      sessionId: o.sessionId,
    },
    {
      type: "user",
      ...envelope,
      parentUuid: null,
      uuid: `${o.sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      timestamp: stamp(-1000),
      message: {
        role: "user",
        content: [{ type: "text", text: o.prompt ?? "hello from the fixture" }],
      },
    },
    {
      type: "assistant",
      ...envelope,
      parentUuid: `${o.sessionId.slice(0, 8)}-0000-4000-8000-000000000001`,
      uuid: `${o.sessionId.slice(0, 8)}-0000-4000-8000-000000000002`,
      timestamp: stamp(0),
      message: {
        role: "assistant",
        id: `msg_${o.sessionId.slice(0, 8)}`,
        model: "claude-opus-5",
        content: [{ type: "text", text: o.reply ?? "sure" }],
        usage: {
          input_tokens: 3,
          output_tokens: 1_200,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 8_000,
        },
      },
    },
    ...(o.title ? [{ type: "ai-title", aiTitle: o.title, sessionId: o.sessionId }] : []),
  ];
  const dir = path.join(fx.projectsDir, claudeProjectSlug(o.cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${o.sessionId}.jsonl`);
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const when = new Date(at);
  utimesSync(file, when, when);
  return file;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

/** a real repo, not a mock: the worktree layer is the thing under test */
export function makeRepo(fx: Fixture, name: string, o: { branches?: string[] } = {}): string {
  const dir = path.join(fx.dir, "src", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  for (const branch of o.branches ?? []) git(dir, "branch", branch);
  return dir;
}

export function makePlainDir(fx: Fixture, name: string): string {
  const dir = path.join(fx.dir, "src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "notes.txt"), "context\n");
  return dir;
}

export interface ExecLine {
  bin: string;
  argv: string[];
}

export function readExecLog(fx: Fixture): ExecLine[] {
  return readFileSync(fx.execLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecLine);
}
