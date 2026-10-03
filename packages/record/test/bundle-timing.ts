// the shipped shape: the esbuild bundle run by the launcher that renderLauncher() writes, on the
// installed Grove binary with ELECTRON_RUN_AS_NODE=1. the bundle is built the way the app builds it,
// with the test-only identity overrides compiled out, so identity here comes from CLAUDE_PID and
// CLAUDE_CODE_SESSION_ID, the way it does in a real Bash tool.
//
//   build first:
//   esbuild src/bin.ts --bundle --platform=node --format=cjs --target=node22 \
//     --define:process.env.GROVE_RECORD_TEST='"0"' --outfile=out/bin/record.cjs
//   node test/bundle-timing.ts
//
// checks, exit 1 when one fails: the hook's time and size, the start-up self-check, one write,
// that the overrides are compiled out, a bundle replaced under a running server, a server of the
// previous release (test/fixtures/record-0.1.0.cjs) running its calls through the current bundle,
// and every branch of the launcher (no Grove, an old node, no node, no bundle).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { renderLauncher } from "../src/render.ts";
import { Client, cleanEnv, fixture, PKG, tmpDir } from "./lib.ts";

const GROVE = "/Applications/Grove.app/Contents/MacOS/Grove";
const BUNDLE = path.join(PKG, "out", "bin", "record.cjs");
const LAUNCHER = path.join(PKG, "out", "bin", "record");
if (!fs.existsSync(BUNDLE)) throw new Error(`build the bundle first: ${BUNDLE}`);
fs.writeFileSync(LAUNCHER, renderLauncher({ execPath: GROVE, bundle: BUNDLE }), { mode: 0o755 });
const base = tmpDir("bundle");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const lines: string[] = [];
let failed = 0;
const check = (ok: boolean, what: string) => {
  lines.push(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
// the session as a server sees it: CLAUDE_CODE_SESSION_ID in the env, and its parent (this test
// process, alive, not in the registry) as the claude process
const PID = process.pid;
const env = (extra: Record<string, string> = {}) => {
  const e = cleanEnv({ CLAUDE_CODE_SESSION_ID: "s-bundle", ...extra });
  delete e.GROVE_RECORD_TEST;
  return e;
};

for (const n of [9, 50, 200]) {
  const root = path.join(base, `p${n}`);
  fixture(root, n, { conclusions: n * 5 });
  const hookCmd = `'${LAUNCHER}' state --hook --root '${root}' # grove-record`;
  spawnSync("/bin/sh", ["-c", hookCmd], { input: "{}", env: env() });
  const runs: number[] = [];
  let out = "";
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    out = spawnSync("/bin/sh", ["-c", hookCmd], {
      input: '{"session_id":"timing"}',
      env: env(),
      encoding: "utf8",
    }).stdout;
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  check(
    out.startsWith("# record AUTH rev"),
    `hook, /bin/sh -c '<launcher> state --hook --root <root> # grove-record', ${n} cards / ${n * 5} conclusions: median ${median(runs).toFixed(0)}ms, min ${Math.min(...runs).toFixed(0)}, max ${Math.max(...runs).toFixed(0)}, ${out.length} characters`,
  );
}

const root = path.join(base, "p9");
// grove's start-up self-check: spawn, initialize, tools/list, record_state, close
const checks: number[] = [];
let tools = 0;
let stateOk = false;
for (let i = 0; i < 15; i++) {
  const t0 = process.hrtime.bigint();
  const c = new Client(LAUNCHER, ["mcp"], { env: { ...env(), GROVE_RECORD_ROOT: root } });
  await c.init();
  tools = ((await c.request("tools/list")).result!.tools as unknown[]).length;
  stateOk = !(await c.call("record_state")).isError;
  await c.close();
  checks.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
check(
  tools === 14 && stateOk,
  `self-check, <launcher> mcp: initialize + tools/list + record_state + exit on EOF: median ${median(checks).toFixed(0)}ms, min ${Math.min(...checks).toFixed(0)}, max ${Math.max(...checks).toFixed(0)}, ${tools} tools`,
);

// one write through the bundle, as the session the env names
const c = new Client(LAUNCHER, ["mcp"], { env: { ...env(), GROVE_RECORD_ROOT: root } });
await c.init();
const r = await c.call("card_create", { title: "made by the bundle" }, "toolu_bundle");
await c.close();
const made = r.text.split(" ")[0]!;
check(
  /\nsession: s-bundle\n/.test(fs.readFileSync(path.join(root, "cards", made, "card.md"), "utf8")),
  `card_create through the bundle: ${made}, written as s-bundle`,
);

// the test-only overrides are compiled out of the bundle, flag or no flag
const forged = spawnSync(LAUNCHER, ["call", "card_create", '{"title":"forged"}', "--root", root], {
  env: {
    ...env(),
    GROVE_RECORD_TEST: "1",
    GROVE_RECORD_ACTOR: "person",
    GROVE_RECORD_SESSION: "sess-forged",
  },
  encoding: "utf8",
});
const forgedId = forged.stdout.split(" ")[0]!;
const forgedText = fs.readFileSync(path.join(root, "cards", forgedId, "card.md"), "utf8");
check(
  /\nby: agent\nsession: s-bundle\n/.test(forgedText),
  `GROVE_RECORD_TEST=1 GROVE_RECORD_ACTOR=person GROVE_RECORD_SESSION=sess-forged through the bundle wrote ${forgedId} as by agent, session s-bundle`,
);

const doctor = spawnSync(LAUNCHER, ["doctor", "--root", root], { env: env(), encoding: "utf8" });
check(doctor.status === 0, `record doctor through the launcher, exit ${doctor.status}`);
lines.push(
  ...doctor.stdout
    .trimEnd()
    .split("\n")
    .map((l) => `       ${l}`),
);

// a server whose bundle grove replaced: its calls go through the launcher ($GROVE_RECORD_BIN) to the new bundle
{
  const original = fs.readFileSync(BUNDLE);
  const logDir = path.join(base, "log");
  const s = new Client(LAUNCHER, ["mcp"], {
    env: { ...env(), GROVE_RECORD_ROOT: root, GROVE_RECORD_LOG: logDir },
  });
  await s.init();
  const before = await s.call("card_create", { title: "before the update" }, "toolu_before");
  fs.writeFileSync(
    `${BUNDLE}.new`,
    Buffer.concat([original, Buffer.from("\n// a newer bundle\n")]),
  );
  fs.renameSync(`${BUNDLE}.new`, BUNDLE);
  try {
    const t0 = process.hrtime.bigint();
    const after = await s.call("card_create", { title: "after the update" }, "toolu_after");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await s.close();
    const id = after.text.split(" ")[0]!;
    const rec = fs.readFileSync(path.join(root, "cards", id, "card.md"), "utf8");
    const vias = fs
      .readdirSync(logDir)
      .flatMap((f) => fs.readFileSync(path.join(logDir, f), "utf8").split("\n").filter(Boolean))
      .map((l) => JSON.parse(l))
      .filter((l) => l.ev === "call")
      .map((l) => l.via);
    const ok =
      /\nsession: s-bundle\n/.test(rec) &&
      /\ntool_use_id: toolu_after\n/.test(rec) &&
      vias.join(",") === "inproc,child";
    check(
      ok,
      `bundle replaced under a running server: ${before.text.split(" ")[0]} in process, ${id} through the launcher in ${ms.toFixed(0)}ms, calls ${vias.join(" then ")}, session and tool-use id kept`,
    );
  } finally {
    fs.writeFileSync(BUNDLE, original);
  }
}

// a server of the previous release (0.1.0, frozen before the review) whose bundle is replaced by this one
{
  const dir = path.join(base, "upgrade");
  fs.mkdirSync(dir);
  const old = path.join(dir, "record.cjs");
  fs.copyFileSync(path.join(PKG, "test", "fixtures", "record-0.1.0.cjs"), old);
  const launcher = path.join(dir, "record");
  fs.writeFileSync(launcher, renderLauncher({ execPath: GROVE, bundle: old }), { mode: 0o755 });
  const proot = path.join(base, "upgrade project");
  fixture(proot, 1, { conclusions: 0 });
  const s = new Client(launcher, ["mcp"], { env: { ...env(), GROVE_RECORD_ROOT: proot } });
  const init = await s.init();
  const oldVersion = (init.result as { serverInfo: { version: string } }).serverInfo.version;
  await s.call("conclusion_record", { kind: "decision", what: "sessions live 12h", by: "person" });
  const d2 = await s.call("conclusion_record", {
    kind: "decision",
    what: "sessions live 8h",
    by: "person",
    replaces: "D-1",
  });
  fs.copyFileSync(BUNDLE, `${old}.new`);
  fs.renameSync(`${old}.new`, old);
  const d3 = await s.call(
    "conclusion_record",
    { kind: "decision", what: "sessions live 24h", by: "agent", replaces: "D-1" },
    "toolu_upgrade",
  );
  const card = await s.call("card_claim", { card: "AUTH-1" }, "toolu_claim");
  await s.close();
  const claim = fs.readFileSync(path.join(proot, "cards", "AUTH-1", "claims", "0001.md"), "utf8");
  const ok =
    oldVersion === "0.1.0" &&
    /^D-2 recorded/.test(d2.text) &&
    d3.isError &&
    /D-1 was already replaced by D-2/.test(d3.text) &&
    (d3.raw.result as { _meta: Record<string, string> })._meta["grove/code"] === "invalid" &&
    !card.isError &&
    /\nsession: s-bundle\n/.test(claim) &&
    /\ntool_use_id: toolu_claim\n/.test(claim) &&
    new RegExp(`\\npid: ${PID}\\n`).test(claim);
  check(
    ok,
    `a ${oldVersion} server, its bundle replaced by ${spawnSync(LAUNCHER, ["version"], { env: env(), encoding: "utf8" }).stdout.trim()}: the next calls ran the new code (a second replace of D-1 refused with code invalid), the claim kept session, pid and tool-use id`,
  );
}

// the launcher's other branches: no Grove at G, then an old node, no node, no bundle
{
  const dir = path.join(base, "branches");
  fs.mkdirSync(dir);
  const noGrove = path.join(dir, "record");
  fs.writeFileSync(noGrove, renderLauncher({ execPath: "/nonexistent/Grove", bundle: BUNDLE }), {
    mode: 0o755,
  });
  const noBundle = path.join(dir, "record-nobundle");
  fs.writeFileSync(
    noBundle,
    renderLauncher({ execPath: GROVE, bundle: path.join(dir, "gone.cjs") }),
    { mode: 0o755 },
  );
  const node24 = path.dirname(process.execPath);
  const node20 = path.join(process.env.HOME!, ".asdf/installs/nodejs/20.11.1/bin");
  const run = (bin: string, args: string[], PATH: string) => {
    const x = spawnSync(bin, args, { env: { ...env(), PATH }, encoding: "utf8", input: "{}" });
    return { code: x.status, out: x.stdout.trim(), err: x.stderr.trim() };
  };
  const a = run(noGrove, ["version"], `${node24}:/usr/bin:/bin`);
  check(
    a.code === 0 && a.out === "0.2.0",
    `no Grove, node ${process.versions.node} on PATH: runs on node (${a.out})`,
  );
  if (fs.existsSync(node20)) {
    const b = run(noGrove, ["version"], `${node20}:/usr/bin:/bin`);
    check(
      b.code === 8 &&
        b.err ===
          "record unavailable: Grove is not at /nonexistent/Grove and there is no node 22 or newer on PATH. open Grove once",
      `no Grove, node 20.11.1 on PATH: exit ${b.code}, stderr "${b.err}"`,
    );
    const bh = run(noGrove, ["state", "--hook", "--root", root], `${node20}:/usr/bin:/bin`);
    check(
      bh.code === 0 && bh.out.startsWith("record unavailable: Grove is not at"),
      `same, as the hook: exit ${bh.code}, stdout "${bh.out}"`,
    );
  } else lines.push("skip no node 20 here");
  const c2 = run(noGrove, ["version"], "/usr/bin:/bin");
  check(
    c2.code === 8 && /no node 22 or newer on PATH/.test(c2.err),
    `no Grove, no node: exit ${c2.code}`,
  );
  const d = run(noBundle, ["mcp"], `${node24}:/usr/bin:/bin`);
  check(
    d.code === 8 &&
      d.err ===
        `record unavailable: the record bundle is missing at ${path.join(dir, "gone.cjs")}. open Grove once`,
    `no bundle: exit ${d.code}, stderr "${d.err}"`,
  );
  const dh = run(noBundle, ["state", "--hook"], `${node24}:/usr/bin:/bin`);
  check(
    dh.code === 0 && /^record unavailable: the record bundle is missing/.test(dh.out),
    `no bundle, as the hook: exit ${dh.code}, the line on stdout`,
  );
}

console.log(lines.join("\n"), `\n${failed} failed`);
process.exitCode = failed ? 1 : 0;
