// the "is the holder still running" rules, one case at a time, with real processes: every call is
// `record call <tool> '<json>'` as its own process, every agent is a sleep(1) whose pid stands in
// for a claude process, and the sessions registry is a folder this test writes.
//
// a port of experiments/atomic-ids/liveness-test.sh. its 32 cases are here in its order, with the
// same expected exit codes, except the two `release --stale` cases. decision 8 has no agent-side
// stale release: a dead holder's card is freed by takeover (an agent the person told to) or by
// the person's own release from grove. so:
//   sh "b release --stale, a alive -> 7"    is   "b cancels a's card, a alive -> 5" (a non-holder cannot end a live holder's card)
//   sh "b release --stale, ghost gone -> 0" is   "the person releases it (grove's reassign) -> 0"
// the cases after the 32 are new for the typescript package.
//
//   pnpm vitest run packages/record/test/liveness.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import {
  Agents,
  agentEnv,
  call,
  cleanEnv,
  makeProject,
  tmpDir,
  type Who,
  writeRegistry,
} from "./lib.ts";

const base = tmpDir("liveness");
const ROOT = makeProject(path.join(base, "the project"));
const REG = path.join(base, "registry");
fs.mkdirSync(REG);
const agents = new Agents();
afterAll(() => agents.stopAll());
const HOST = os.hostname().split(".")[0];

const A: Who = { session: "sess-a", pid: agents.start() };
const B: Who = { session: "sess-b", pid: agents.start() };

function as(
  who: Who | "person",
  tool: string,
  args: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  return call(ROOT, agentEnv(REG, who, extra), tool, args);
}
function expect(
  code: number,
  who: Who | "person",
  tool: string,
  args: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) {
  const r = as(who, tool, args, extra);
  assert.equal(r.code, code, `exit ${r.code}, wanted ${code}: ${r.out}${r.err}`);
  return r;
}
function card(title: string): string {
  const r = call(ROOT, cleanEnv({ GROVE_RECORD_ACTOR: "person" }), "card_create", { title });
  assert.equal(r.code, 0, r.err);
  return r.out.split(" ")[0]!;
}
const claims = (c: string) =>
  fs.readdirSync(path.join(ROOT, "cards", c, "claims")).filter((f) => /^\d{4}\.md$/.test(f));
const lastClaimText = (c: string) =>
  fs.readFileSync(path.join(ROOT, "cards", c, "claims", claims(c).sort().at(-1)!), "utf8");
const done = { summary: "finished" };

// ---------- plain ----------
let c = "";
test("01 a claims a free card", () => {
  c = card("plain");
  expect(0, A, "card_claim", { card: c });
});
test("02 a claims it again: already yours", () => {
  const r = expect(0, A, "card_claim", { card: c });
  assert.match(r.out, /already yours/);
  assert.equal(claims(c).length, 1);
});
test("03 b claims a's card, a alive, registry empty", () =>
  void expect(3, B, "card_claim", { card: c }));
test("04 b takeover, a alive", () => void expect(7, B, "card_takeover", { card: c }));
test("05 b release, not the holder", () => void expect(5, B, "card_release", { card: c }));
test("06 b cancels a's card, a alive (sh: b release --stale, a alive -> 7)", () =>
  void expect(5, B, "card_cancel", { card: c, reason: "no" }));
test("07 b takeover with force, a alive", () =>
  void expect(0, B, "card_takeover", { card: c, force: true }));
test("08 a claims back, b now holds it", () => void expect(3, A, "card_claim", { card: c }));
test("09 a done, not the holder", () => void expect(5, A, "card_done", { card: c, ...done }));
test("10 b done", () => void expect(0, B, "card_done", { card: c, ...done }));
test("11 a claims a done card", () => void expect(6, A, "card_claim", { card: c }));
test("12 a takeover of a done card", () => void expect(6, A, "card_takeover", { card: c }));

// ---------- case ----------
test("13 claim with a lower case id", () => {
  c = card("lower case id");
  expect(0, A, "card_claim", { card: c.toLowerCase() });
  assert.equal(
    fs.readdirSync(path.join(ROOT, "cards")).filter((d) => d.toUpperCase() === c).length,
    1,
    "a second directory was made for the lower case id",
  );
  assert.ok(fs.existsSync(path.join(ROOT, "cards", c, "claims")));
});

// ---------- dead pid ----------
let G: Who;
test("14 ghost claims", () => {
  c = card("dead pid");
  G = { session: "sess-ghost", pid: agents.start() };
  expect(0, G, "card_claim", { card: c });
});
test("15 b claims, ghost's process is gone", async () => {
  await agents.kill(G.pid);
  const r = expect(4, B, "card_claim", { card: c });
  assert.match(r.err, /not running/);
});
test("16 the person releases it, grove's reassign (sh: b release --stale, ghost gone -> 0)", () => {
  expect(0, "person", "card_release", { card: c, note: "reassigned" });
  assert.match(lastClaimText(c), /event: release\n[\s\S]*session: person/);
});
test("17 a claims the released card", () => void expect(0, A, "card_claim", { card: c }));

