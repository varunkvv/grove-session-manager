// shared by the tests: temp projects, fake agents, the CLI as a real process, a minimal MCP client.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncProject } from "../src/index.ts";
import { runTool } from "../src/tools.ts";

// the GROVE_RECORD_* identity overrides only work with this set (src/version.ts testOverrides)
process.env.GROVE_RECORD_TEST = "1";

export const PKG = path.resolve(import.meta.dirname, "..");
export const BIN = path.join(PKG, "src", "bin.ts");
export const BROKEN = path.join(PKG, "test", "broken.ts");

/** a fresh directory with a space in its path, removed at exit unless KEEP=1. */
export function tmpDir(label: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `grove-record ${label} `));
  if (process.env.KEEP !== "1")
    process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** a claude config folder that is never created: no test reads the real ~/.claude for a registry or a transcript. */
export const NO_CLAUDE = path.join(os.tmpdir(), "grove-record-test-no-claude");

/** the environment every test process runs with: nothing of the claude session that runs the tests leaks in. */
export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GROVE_RECORD_TEST: "1", CLAUDE_CONFIG_DIR: NO_CLAUDE };
  for (const k of ["HOME", "PATH", "TMPDIR", "USER", "LANG"])
    if (process.env[k]) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** a project folder set up the way grove's sync leaves it. */
export function makeProject(
  root: string,
  prefix = "AUTH",
  goal = "Org-wide SSO with okta, behind a flag, in two days.",
): string {
  fs.mkdirSync(root, { recursive: true });
  const r = syncProject(root, { prefix, name: path.basename(root), goal });
  if (!r.ok) throw new Error(r.text);
  return root;
}

/** a stand-in for a claude process: its pid is what a claim records, killing it is a dead agent. */
export class Agents {
  procs: ChildProcess[] = [];
  start(): number {
    const p = spawn("/bin/sleep", ["100000"], { stdio: "ignore" });
    this.procs.push(p);
    return p.pid!;
  }
  async kill(pid: number): Promise<void> {
    const p = this.procs.find((x) => x.pid === pid);
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    const gone = new Promise((res) => p.once("exit", res));
    p.kill("SIGKILL");
    await gone;
  }
  stopAll(): void {
    for (const p of this.procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  }
}

/** a claude code sessions registry entry, the way claude code writes it. */
export function writeRegistry(dir: string, pid: number, session: string, name = "fake"): void {
  const start = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  }).stdout.trim();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    `${JSON.stringify({ pid, sessionId: session, cwd: "/x", procStart: start, name, status: "busy" })}\n`,
  );
}

export interface Who {
  session: string;
  pid: number;
  agent?: string;
}

export function agentEnv(
  registry: string,
  who: Who | "person" | null,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = { GROVE_RECORD_REGISTRY: registry, ...extra };
  if (who === "person") base.GROVE_RECORD_ACTOR = "person";
  else if (who)
    Object.assign(base, {
      GROVE_RECORD_SESSION: who.session,
      GROVE_RECORD_PID: String(who.pid),
      GROVE_RECORD_AGENT: who.agent ?? who.session,
    });
  return cleanEnv(base);
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

/** `record call <tool> '<json>'` as a real process. */
export function cli(
  root: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  input?: string,
): CliResult {
  const r = spawnSync(process.execPath, [BIN, ...args, "--root", root], {
    env,
    encoding: "utf8",
    input: input ?? "",
    timeout: 30_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

export function call(
  root: string,
  env: NodeJS.ProcessEnv,
  tool: string,
  args: Record<string, unknown> = {},
): CliResult {
  return cli(root, env, ["call", tool, JSON.stringify(args)]);
}

// ---------- a minimal MCP client over stdio (port of experiments/mcp/stdio/driver.js) ----------

type Msg = Record<string, unknown> & {
  id?: unknown;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export class Client {
  child: ChildProcess;
  buf = "";
  stderr = "";
  nextId = 1;
  pending = new Map<unknown, (m: Msg) => void>();
  notifications: Msg[] = [];
  exited: Promise<{ code: number | null; sig: NodeJS.Signals | null }>;
  constructor(
    command: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (c: string) => this.onData(c));
    this.child.stderr!.on("data", (c) => (this.stderr += c));
    this.child.stdin!.on("error", () => {});
    this.exited = new Promise((res) => this.child.on("exit", (code, sig) => res({ code, sig })));
  }
  onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Msg;
      if (msg.method && msg.id === undefined) {
        this.notifications.push(msg);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p(msg);
      }
    }
  }
  write(msg: unknown): void {
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }
  raw(text: string): void {
    this.child.stdin!.write(text);
  }
  request(method: string, params?: unknown, id: unknown = this.nextId++): Promise<Msg> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }
  async init(): Promise<Msg> {
    const r = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }
  async call(
    name: string,
    args: Record<string, unknown> = {},
    toolUseId?: string,
  ): Promise<{ text: string; isError: boolean; raw: Msg }> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (toolUseId) params._meta = { "claudecode/toolUseId": toolUseId };
    const raw = await this.request("tools/call", params);
    const result = raw.result as { content?: { text: string }[]; isError?: boolean } | undefined;
    return {
      text: result?.content?.[0]?.text ?? JSON.stringify(raw.error ?? raw),
      isError: !!result?.isError || !!raw.error,
      raw,
    };
  }
  close(): Promise<{ code: number | null; sig: NodeJS.Signals | null }> {
    this.child.stdin!.end();
    return this.exited;
  }
}

