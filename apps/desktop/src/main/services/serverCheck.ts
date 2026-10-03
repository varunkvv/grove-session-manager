// the start-up self-check (decision 14a). per project: spawn the real launcher the way a session
// started from Finder would, then initialize, tools/list and a read-only record_state call on one
// connection. a server that cannot start must not be silent.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Combo, ComboSyncReport } from "@grove/core";
import type { ServerCheck } from "../../shared/ipc.ts";
import { OpQueue } from "../opQueue.ts";

type Failed = Extract<ServerCheck, { state: "failed" }>;
type RpcMessage = { id?: unknown; result?: Record<string, unknown>; error?: { message?: string } };

/** a session started from Finder or the Dock gets this PATH, the worst case there is */
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const TIMEOUT_MS = 5000;

export interface ServerCheckOptions {
  launcher: string;
  bundle: string;
  appVersion: string;
  /** passed to the server when main has one */
  claudeConfigDir?: string;
  /** the last sync's report for a combo root */
  report: (root: string) => ComboSyncReport | undefined;
  /** installRecordRuntime again. run once when the launcher or the bundle file is missing */
  repair: () => Promise<unknown>;
  onResult?: (combo: Combo, check: ServerCheck) => void;
  timeoutMs?: number;
}

/** what the last sync left undone. read from the statuses too: an unexpected shape has no warning */
export function configProblem(report: ComboSyncReport | undefined): string | undefined {
  if (!report || report.skipped) return undefined;
  if (report.disabled)
    return "the grove server is turned off for this project in .claude/settings.local.json";
  if (report.warnings.length > 0) return report.warnings.map((w) => w.message).join(" ");
  if (report.mcp === "skipped-unexpected-shape")
    return `${report.root}/.mcp.json is not an object with an mcpServers object, so the grove server was not added.`;
  if (report.settings === "skipped-unexpected-shape")
    return `${report.root}/.claude/settings.local.json is not an object with a hooks object, so the grove server was not turned on.`;
  return undefined;
}

/** one exchange with `<launcher> mcp`, never longer than timeoutMs */
export function talkToServer(o: {
  launcher: string;
  root: string;
  appVersion: string;
  claudeConfigDir?: string;
  timeoutMs?: number;
}): Promise<ServerCheck> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  return new Promise((resolve) => {
    let stage: Failed["stage"] = "initialize";
    let stderr = "";
    let buffered = "";
    let tools = 0;
    let done = false;
    // the end of stderr, from the start of a line: a cut in the middle of a path reads as noise
    const tail = () => {
      const end = stderr.slice(-300);
      return (end.length < stderr.length ? end.slice(end.indexOf("\n") + 1) : end).trim();
    };
    const failed = (message: string, detail = tail()): Failed => ({
      state: "failed",
      checkedAt: Date.now(),
      stage,
      message,
      ...(detail ? { detail } : {}),
    });
    const noAnswer = (reason: string) => failed(`The record server did not answer: ${reason}.`);

    const child = spawn(o.launcher, ["mcp"], {
      env: {
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PATH: FINDER_PATH,
        GROVE_RECORD_ROOT: o.root,
        ...(o.claudeConfigDir ? { CLAUDE_CONFIG_DIR: o.claudeConfigDir } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (r: ServerCheck) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill(), 500).unref();
      resolve(r);
    };
    const timer = setTimeout(() => finish(noAnswer(`no answer in ${timeoutMs}ms`)), timeoutMs);
    const send = (msg: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

    child.on("error", (e) => {
      stage = "spawn";
      finish(failed(`The record server could not start: ${e.message}.`));
    });
    // close, not exit: stdout may still hold the answer when the process is gone
    child.on("close", (code) => finish(noAnswer(`exited ${code} before answering`)));
    // a write after the server died is an EPIPE. close reports it
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.stdout.on("data", (d) => {
      buffered += d;
      for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        answer(msg);
      }
    });

    function answer(msg: RpcMessage) {
      if (msg.id === 1) {
        if (msg.error) return finish(noAnswer(String(msg.error.message)));
        stage = "tools/list";
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list" });
      } else if (msg.id === 2) {
        if (msg.error) return finish(noAnswer(String(msg.error.message)));
        const list = Array.isArray(msg.result?.tools)
          ? (msg.result.tools as { name?: unknown }[])
          : [];
        if (!list.some((t) => t.name === "record_state"))
          return finish(failed("The record server answered without its tools."));
        tools = list.length;
        stage = "record_state";
        send({ id: 3, method: "tools/call", params: { name: "record_state", arguments: {} } });
      } else if (msg.id === 3) {
        const content = msg.result?.content as { text?: string }[] | undefined;
        const text = msg.error?.message ?? content?.[0]?.text ?? "";
        if (msg.error || msg.result?.isError) {
          const why = text.trim().replace(/\.$/, "");
          return finish(failed(`The record server cannot read this project: ${why}.`));
        }
        finish({ state: "ok", checkedAt: Date.now(), ms: Date.now() - t0, tools });
      }
    }

    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "grove-check", version: o.appVersion },
      },
    });
  });
}

/** every project's last check, two at a time. a second ask for a project still queued joins it */
export class ServerChecks {
  readonly results = new Map<string, ServerCheck>();
  private readonly o: ServerCheckOptions;
  private readonly queue = new OpQueue<"check">({ check: 2 });

  constructor(o: ServerCheckOptions) {
    this.o = o;
  }

  run(combo: Combo): Promise<ServerCheck> {
    return this.queue.run("check", () => this.check(combo), { key: combo.root });
  }

  async runAll(combos: readonly Combo[]): Promise<void> {
    await Promise.all(combos.map((c) => this.run(c)));
  }

  private async check(combo: Combo): Promise<ServerCheck> {
    const problem = configProblem(this.o.report(combo.root));
    const talk = () =>
      talkToServer({
        launcher: this.o.launcher,
        root: combo.root,
        appVersion: this.o.appVersion,
        claudeConfigDir: this.o.claudeConfigDir,
        timeoutMs: this.o.timeoutMs,
      });
    let r: ServerCheck = problem
      ? { state: "failed", checkedAt: Date.now(), stage: "config", message: problem }
      : await talk();
    // .grove is a cache dir anyone may delete. put the files back once before saying it is broken
    if (r.state === "failed" && r.stage !== "config" && !this.installed()) {
      await this.o.repair();
      r = await talk();
    }
    this.results.set(combo.root, r);
    this.o.onResult?.(combo, r);
    return r;
  }

  private installed(): boolean {
    return existsSync(this.o.launcher) && existsSync(this.o.bundle);
  }
}
