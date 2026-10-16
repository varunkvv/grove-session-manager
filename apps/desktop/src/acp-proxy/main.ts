/**
 * grove's agent for zed. zed runs this as a custom agent server, and this runs claude code's own
 * acp adapter (the one zed installed) and passes every line through, both ways, as it is. one
 * exception: a new thread in a folder the app has just handed over becomes a load of the session
 * it handed over, under the same json-rpc id. zed has no extension api for the companion's work,
 * so this is where landing happens in zed.
 *
 * stdout is zed's json-rpc stream. nothing but the adapter's lines and that one answer goes there.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  claimIntent,
  getAppRoot,
  getStateDir,
  listIntents,
  loadCombos,
  matchIntent,
  samePath,
  sweepIntents,
  zedAdapterPath,
} from "@grove/core";

const appRoot = getAppRoot();
const logFile = path.join(getStateDir(appRoot), "acp.log");
const LOG_MAX_BYTES = 1_000_000;
const ADAPTER_MISSING =
  "Grove could not find Zed's Claude Code agent. Open a Claude Code thread in Zed once so Zed installs it, then try again.";

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: unknown;
}

function parse(line: string): Message | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Message) : null;
  } catch {
    return null;
  }
}

function startLog(): void {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) writeFileSync(logFile, "");
  } catch {
    // the log is for people. it never stops a thread
  }
}

function log(text: string): void {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} pid=${process.pid} ${text}\n`);
  } catch {
    // as above
  }
}

/** what a line is, for the log. never what it says */
function describe(m: Message | null): string {
  if (!m) return "unparsed";
  const parts = [m.method ? (m.id !== undefined ? "request" : "notification") : "response"];
  if (m.id !== undefined) parts.push(`id=${m.id}`);
  if (m.method) parts.push(`method=${m.method}`);
  const sid = m.params?.sessionId ?? m.result?.sessionId;
  if (typeof sid === "string") parts.push(`sid=${sid}`);
  if (typeof m.params?.cwd === "string") parts.push(`cwd=${m.params.cwd}`);
  if (Array.isArray(m.params?.additionalDirectories))
    parts.push(`dirs=${m.params.additionalDirectories.length}`);
  if (m.error !== undefined) parts.push("error");
  return parts.join(" ");
}

/** every complete line, in order, then whatever was left unterminated when the stream ends */
function eachLine(stream: NodeJS.ReadableStream, each: (line: string) => void, end: () => void) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) each(line);
  });
  stream.on("end", () => {
    if (rest) each(rest);
    end();
  });
}

const toZed = (line: string) => process.stdout.write(`${line}\n`);

/**
 * zed hands the agent a window's folders in its own order (alphabetical, seen 2026-10-15), so the
 * first one is not the combo folder. in a combo the combo folder is the cwd, as in vs code: its
 * CLAUDE.md and hooks apply, the session is listed under the combo, and a handoff can match it.
 */
async function comboFirst(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { cwd, additionalDirectories } = params;
  if (typeof cwd !== "string" || !Array.isArray(additionalDirectories)) return params;
  const extra = additionalDirectories.filter((d): d is string => typeof d === "string");
  try {
    const { combos } = await loadCombos(appRoot);
    const root = extra.find((d) => combos.some((c) => samePath(c.root, d)));
    if (!root) return params;
    return {
      ...params,
      cwd: root,
      additionalDirectories: [cwd, ...extra.filter((d) => d !== root)],
    };
  } catch (e) {
    log(`combos failed ${String(e)}`);
    return params;
  }
}

const SESSION_SETUP = new Set(["session/new", "session/load", "session/resume"]);

/** the session the app handed over for this folder, taken so no other window lands on it too */
async function claimFor(cwd: string): Promise<string | null> {
  try {
    const pick = (await listIntents(appRoot)).find(
      (i) => i.intent.kind === "resume" && matchIntent(i.intent, { root: cwd }) === "exact",
    );
    if (!pick) return null;
    const intent = await claimIntent(pick.file);
    if (intent?.kind !== "resume") return null;
    // sending a turn on the person's behalf is not something zed can be asked to do
    if (intent.prompt) log("prompt ignored");
    return intent.sessionId;
  } catch (e) {
    log(`intent failed ${String(e)}`);
    return null;
  }
}

