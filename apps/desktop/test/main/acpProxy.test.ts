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
  const envLog = path.join(dir, "fake-env.json");
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      // a terminal in vs code exports it. a test sets it when it wants it
      ELECTRON_RUN_AS_NODE: undefined,
      GROVE_ROOT: dir,
      GROVE_ACP_ADAPTER: FAKE,
      FAKE_ACP_LOG: fakeLog,
      FAKE_ACP_ENV_LOG: envLog,
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
    /** what the adapter found in its environment */
    adapterEnv: () => JSON.parse(readFileSync(envLog, "utf8")),
    send: (line: string) => child.stdin.write(`${line}\n`),
    /** zed closes the pipe: the adapter ends, then the proxy */
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
}

/** an intent whose zed://agent link went out a while ago: a thread lands after the short settle */
const linkSent = () => Date.now() - 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it("run by grove's binary as node, the adapter does not pass that on to what it starts", async () => {
    // node ignores the variable, so this is zed running grove's binary, without electron
    const p = start({ ELECTRON_RUN_AS_NODE: "1" });
    p.send(req(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    expect(p.adapterEnv()).toEqual({ ELECTRON_RUN_AS_NODE: null });
    expect(await p.close()).toBe(0);
  });

  it("a new thread in the handed-over folder loads the session, its history after the answer", async () => {
    const p = start();
    await writeIntent(
      p.dir,
      { sessionId: SID, cwd: p.root, prompt: "continue", issuedAt: linkSent() },
      "zed",
    );
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
    expect(readdirSync(pendingDir(p.dir, "zed"))).toEqual([]);

    const log = readFileSync(path.join(p.dir, ".grove", "acp.log"), "utf8");
    expect(log).toMatch(new RegExp(`rewrite id=7 sid=${SID}`));
    expect(log).toMatch(/flush id=7 .* n=2/);
    expect(log).toContain("prompt ignored");
    expect(await p.close()).toBe(0);
  });

  it("in a combo window the combo folder is the cwd, whatever order zed sends the folders in", async () => {
    const p = start();
    // sorts before the combo folder, the way zed hands them over
    const ref = path.join(p.dir, "a-ref");
    mkdirSync(ref);
    writeFileSync(
      path.join(p.dir, "combos.json"),
      JSON.stringify({
        combos: [{ name: "combo", root: p.root, folders: [{ path: ref, mode: "reference" }] }],
      }),
    );
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root, issuedAt: linkSent() }, "zed");
    const zedSays = { cwd: ref, mcpServers: [], additionalDirectories: [p.root] };
    p.send(req(7, "session/new", zedSays));
    await vi.waitFor(() => expect(p.out).toHaveLength(4), { timeout: 10_000 });
    // a second thread in the same window, nothing handed over: a new one, at the combo folder too
    p.send(req(8, "session/new", zedSays));
    await vi.waitFor(() => expect(p.out).toHaveLength(5), { timeout: 10_000 });

    const atRoot = { cwd: p.root, mcpServers: [], additionalDirectories: [ref] };
    expect(parsed(p.received())).toEqual([
      { jsonrpc: "2.0", id: 7, method: "session/load", params: { ...atRoot, sessionId: SID } },
      { jsonrpc: "2.0", id: 8, method: "session/new", params: atRoot },
    ]);
    expect(parsed(p.out)[0].result.sessionId).toBe(SID);
    expect(parsed(p.out)[4].result.sessionId).toBe("new-1");
    expect(await p.close()).toBe(0);
  });

  it("of two new threads at once, the second lands: zed closes the first, its restored draft", async () => {
    const p = start();
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root, issuedAt: linkSent() }, "zed");
    const draft = req(7, "session/new", { cwd: p.root, mcpServers: [] });
    p.send(draft);
    p.send(req(8, "session/new", { cwd: p.root, mcpServers: [] }));
    await vi.waitFor(() => expect(p.out).toHaveLength(5), { timeout: 10_000 });

    const sent = p.received();
    expect(sent[0]).toBe(draft);
    expect(JSON.parse(sent[1]!)).toMatchObject({
      id: 8,
      method: "session/load",
      params: { sessionId: SID },
    });
    const answers = parsed(p.out).filter((o) => o.id !== undefined);
    expect(answers.find((a) => a.id === 7).result.sessionId).toBe("new-1");
    expect(answers.find((a) => a.id === 8).result.sessionId).toBe(SID);
    expect(await p.close()).toBe(0);
  });

  it("a thread zed started as the window opened waits for the one grove's link starts, seconds later", async () => {
    const p = start();
    p.send(req(1, "initialize", { protocolVersion: 1, clientCapabilities: {} }));
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    // the link goes 3s after the intent and its thread may take 1.5s more: about 2.5s from now
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root, issuedAt: Date.now() - 2000 }, "zed");
    const draft = req(7, "session/new", { cwd: p.root, mcpServers: [] });
    p.send(draft);
    await sleep(1000);
    // well past the short settle, still held
    expect(p.received()).toHaveLength(1);
    p.send(req(8, "session/new", { cwd: p.root, mcpServers: [] }));
    await vi.waitFor(() => expect(p.out).toHaveLength(6), { timeout: 10_000 });

    const sent = p.received();
    expect(sent[1]).toBe(draft);
    expect(JSON.parse(sent[2]!)).toMatchObject({
      id: 8,
      method: "session/load",
      params: { sessionId: SID },
    });
    const answers = parsed(p.out).filter((o) => o.id !== undefined);
    expect(answers.find((a) => a.id === 7).result.sessionId).toBe("new-1");
    expect(answers.find((a) => a.id === 8).result.sessionId).toBe(SID);
    expect(await p.close()).toBe(0);
  });

  it("a folder nothing was handed over for gets a plain new thread", async () => {
    const p = start();
    const other = path.join(p.dir, "other");
    mkdirSync(other);
    await writeIntent(p.dir, { sessionId: SID, cwd: other }, "zed");
    // a new conversation has no session to load: zed's own new thread is already that
    await writeIntent(p.dir, { kind: "new", cwd: p.root }, "zed");
    // a handoff for vs code's extension is not zed's to take
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root });
    const line = req(7, "session/new", { cwd: p.root, mcpServers: [] });
    p.send(line);
    await vi.waitFor(() => expect(p.out).toHaveLength(1), { timeout: 10_000 });
    expect(p.received()).toEqual([line]);
    expect(parsed(p.out)[0].result.sessionId).toBe("new-1");
    expect(readdirSync(pendingDir(p.dir, "zed"))).toHaveLength(2);
    expect(readdirSync(pendingDir(p.dir))).toHaveLength(1);
    expect(await p.close()).toBe(0);
  });

  it("a session that will not load falls back to the new thread zed asked for", async () => {
    const p = start({ FAKE_LOAD_FAILS: "1" });
    await writeIntent(p.dir, { sessionId: SID, cwd: p.root, issuedAt: linkSent() }, "zed");
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
