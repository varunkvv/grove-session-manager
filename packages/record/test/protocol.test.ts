// the stdio MCP server against real claude code traffic, and the "run each call through the bundle
// on disk" rule of decision 1.
//
// replay: fixtures/claude-code-2.1.286-stdio.jsonl holds every message claude code 2.1.286 sent to
// the stdio probe in 83 real sessions, one line each, keyed by the probe's log file (home paths in the
// roots/list replies scrubbed). each client message is replayed, in order, into this server.
// the probe had other tools (new_card, claim, whoami), so those calls must come back as -32602
// unknown tool, and record_state, which exists in both, must work.
//
//   pnpm vitest run packages/record/test/protocol.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { BIN, cleanEnv, makeProject, PKG, server, tmpDir } from "./lib.ts";

const REPLAY = path.join(PKG, "test", "fixtures", "claude-code-2.1.286-stdio.jsonl");
const base = tmpDir("protocol");

type Line = { log: string; msg: Record<string, unknown> };

test("replay of real claude code 2.1.286 traffic", async () => {
  const logs = new Map<string, Line[]>();
  for (const l of fs.readFileSync(REPLAY, "utf8").split("\n").filter(Boolean)) {
    const line = JSON.parse(l) as Line;
    logs.set(line.log, [...(logs.get(line.log) ?? []), line]);
  }
  assert.ok(logs.size >= 70, `only ${logs.size} logs`);
  const tally = {
    files: 0,
    messages: 0,
    requests: 0,
    notifications: 0,
    clientReplies: 0,
    discover: 0,
    unknownTool: 0,
    stateCalls: 0,
  };
  for (const [f, lines] of logs) {
    tally.files++;
    const root = makeProject(path.join(base, `replay ${f}`));
    const c = server(
      root,
      cleanEnv({ GROVE_RECORD_SESSION: "replay", GROVE_RECORD_PID: String(process.pid) }),
    );
    const replies = new Map<unknown, Record<string, unknown>>();
    const extra: unknown[] = [];
    c.child.stdout!.removeAllListeners("data");
    let buf = "";
    c.child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (m.id !== undefined && !m.method) {
          if (replies.has(m.id)) extra.push(m);
          replies.set(m.id, m);
        } else extra.push(m);
      }
    });
    const expected: { id: unknown; method: string; name?: string }[] = [];
    for (const { msg } of lines) {
      tally.messages++;
      const m = msg;
      if (typeof m.method !== "string")
        tally.clientReplies++; // an answer to the probe's roots/list
      else if (m.id === undefined) tally.notifications++;
      else {
        tally.requests++;
        expected.push({
          id: m.id,
          method: m.method,
          name: (m.params as { name?: string } | undefined)?.name,
        });
      }
      c.write(m);
    }
    const end = await c.close();
    assert.equal(end.code, 0, `${f}: exit ${end.code} ${end.sig}`);
    assert.deepEqual(extra, [], `${f}: answers nobody asked for`);
    for (const e of expected) {
      const r = replies.get(e.id) as
        | { result?: Record<string, unknown>; error?: { code: number } }
        | undefined;
      assert.ok(r, `${f}: no answer to ${e.method} id ${String(e.id)}`);
      if (e.method === "server/discover") {
        tally.discover++;
        assert.equal(r.error?.code, -32601);
      } else if (e.method === "initialize") {
        assert.equal(r.result?.protocolVersion, "2025-11-25");
        assert.ok(typeof r.result?.instructions === "string");
      } else if (e.method === "tools/list") {
        const names = (r.result!.tools as { name: string }[]).map((t) => t.name);
        assert.ok(names.includes("record_state") && names.includes("conclusion_record"));
      } else if (e.method === "tools/call") {
        if (e.name === "record_state") {
          tally.stateCalls++;
          assert.ok(
            r.result && !r.result.isError,
            `${f}: record_state failed: ${JSON.stringify(r)}`,
          );
        } else {
          tally.unknownTool++;
          assert.equal(r.error?.code, -32602, `${f}: ${e.name} should be unknown here`);
        }
      }
    }
  }
  console.log(`replayed ${JSON.stringify(tally)}`);
});

