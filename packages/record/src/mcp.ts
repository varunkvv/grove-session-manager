// the stdio MCP server. hand-rolled: JSON-RPC 2.0, one JSON message per line, no SDK.
// it is a transport and nothing more. it answers initialize before it touches the disk, lists
// its own registry, and hands each tools/call to the bundle that is on disk at that moment.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ErrCode, EXIT } from "./ops.ts";
import { renderInstructions } from "./render.ts";
import { mcpToolList, runTool, tool } from "./tools.ts";
import { BUNDLE_VERSION, SERVER_NAME } from "./version.ts";

const KNOWN_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Json = Record<string, unknown>;

/**
 * what the code on disk looks like right now. the shipped bundle is one file, so this is one
 * stat. run from source (tests, this prototype) it is every source file beside the entry.
 */
export function stampOf(entry: string): string {
  try {
    if (!/\.ts$/.test(entry)) {
      const s = fs.statSync(entry);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    }
    const dir = path.dirname(entry);
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".ts"))
      .sort()
      .map((n) => {
        const s = fs.statSync(path.join(dir, n));
        return `${n}:${s.ino}:${s.size}:${s.mtimeMs}`;
      })
      .join("|");
  } catch {
    return "missing";
  }
}

export interface ServerOptions {
  root: string;
  /** the file this process was started from: record.cjs, or src/bin.ts. */
  entry: string;
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  exit: (code: number) => void;
}