/** an MCP server for one project, run from source, as one agent. */
export function server(
  root: string,
  env: NodeJS.ProcessEnv,
  opts: { broken?: string; entry?: string } = {},
): Client {
  const args = [...(opts.broken ? ["--import", BROKEN] : []), opts.entry ?? BIN, "mcp"];
  return new Client(process.execPath, args, {
    env: {
      ...env,
      GROVE_RECORD_ROOT: root,
      ...(opts.broken ? { GROVE_TEST_BROKEN: opts.broken } : {}),
    },
  });
}

export function readFrontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z_]+): (.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

/** run a tool in this process as an agent (pid = this test process, so it is alive). */
export function asAgent(
  root: string,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  agent = session,
): { ok: boolean; text: string; code?: string } {
  return runTool(tool, args, {
    root,
    env: cleanEnv({
      GROVE_RECORD_SESSION: session,
      GROVE_RECORD_PID: String(process.pid),
      GROVE_RECORD_AGENT: agent,
      GROVE_RECORD_REGISTRY: "/nonexistent",
    }),
  });
}

export function asPerson(
  root: string,
  tool: string,
  args: Record<string, unknown>,
): { ok: boolean; text: string; code?: string } {
  return runTool(tool, args, { root, env: cleanEnv(), person: true });
}

/**
 * a project of `n` cards that looks like a busy day: a third in progress, a quarter done, a few
 * canceled, three comments and a question on most, conclusions of each kind, some replaced.
 */
export function fixture(
  root: string,
  n: number,
  opts: { conclusions?: number; long?: boolean } = {},
): void {
  makeProject(root);
  const pad = opts.long
    ? " - with a title as long as a person would ever write for a card of this size, and then some more words"
    : "";
  for (let i = 1; i <= n; i++) {
    const s = `sess-${i % 7}`;
    const ok = (r: { ok: boolean; text: string }) => {
      if (!r.ok) throw new Error(r.text);
    };
    ok(
      asAgent(
        root,
        s,
        "card_create",
        {
          title: `card ${i}: the ${["api", "web", "infra", "tests"][i % 4]} part${pad}`,
          body: `brief for card ${i}\n\nwhat done looks like.`,
        },
        `agent ${i % 7}`,
      ),
    );
    const id = `AUTH-${i}`;
    for (let k = 1; k <= 3; k++)
      ok(asAgent(root, s, "comment_add", { card: id, text: `note ${k} on ${id}` }));
    const claim = () => ok(asAgent(root, `sess-c${i}`, "card_claim", { card: id }, `agent c${i}`));
    if (i % 4 === 0) {
      claim();
      ok(asAgent(root, `sess-c${i}`, "card_done", { card: id, summary: `done ${id}` }));
    } else if (i % 9 === 0) {
      claim();
      ok(asAgent(root, `sess-c${i}`, "card_release", { card: id, note: "stopped" }));
    } else if (i % 3 === 0) claim();
    else if (i % 11 === 0) ok(asPerson(root, "card_cancel", { card: id, reason: "not needed" }));
    if (i % 5 === 0)
      ok(
        asAgent(root, s, "question_ask", {
          card: id,
          text: `should ${id} do x or y? I would pick x.${pad}`,
          to: "person",
        }),
      );
    if (i % 10 === 0)
      ok(asAgent(root, s, "question_answer", { card: id, question: 4, text: "x", by: "person" }));
  }
  const kinds = ["decision", "finding", "verdict"];
  const m = opts.conclusions ?? n;
  for (let j = 1; j <= m; j++) {
    const kind = kinds[j % 3]!;
    const args: Record<string, unknown> = {
      kind,
      what: `conclusion ${j} about the ${["api", "web", "infra"][j % 3]}${pad}`,
      why: "because",
      card: `AUTH-${1 + (j % n)}`,
    };
    if (j > 6 && j % 6 === 0) args.replaces = `${kind[0]!.toUpperCase()}-${Math.floor(j / 3) - 1}`;
    args.by = j % 4 === 0 ? "person" : "agent";
    if (j % 7 === 0) args.changes_plan = true;
    // every second one came from somewhere, so the state's marker and its cost are in every size and speed test
    if (j % 2 === 0)
      args.sources = [
        { ref: `https://acme.slack.com/archives/C01/p${j}`, note: `the thread on ${j}${pad}` },
        { ref: `artifacts/digest-${j}.md` },
      ];
    const r = asAgent(root, `sess-${j % 7}`, "conclusion_record", args);
    if (!r.ok) throw new Error(r.text);
  }
}