test("framing, errors and exit", async () => {
  const root = makeProject(path.join(base, "framing"));
  const c = server(
    root,
    cleanEnv({ GROVE_RECORD_SESSION: "s-frame", GROVE_RECORD_PID: String(process.pid) }),
  );
  const init = await c.init();
  assert.deepEqual((init.result as { capabilities: unknown }).capabilities, { tools: {} });
  assert.ok((init.result as { instructions: string }).instructions.length < 600);
  // garbage does not kill it
  c.raw("this is not json\n");
  assert.deepEqual((await c.request("ping")).result, {});
  assert.equal((await c.request("resources/list")).error?.code, -32601);
  assert.equal(
    (await c.request("tools/call", { name: "project_init", arguments: { prefix: "X" } })).error
      ?.code,
    -32602,
    "a CLI-only tool is not served",
  );
  // a failure the agent can act on is a result, with the next step and a code
  const bad = await c.call("card_claim", { card: "AUTH-99" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /There is no card AUTH-99. Call record_state/);
  assert.equal(
    (bad.raw.result as { _meta: Record<string, string> })._meta["grove/code"],
    "not_found",
  );
  const badArgs = await c.call("conclusion_record", { kind: "guess", what: "x" });
  assert.match(badArgs.text, /"kind" must be one of: decision, finding, verdict/);
  const extraArg = await c.call("card_create", { title: "t", priority: "high" });
  assert.match(
    extraArg.text,
    /unknown argument "priority".*card_create takes: title \(required\), body, from, needs, as/,
  );
  // tools carry the hints decision 14 names
  const tools = (await c.request("tools/list")).result!.tools as {
    name: string;
    annotations?: { readOnlyHint?: boolean };
    _meta?: Record<string, boolean>;
  }[];
  const always = tools
    .filter((t) => t._meta?.["anthropic/alwaysLoad"])
    .map((t) => t.name)
    .sort();
  assert.deepEqual(always, [
    "card_claim",
    "conclusion_record",
    "my_cards",
    "question_ask",
    "record_state",
  ]);
  const ro = tools
    .filter((t) => t.annotations?.readOnlyHint)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(ro, ["card_show", "conclusion_search", "record_state"]);
  for (const t of tools)
    assert.ok(
      JSON.stringify(t).length < 4000 &&
        (t as unknown as { description: string }).description.length <= 2048,
      `${t.name} too long`,
    );
  // exits on stdin EOF
  const t0 = Date.now();
  const end = await c.close();
  assert.equal(end.code, 0);
  assert.ok(Date.now() - t0 < 1000);
});

test("SIGTERM and SIGINT end it", async () => {
  const root = makeProject(path.join(base, "signals"));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const c = server(root, cleanEnv());
    await c.init();
    c.child.kill(sig);
    const end = await c.exited;
    assert.ok(end.code === 0 || end.sig === sig, `${sig}: ${JSON.stringify(end)}`);
  }
});

test("the tool-use id and the session land on the record", async () => {
  const root = makeProject(path.join(base, "meta"));
  const c = server(
    root,
    cleanEnv({
      GROVE_RECORD_SESSION: "s-meta",
      GROVE_RECORD_PID: String(process.pid),
      GROVE_RECORD_AGENT: "meta agent",
    }),
  );
  await c.init();
  const r = await c.call("card_create", { title: "with meta", as: "explore" }, "toolu_01TEST");
  assert.equal(r.isError, false, r.text);
  const text = fs.readFileSync(path.join(root, "cards", "AUTH-1", "card.md"), "utf8");
  assert.match(text, /\nsession: s-meta\n/);
  assert.match(text, /\nagent: "meta agent"\n/);
  assert.match(text, /\nsub: "explore"\n/);
  assert.match(text, /\ntool_use_id: toolu_01TEST\n/);
  await c.close();
});