/** no adapter to run: every request gets an error that says what to do */
function answerMissing(adapter: string): void {
  log(`adapter missing ${adapter}`);
  eachLine(
    process.stdin,
    (line) => {
      const m = parse(line);
      log(`zed ${describe(m)}`);
      if (m?.method && m.id !== undefined) {
        toZed(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32000, message: ADAPTER_MISSING },
          }),
        );
      }
    },
    () => {
      process.exitCode = 0;
    },
  );
}

function proxy(adapter: string): void {
  const child = spawn(process.execPath, [adapter, ...process.argv.slice(2)], {
    // its stderr still reaches Zed.log
    stdio: ["pipe", "pipe", "inherit"],
  });
  const toAgent = (line: string) => child.stdin.write(`${line}\n`);
  /** the one rewritten session/new in flight, and the replayed history held until its answer */
  let pending: { id: Id; sessionId: string; original: string; buffer: string[] } | null = null;

  async function fromZed(received: string): Promise<void> {
    let line = received;
    let m = parse(line);
    log(`zed ${describe(m)}`);
    if (m?.params && SESSION_SETUP.has(m.method ?? "")) {
      const params = await comboFirst(m.params);
      if (params !== m.params) {
        log(`cwd ${String(m.params.cwd)} -> ${String(params.cwd)}`);
        m = { ...m, params };
        line = JSON.stringify(m);
      }
    }
    const cwd = m?.params?.cwd;
    if (m?.method === "session/new" && m.id !== undefined && !pending && typeof cwd === "string") {
      const sessionId = await claimFor(cwd);
      if (sessionId) {
        pending = { id: m.id, sessionId, original: line, buffer: [] };
        log(`rewrite id=${m.id} sid=${sessionId} cwd=${cwd}`);
        toAgent(
          JSON.stringify({ ...m, method: "session/load", params: { ...m.params, sessionId } }),
        );
        return;
      }
    }
    toAgent(line);
  }

  function fromAgent(line: string): void {
    const m = parse(line);
    // its requests and responses. the stream of updates during a turn would bury them
    if (!m || m.id !== undefined) log(`agent ${describe(m)}`);
    if (!pending || !m) {
      toZed(line);
      return;
    }
    if (m.method === "session/update" && m.params?.sessionId === pending.sessionId) {
      pending.buffer.push(line);
      return;
    }
    if (m.method || m.id !== pending.id) {
      toZed(line);
      return;
    }

    const p = pending;
    pending = null;
    if (m.error !== undefined || !m.result) {
      // the transcript is gone, or will not load: a fresh thread, as in vs code
      log(`fallback id=${p.id} sid=${p.sessionId} dropped=${p.buffer.length}`);
      toAgent(p.original);
      return;
    }
    if (typeof m.result.sessionId === "string") toZed(line);
    else toZed(JSON.stringify({ ...m, result: { ...m.result, sessionId: p.sessionId } }));
    for (const held of p.buffer) toZed(held);
    log(`flush id=${p.id} sid=${p.sessionId} n=${p.buffer.length}`);
    void sweepIntents(appRoot).catch(() => {});
  }

  // zed's lines go to the adapter in the order they came, even while one waits on an intent
  let chain = Promise.resolve();
  eachLine(
    process.stdin,
    (line) => {
      chain = chain.then(() => fromZed(line));
    },
    () => {
      chain = chain.then(() => void child.stdin.end());
    },
  );
  eachLine(child.stdout, fromAgent, () => {});

  child.stdin.on("error", () => {
    // the adapter went away. its close handler ends this too
  });
  process.stdout.on("error", () => child.kill());
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (e) => {
    log(`agent spawn failed ${String(e)}`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    log(`agent exit code=${code} signal=${signal}`);
    process.stdout.write("", () => process.exit(code ?? 1));
  });
}

startLog();
const adapter = process.env.GROVE_ACP_ADAPTER || zedAdapterPath();
if (existsSync(adapter)) proxy(adapter);
else answerMissing(adapter);