// ---------- resumed under another pid, known to the registry ----------
let G2: Who;
test("18 ghost2 claims", () => {
  c = card("resumed under another pid, known to the registry");
  G = { session: "sess-ghost2", pid: agents.start() };
  expect(0, G, "card_claim", { card: c });
});
test("19 b claims: old pid gone, registry shows the session in another live process", async () => {
  await agents.kill(G.pid);
  G2 = { session: "sess-ghost2", pid: agents.start() };
  writeRegistry(REG, G2.pid, "sess-ghost2");
  expect(3, B, "card_claim", { card: c });
});
test("20 b takeover: same", () => void expect(7, B, "card_takeover", { card: c }));
test("21 the resumed session runs my_cards and its claim is refreshed", () => {
  const r = expect(0, G2, "my_cards");
  assert.match(r.out, /claim refreshed/);
  assert.match(lastClaimText(c), new RegExp(`pid: ${G2.pid}\\n`));
});
test("22 b claims: registry entry gone, refreshed pid is alive", () => {
  fs.rmSync(path.join(REG, `${G2.pid}.json`));
  expect(3, B, "card_claim", { card: c });
});

// ---------- process moved on to another session ----------
test("23 s1 claims in process G", () => {
  c = card("process moved on to another session");
  G = { session: "sess-s1", pid: agents.start() };
  expect(0, G, "card_claim", { card: c });
});
test("24 b claims: process G alive but the registry says it now runs another session", () => {
  writeRegistry(REG, G.pid, "sess-s2");
  expect(4, B, "card_claim", { card: c });
});
test("25 b takeover", () => {
  expect(0, B, "card_takeover", { card: c });
  fs.rmSync(path.join(REG, `${G.pid}.json`));
});

// ---------- written by hand, in record.sh's own format (no v:) ----------
function handClaim(title: string, pid: number, host: string): string {
  const id = card(title);
  fs.mkdirSync(path.join(ROOT, "cards", id, "claims"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "cards", id, "claims", "0001.md"),
    `---\ncard: ${id}\nseq: 1\nevent: claim\nagent: "old"\nsession: sess-old\npid: ${pid}\npid_start: "Mon Jan  1 00:00:00 2024"\nhost: ${host}\nat: 2026-01-01T00:00:00Z\nprev: 0\n---\n`,
  );
  return id;
}
test("26 b claims: recorded pid is alive but started at another time (pid reuse)", () => {
  c = handClaim("pid reused", A.pid, HOST!);
  expect(4, B, "card_claim", { card: c });
});
test("27 b claims: holder is on another host, cannot be checked", () => {
  c = handClaim("other machine", 1, "some-other-mac");
  expect(3, B, "card_claim", { card: c });
});
test("28 b takeover: cannot be checked, refused", () =>
  void expect(7, B, "card_takeover", { card: c }));
test("29 b takeover with force", () =>
  void expect(0, B, "card_takeover", { card: c, force: true }));

// ---------- time zone and locale ----------
test("30 a claims with TZ=Asia/Tokyo LC_ALL=de_DE.UTF-8", () => {
  c = card("time zone and locale");
  expect(0, A, "card_claim", { card: c }, { TZ: "Asia/Tokyo", LC_ALL: "de_DE.UTF-8" });
});
test("31 b checks with TZ=America/Chicago: a is alive, not 'pid reused'", () =>
  void expect(3, B, "card_claim", { card: c }, { TZ: "America/Chicago", LC_ALL: "fr_FR.UTF-8" }));
test("32 a from another time zone: already yours, no new record", () => {
  expect(0, A, "card_claim", { card: c }, { TZ: "Europe/London" });
  assert.equal(claims(c).length, 1, "a time zone change wrote a second claim record");
});