test("a server whose bundle was replaced runs each call through the new one", async () => {
  // a copy of the package, so the test can change "the bundle on disk" without touching the real one
  const copy = path.join(base, "copy");
  fs.cpSync(path.join(PKG, "src"), path.join(copy, "src"), { recursive: true });
  const entry = path.join(copy, "src", "bin.ts");
  const root = makeProject(path.join(base, "skew"));
  const logDir = path.join(base, "skew-log");
  const env = cleanEnv({
    GROVE_RECORD_SESSION: "s-skew",
    GROVE_RECORD_PID: String(process.pid),
    GROVE_RECORD_AGENT: "skew",
    GROVE_RECORD_LOG: logDir,
  });
  const c = server(root, env, { entry });
  await c.init();
  const first = await c.call("card_create", { title: "before the update" }, "toolu_before");
  assert.match(first.text, /^AUTH-1 created/);
  // "grove installs a new bundle": a new version string in a file the server loaded
  const v = path.join(copy, "src", "version.ts");
  fs.writeFileSync(
    v,
    fs.readFileSync(v, "utf8").replace(/BUNDLE_VERSION = "[^"]*"/, 'BUNDLE_VERSION = "9.9.9"'),
  );
  const t0 = process.hrtime.bigint();
  const second = await c.call("card_create", { title: "after the update" }, "toolu_after");
  const childMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.match(second.text, /^AUTH-2 created/);
  const rec = fs.readFileSync(path.join(root, "cards", "AUTH-2", "card.md"), "utf8");
  assert.match(rec, /\nsession: s-skew\n/, "the child must write as the same session");
  assert.match(rec, /\ntool_use_id: toolu_after\n/, "the child must get the call's tool-use id");
  // the tool list stays the one the session connected with, and a name it does not hold is unknown
  assert.deepEqual(c.notifications, []);
  const list = await c.request("tools/list");
  assert.equal((list.result!.tools as unknown[]).length, 14);
  assert.equal(
    (await c.request("tools/call", { name: "card_archive", arguments: { card: "AUTH-1" } })).error
      ?.code,
    -32602,
  );
  // a failure in the child keeps its code
  const held = await c.call("card_claim", { card: "AUTH-9" });
  assert.equal(
    (held.raw.result as { _meta: Record<string, string> })._meta["grove/code"],
    "not_found",
  );
  await c.close();
  const log = fs
    .readdirSync(logDir)
    .flatMap((f) => fs.readFileSync(path.join(logDir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as { ev: string; via?: string; ms?: number });
  const vias = log.filter((l) => l.ev === "call").map((l) => l.via);
  assert.deepEqual(vias, ["inproc", "child", "child"]);
  console.log(
    `in-process call ${log.find((l) => l.via === "inproc")!.ms!.toFixed(1)}ms, through the new bundle ${childMs.toFixed(0)}ms`,
  );
});

test("the CLI help and doctor run", () => {
  const root = makeProject(path.join(base, "cli"));
  const help = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: cleanEnv() });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /record call <tool> '<json>'/);
  const doc = spawnSync(process.execPath, [BIN, "doctor", "--root", root], {
    encoding: "utf8",
    env: cleanEnv({ GROVE_RECORD_SESSION: "s-doc", GROVE_RECORD_PID: String(process.pid) }),
  });
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.match(doc.stdout, /^ok {3}filesystem: hard links work here$/m);
  const none = spawnSync(
    process.execPath,
    [BIN, "doctor", "--root", path.join(base, "nothing here")],
    { encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(none.status, 1);
  assert.match(
    none.stdout,
    /^FAIL root: .* has no \.claude\/grove-project\.json\. open Grove once$/m,
  );
});
