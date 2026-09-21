import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeProjectSlug, getStateDir } from "@grove/core";
import type { Deps, StatusView } from "../../src/deps.ts";

export const SID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
};

export interface Fake {
  deps: Deps;
  base: string;
  commands: Array<{ id: string; args: unknown[] }>;
  uris: string[];
  opened: Array<{ target: string; newWindow: boolean }>;
  warnings: string[];
  infos: string[];
  clipboard: string[];
  status: StatusView[];
  logs: string[];
}

export function sandbox(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-ext-")));
}

export function writeSession(projectsDir: string, cwd: string, sessionId: string): string {
  const dir = path.join(projectsDir, claudeProjectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const entry = {
    type: "user",
    message: { role: "user", content: "hello" },
    cwd,
    sessionId,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(entry)}\n`);
  return file;
}

export function fakeDeps(
  over: Partial<Deps> & { root?: string; commandFails?: string } = {},
): Fake {
  const base = sandbox();
  const appRoot = path.join(base, "claude-ws");
  const projectsDir = path.join(base, "claude", "projects");
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  const memory = new Map<string, unknown>();
  const fake: Fake = {
    base,
    commands: [],
    uris: [],
    opened: [],
    warnings: [],
    infos: [],
    clipboard: [],
    status: [],
    logs: [],
    deps: undefined as unknown as Deps,
  };
  fake.deps = {
    appRoot,
    projectsDir,
    stateDir: getStateDir(appRoot),
    uriScheme: "vscode",
    settings: { reconcileOnStartup: true, syncAdditionalDirectories: true },
    workspace: () => ({ root: over.root }),
    isTrusted: () => true,
    isFocused: () => true,
    onDidFocus: () => ({ dispose() {} }),
    activateClaude: async () => true,
    executeCommand: async (id, ...args) => {
      fake.commands.push({ id, args });
      if (over.commandFails) throw new Error(over.commandFails);
    },
    openExternalPinned: async (uri) => {
      fake.uris.push(uri);
      return true;
    },
    openFolder: async (target, newWindow) => void fake.opened.push({ target, newWindow }),
    copy: async (text) => void fake.clipboard.push(text),
    info: async (m) => void fake.infos.push(m),
    warn: async (m) => void fake.warnings.push(m),
    log: (m) => void fake.logs.push(m),
    memory: { get: (k) => memory.get(k) as never, set: async (k, v) => void memory.set(k, v) },
    setStatus: (v) => void fake.status.push(v),
    delay: async () => {},
    ...over,
  };
  return fake;
}