// ---------- new for the typescript package ----------
test("x1 the agent a card was forced from learns it in my_cards", () => {
  c = card("forced away");
  expect(0, A, "card_claim", { card: c });
  expect(0, B, "card_takeover", { card: c, force: true });
  const r = expect(0, A, "my_cards");
  assert.match(r.out, new RegExp(`${c} is no longer yours`));
});
test("x2 a canceled card cannot be claimed, taken or finished", () => {
  c = card("to cancel");
  expect(0, A, "card_cancel", { card: c, reason: "duplicate of AUTH-1" });
  expect(6, B, "card_claim", { card: c });
  expect(6, B, "card_takeover", { card: c, force: true });
  expect(6, A, "card_done", { card: c, ...done });
  expect(0, A, "card_cancel", { card: c, reason: "again" });
  assert.equal(claims(c).length, 1);
});
test("x3 the person cancels a card a live agent holds, the agent is told", () => {
  c = card("person cancels");
  expect(0, A, "card_claim", { card: c });
  expect(0, "person", "card_cancel", { card: c, reason: "the plan changed, see D-3" });
  assert.match(
    expect(0, A, "my_cards").out,
    new RegExp(
      `${c} is no longer yours: the person canceled it at .*It is canceled: the plan changed, see D-3\\. Stop working on it\\.`,
    ),
  );
});
test("x4 /clear: same process, new session id. the old claim is not the new session's", () => {
  c = card("cleared");
  const P = agents.start();
  expect(0, { session: "sess-before", pid: P }, "card_claim", { card: c });
  writeRegistry(REG, P, "sess-after");
  const r = expect(0, { session: "sess-after", pid: P }, "my_cards");
  assert.match(r.out, new RegExp(`${c} is held by the session this window had before /clear`));
  expect(4, B, "card_claim", { card: c });
  expect(0, { session: "sess-after", pid: P }, "card_takeover", { card: c });
  fs.rmSync(path.join(REG, `${P}.json`));
});
test("x5 a claim with no session id is refused, a card is still created", () => {
  const r = call(ROOT, cleanEnv({ GROVE_RECORD_REGISTRY: REG }), "card_claim", { card: c });
  assert.equal(r.code, 8);
  assert.match(r.err, /cannot tell which Claude session is calling/);
  assert.equal(
    call(ROOT, cleanEnv({ GROVE_RECORD_REGISTRY: REG }), "card_create", { title: "anonymous" })
      .code,
    0,
  );
});
test("x6 the person cannot claim or finish a card", () => {
  c = card("person claims");
  expect(1, "person", "card_claim", { card: c });
  expect(1, "person", "card_done", { card: c, ...done });
});
test("x7 a registry file left by a crash, its pid now another process: the holder is dead", async () => {
  c = card("crash-left registry");
  const G3: Who = { session: "sess-crashed", pid: agents.start() };
  expect(0, G3, "card_claim", { card: c });
  await agents.kill(G3.pid);
  const reused = agents.start();
  fs.writeFileSync(
    path.join(REG, `${reused}.json`),
    `${JSON.stringify({ pid: reused, sessionId: "sess-crashed", procStart: "Mon Jan  1 00:00:00 2024", name: "old" })}\n`,
  );
  expect(4, B, "card_claim", { card: c });
  fs.rmSync(path.join(REG, `${reused}.json`));
});
test("x8 reassign: the new agent takes the card with force, the old holder is told. no window for anyone else", () => {
  c = card("reassigned");
  const N: Who = { session: "sess-new-agent", pid: agents.start() };
  expect(0, A, "card_claim", { card: c });
  expect(7, N, "card_takeover", { card: c });
  expect(0, N, "card_takeover", { card: c, force: true });
  expect(3, B, "card_claim", { card: c });
  assert.match(
    expect(0, A, "my_cards").out,
    new RegExp(`${c} is no longer yours: sess-new-agent took it over at .*Stop working on it\\.`),
  );
});
test("x9 the old holder is told even when its hold was ended by a release and someone else claimed after", () => {
  c = card("released then claimed");
  expect(0, A, "card_claim", { card: c });
  expect(0, "person", "card_release", { card: c });
  expect(0, B, "card_claim", { card: c });
  assert.match(
    expect(0, A, "my_cards").out,
    new RegExp(
      `${c} is no longer yours: the person released it at .* sess-b holds it now\\. Stop working on it\\.`,
    ),
  );
});
test("x10 without the test flag the identity overrides do nothing, and project_init is not a tool", () => {
  const noFlag = (extra: Record<string, string>) => {
    const e = cleanEnv({ GROVE_RECORD_REGISTRY: REG, ...extra });
    delete e.GROVE_RECORD_TEST;
    return e;
  };
  c = card("overrides");
  expect(0, A, "card_claim", { card: c });
  const asPersonByEnv = call(ROOT, noFlag({ GROVE_RECORD_ACTOR: "person" }), "card_release", {
    card: c,
  });
  assert.equal(asPersonByEnv.code, 8, asPersonByEnv.err);
  const asA = call(
    ROOT,
    noFlag({ GROVE_RECORD_SESSION: "sess-a", GROVE_RECORD_PID: String(B.pid) }),
    "card_release",
    { card: c },
  );
  assert.equal(asA.code, 8, asA.err);
  assert.equal(claims(c).length, 1);
  const init = call(ROOT, noFlag({}), "project_init", {
    prefix: "AUTH",
    goal: "changed by an agent",
  });
  assert.equal(init.code, 1);
  assert.match(init.err, /There is no tool "project_init"/);
});
