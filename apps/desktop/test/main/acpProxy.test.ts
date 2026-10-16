import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingDir, writeIntent } from "@grove/core";
import { describe, expect, it, vi } from "vitest";

const PROXY = path.join(import.meta.dirname, "../../src/acp-proxy/main.ts");
const FAKE = path.join(import.meta.dirname, "helpers/fakeAcpAdapter.ts");
const SID = "e4c21fe2-66d7-4dda-b9e9-556afffba8e4";
const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-acp-")));

/** the proxy as zed runs it: a child process, json-rpc on stdio, against the fake adapter */
function start(env: Record<string, string> = {}) {
  const dir = sandbox();
  const root = path.join(dir, "combo");
  mkdirSync(root);
  const fakeLog = path.join(dir, "fake.log");
  writeFileSync(fakeLog, "");
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      GROVE_ROOT: dir,
      GROVE_ACP_ADAPTER: FAKE,
      FAKE_ACP_LOG: fakeLog,
      ...env,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const out: string[] = [];
  let rest = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    out.push(...parts);
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    dir,
    root,
    out,
    /** what the adapter was sent, line by line */
    received: () => readFileSync(fakeLog, "utf8").split("\n").filter(Boolean),
    send: (line: string) => child.stdin.write(`${line}\n`),
    /** zed closes the pipe: the adapter ends, then the proxy */
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
}

const req = (id: number, method: string, params: object) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l));

describe("the acp proxy between zed and claude code", () => {
  it("passes initialize through as it is, both ways", async () => {
    const p = start();
    const init = req(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    p.send(init);
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    expect(p.out[0]).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      }),
    );
    expect(p.received()).toEqual([init]);
    expect(await p.close()).toBe(0);
  });

  it("a new thread in the handed-over folder loads the session, its history after the answer", async () => {
    const p = start();
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root, prompt: "continue" });
    p.send(req(7, "session/new", { cwd: p.root, mcpServers: [] }));
    await vi.waitFor(() => expect(p.out).toHaveLength(4), { timeout: 10_000 });

    const sent = parsed(p.received());
    expect(sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        method: "session/load",
        params: { cwd: p.root, mcpServers: [], sessionId: SID },
      },
    ]);
    const [answer, ...updates] = parsed(p.out);
    expect(answer).toEqual({ jsonrpc: "2.0", id: 7, result: { modes: {}, sessionId: SID } });
    // the replay, held until the answer went out, then what came after it, straight through
    expect(updates.map((u) => u.params.update.content.text)).toEqual(["first", "second", "after"]);
    expect(updates.every((u) => u.method === "session/update" && u.params.sessionId === SID)).toBe(
      true,
    );
    // taken, so no other window lands on it
    expect(readdirSync(pendingDir(p.dir))).toEqual([]);

    const log = readFileSync(path.join(p.dir, ".grove", "acp.log"), "utf8");
    expect(log).toMatch(new RegExp(`rewrite id=7 sid=${SID}`));
    expect(log).toMatch(/flush id=7 .* n=2/);
    expect(log).toContain("prompt ignored");
    expect(await p.close()).toBe(0);
  });

  it("a folder nothing was handed over for gets a plain new thread", async () => {
    const p = start();
    const other = path.join(p.dir, "other");
    mkdirSync(other);
    await writeIntent(p.dir, { sessionId: SID, cwd: other });
    // a new conversation has no session to load: zed's own new thread is already that
    await writeIntent(p.dir, { kind: "new", cwd: p.root });
    const line = req(7, "session/new", { cwd: p.root, mcpServers: [] });
    p.send(line);
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    expect(p.received()).toEqual([line]);
    expect(parsed(p.out)[0].result.sessionId).toBe("new-1");
    expect(readdirSync(pendingDir(p.dir))).toHaveLength(2);
    expect(await p.close()).toBe(0);
  });

  it("a session that will not load falls back to the new thread zed asked for", async () => {
    const p = start({ FAKE_LOAD_FAILS: "1" });
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root });
    const line = req(7, "session/new", { cwd: p.root, mcpServers: [] });
    p.send(line);
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    expect(await p.close()).toBe(0);

    const sent = p.received();
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toMatchObject({ id: 7, method: "session/load" });
    expect(sent[1]).toBe(line);
    // one answer for id 7, the new thread's, and none of the half-replayed history
    expect(parsed(p.out)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { sessionId: "new-1", modes: {} } },
    ]);
  });

  it("without the adapter, every request says what to do, and it exits cleanly", async () => {
    const p = start({ GROVE_ACP_ADAPTER: "/nope/index.js" });
    p.send(req(1, "initialize", { protocolVersion: 1 }));
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    const [answer] = parsed(p.out);
    expect(answer.id).toBe(1);
    expect(answer.error.message).toMatch(/Claude Code thread in Zed/);
    expect(await p.close()).toBe(0);
    expect(existsSync(path.join(p.dir, ".grove", "acp.log"))).toBe(true);
  });
});