export function serve(o: ServerOptions): void {
  const loaded = stampOf(o.entry);
  const logDir = o.env.GROVE_RECORD_LOG;
  const log = (obj: Json) => {
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, `server-${process.pid}.jsonl`),
        `${JSON.stringify({ t: Date.now(), ...obj })}\n`,
      );
    } catch {
      // logging never breaks the protocol
    }
  };
  log({ ev: "start", version: BUNDLE_VERSION, root: o.root, entry: o.entry, ppid: process.ppid });

  const send = (msg: Json) => {
    o.output.write(`${JSON.stringify(msg)}\n`);
  };
  const reply = (id: unknown, result: Json) => send({ jsonrpc: "2.0", id, result });
  const error = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  // a failure carries its code in _meta, for grove's tests and tools. the model reads the text
  const text = (s: string, isError: boolean, code?: ErrCode) =>
    isError
      ? {
          content: [{ type: "text", text: s }],
          isError: true,
          _meta: { "grove/code": code ?? "unavailable" },
        }
      : { content: [{ type: "text", text: s }] };

  /**
   * run `record <args>` with the code that is on disk now. through the launcher when this server
   * was started by it (the launcher is what grove keeps pointed at a runtime that exists), else
   * with this process's own runtime.
   */
  const child = (args: string[], input: string, toolUseId?: string) => {
    const bin = o.env.GROVE_RECORD_BIN;
    const [cmd, pre] =
      bin && fs.existsSync(bin)
        ? [bin, [] as string[]]
        : [process.execPath, [...process.execArgv, o.entry]];
    return spawnSync(cmd, [...pre, ...args], {
      input,
      env: {
        ...o.env,
        GROVE_RECORD_ROOT: o.root,
        // the child's parent is this server, not claude. hand it the claude pid and the call's id
        CLAUDE_PID: String(process.ppid),
        GROVE_RECORD_TOOL_USE_ID: toolUseId ?? "",
      },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  };

  /** true once the bundle on disk is not the one this process loaded. it never goes back. */
  let stale = false;
  const isStale = (): boolean => {
    if (stale) return true;
    const now = stampOf(o.entry);
    if (now === loaded || now === "missing") return false;
    stale = true;
    log({ ev: "stale", loaded, now });
    return true;
  };

  /**
   * run the call with the code that is on disk now. while the bundle is the one this process
   * loaded, that is this process (2-5ms). once grove has replaced it, every call for the rest
   * of this server's life goes to a child running the new bundle as `record call <tool> -`.
   * so a session left open for a day never writes with an old build.
   */
  const call = (
    name: string,
    args: unknown,
    toolUseId: string | undefined,
  ): { text: string; isError: boolean; code?: ErrCode } => {
    const t0 = process.hrtime.bigint();
    let out: { text: string; isError: boolean; code?: ErrCode };
    let via: string;
    if (!isStale()) {
      via = "inproc";
      const r = runTool(name, args, { root: o.root, env: o.env, ppid: process.ppid, toolUseId });
      out = { text: r.text, isError: !r.ok, code: r.code };
    } else {
      via = "child";
      const c = child(["call", name, "-"], JSON.stringify(args ?? {}), toolUseId);
      if (c.error || c.status === null) {
        out = {
          text: `record unavailable: could not run ${o.entry} (${c.error?.message ?? `killed by ${c.signal}`}). Tell the person to open Grove once.`,
          isError: true,
        };
      } else if (c.status === 0) {
        out = { text: c.stdout.replace(/\n$/, ""), isError: false };
      } else {
        const code =
          (Object.keys(EXIT) as ErrCode[]).find((k) => EXIT[k] === c.status) ?? "unavailable";
        out = {
          text:
            (c.stderr || c.stdout).replace(/\n$/, "") ||
            `record unavailable: ${o.entry} exited ${c.status}`,
          isError: true,
          code,
        };
      }
    }
    log({
      ev: "call",
      tool: name,
      via,
      ms: Number(process.hrtime.bigint() - t0) / 1e6,
      isError: out.isError,
    });
    return out;
  };

  const handle = (msg: unknown) => {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg))
      return error(null, -32600, "Invalid Request");
    const m = msg as Json;
    // an answer to a request this server never sent (an older server asked for roots/list). ignore it
    if (
      m.method === undefined &&
      m.id !== undefined &&
      (m.result !== undefined || m.error !== undefined)
    )
      return;
    if (typeof m.method !== "string")
      return error(m.id === undefined ? null : m.id, -32600, "Invalid Request");
    // a notification gets no answer: notifications/initialized, notifications/cancelled, a roots change
    if (m.id === undefined) return;
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return reply(m.id, {
          protocolVersion:
            typeof asked === "string" && KNOWN_PROTOCOLS.includes(asked)
              ? asked
              : KNOWN_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: BUNDLE_VERSION },
          instructions: renderInstructions(),
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        // the list this session connected with. a tool added by an update reaches it after a restart
        return reply(m.id, { tools: mcpToolList() });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !name)
          return error(m.id, -32602, "Unknown tool: (no name)");
        const known = tool(name);
        if (!known || known.mcp === false) return error(m.id, -32602, `Unknown tool: ${name}`);
        const meta = (params._meta ?? {}) as Json;
        const toolUseId =
          typeof meta["claudecode/toolUseId"] === "string"
            ? (meta["claudecode/toolUseId"] as string)
            : undefined;
        const out = call(name, params.arguments, toolUseId);
        return reply(m.id, text(out.text, out.isError, out.code));
      }
      default:
        // includes server/discover, the probe claude code sends for the 2026-07-28 protocol.
        // "method not found" makes it fall back to initialize
        return error(m.id, -32601, `Method not found: ${m.method}`);
    }
  };

  let buf = "";
  o.input.setEncoding("utf8");
  o.input.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        error(null, -32700, "Parse error");
        continue;
      }
      try {
        handle(msg);
      } catch (e) {
        const id = (msg as Json | null)?.id;
        if (id !== undefined) error(id, -32603, `Internal error: ${(e as Error).message}`);
      }
    }
  });
  // claude code closes stdin when it goes away, also after kill -9. a server that stays is an orphan
  o.input.on("end", () => {
    log({ ev: "stdin-end" });
    o.exit(0);
  });
  o.output.on("error", () => o.exit(0));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => o.exit(0));
}
