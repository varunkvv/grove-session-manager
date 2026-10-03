// record_state and the SessionStart hook: size, the revision line, speed, failure.
//
//   pnpm vitest run packages/record/test/state.test.ts
// writes the worked example and the timings into its temp folder (KEEP=1 keeps it) for the spec.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { resolveCaller } from "../src/identity.ts";
import { syncProject } from "../src/index.ts";
import { stateText } from "../src/ops.ts";
import {
  asAgent,
  asPerson,
  BIN,
  cleanEnv,
  fixture,
  makeProject,
  tmpDir,
  writeRegistry,
} from "./lib.ts";

const base = tmpDir("state");
const RESULTS = base;
const state = (root: string, session = "sess-1") =>
  stateText({
    root,
    caller: resolveCaller({
      env: cleanEnv({
        GROVE_RECORD_SESSION: session,
        GROVE_RECORD_PID: String(process.pid),
        GROVE_RECORD_AGENT: "agent 1",
        GROVE_RECORD_REGISTRY: "/nonexistent",
      }),
    }),
    env: cleanEnv(),
  });

function hook(
  root: string,
  stdin: string,
  env: NodeJS.ProcessEnv = cleanEnv({ GROVE_RECORD_REGISTRY: "/nonexistent" }),
): { ms: number; out: string; code: number } {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, "state", "--hook", "--root", root], {
    input: stdin,
    env,
    encoding: "utf8",
  });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: r.stdout, code: r.status ?? -1 };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("the worked example: a 9-card project", () => {
  const root = makeProject(
    path.join(base, "auth-sso"),
    "AUTH",
    "Org-wide SSO with okta: login, session, admin settings, rollout behind a flag. Done when an okta org can sign in on staging and prod.",
  );
  const a = (s: string, tool: string, args: Record<string, unknown>, name: string) => {
    const r = asAgent(root, s.replace(/ /g, "-"), tool, args, name);
    assert.ok(r.ok, r.text);
    return r;
  };
  const cards: [string, string][] = [
    ["OIDC callback and token exchange", "oidc callback"],
    ["Session store and refresh", "session store"],
    ["Login page with the SSO button", "login page"],
    ["Okta apps per environment in terraform", "okta infra"],
    ["Admin settings: enforce SSO per org", "admin settings"],
    ["E2E tests for the SSO login", "e2e"],
    ["Rate limit the callback endpoint", "oidc callback"],
    ["Feature flag and rollout plan", "login page"],
    ["Migrate SAML orgs", "oidc callback"],
  ];
  cards.forEach(([t, who], i) => {
    a(
      `s-${who}`,
      "card_create",
      { title: t, body: `brief ${i + 1}`, ...(i === 6 ? { from: "AUTH-1" } : {}) },
      who,
    );
  });
  a("s-oidc callback", "card_claim", { card: "AUTH-1" }, "oidc callback");
  a(
    "s-oidc callback",
    "card_done",
    { card: "AUTH-1", summary: "callback and token exchange in, behind the flag" },
    "oidc callback",
  );
  a("s-session store", "card_claim", { card: "AUTH-2" }, "session store");
  a("s-login page", "card_claim", { card: "AUTH-3" }, "login page");
  a("s-okta infra", "card_claim", { card: "AUTH-4" }, "okta infra");
  a(
    "s-okta infra",
    "question_ask",
    {
      card: "AUTH-4",
      text: "Staging has no okta tenant. Create a dev tenant, or point staging at the prod tenant with its own app? I would create a dev tenant.",
    },
    "okta infra",
  );
  a(
    "s-login page",
    "question_ask",
    {
      card: "AUTH-3",
      text: "Does the login page call GET /session or read the cookie?",
      to: "AUTH-2",
    },
    "login page",
  );
  asPerson(root, "card_cancel", { card: "AUTH-9", reason: "no SAML orgs left, see F-1" });
  a(
    "s-oidc callback",
    "conclusion_record",
    {
      kind: "decision",
      what: "Refresh tokens stay on the server. The browser only gets an opaque session id.",
      why: "keeps tokens out of the page",
      card: "AUTH-1",
      by: "agent",
    },
    "oidc callback",
  );
  a(
    "s-oidc callback",
    "conclusion_record",
    {
      kind: "finding",
      what: "No org uses the SAML strategy any more.",
      why: "queried prod",
      card: "AUTH-9",
      by: "agent",
      changes_plan: true,
    },
    "oidc callback",
  );
  a(
    "s-session store",
    "conclusion_record",
    {
      kind: "decision",
      what: "Sessions live in redis with a 12h idle timeout.",
      card: "AUTH-2",
      by: "person",
    },
    "session store",
  );
  a(
    "s-session store",
    "conclusion_record",
    {
      kind: "decision",
      what: "Sessions live in redis with an 8h idle timeout, to match the okta policy.",
      card: "AUTH-2",
      by: "person",
      replaces: "D-2",
    },
    "session store",
  );
  a(
    "s-login page",
    "conclusion_record",
    {
      kind: "verdict",
      what: "The old login form cannot be reused for the email-first step.",
      card: "AUTH-3",
      by: "agent",
    },
    "login page",
  );
  const text = state(root, "s-login-page");
  fs.writeFileSync(path.join(RESULTS, "state-9-cards.txt"), `${text}\n`);
  assert.match(text.split("\n")[0]!, /^# record AUTH rev \d+ - auth-sso$/);
  // a later session finds the why without a second call
  assert.match(
    text,
    /D-1 decision AUTH-1 \| Refresh tokens stay on the server.*\(why: keeps tokens out of the page\)/,
  );
  assert.ok(text.length < 10_000);
});

test("under 10,000 characters at any size", () => {
  const sizes: string[] = [];
  for (const [n, concl, long] of [
    [50, 50, false],
    [200, 1000, false],
    [200, 1000, true],
  ] as const) {
    const root = path.join(base, `size ${n} ${concl} ${long}`);
    fixture(root, n, { conclusions: concl, long });
    const t = state(root);
    sizes.push(
      `${n} cards, ${concl} conclusions, ${long ? "long" : "short"} titles: ${t.length} characters`,
    );
    assert.ok(t.length < 10_000, sizes.at(-1));
  }
  fs.writeFileSync(path.join(RESULTS, "state-sizes.txt"), `${sizes.join("\n")}\n`);
});

test("the revision line: same state, same text. a write moves it. A, B, A prints three texts", () => {
  const root = makeProject(path.join(base, "revision"));
  asAgent(root, "s1", "card_create", { title: "one" });
  const a1 = state(root);
  assert.equal(state(root), a1, "two reads with no write differ");
  asAgent(root, "s2", "card_claim", { card: "AUTH-1" });
  const b = state(root);
  asAgent(root, "s2", "card_release", { card: "AUTH-1" });
  const a2 = state(root);
  assert.notEqual(a1.split("\n")[0], b.split("\n")[0]);
  assert.notEqual(b.split("\n")[0], a2.split("\n")[0]);
  assert.notEqual(a1, a2, "A, B, A must not print A twice: resume drops a text it has seen");
  assert.equal(
    a1.split("\n").slice(1).join("\n"),
    a2.split("\n").slice(1).join("\n"),
    "only the revision tells A from A",
  );
  // a changed goal is a new revision too
  syncProject(root, { prefix: "AUTH", name: "revision", goal: "a new goal" });
  assert.notEqual(state(root).split("\n")[0], a2.split("\n")[0]);
  syncProject(root, { prefix: "AUTH", name: "revision", goal: "a new goal" });
  assert.equal(readRev(root), readRev(root));
});
const readRev = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, ".claude", "grove-project.json"), "utf8")).rev;

test("the hook: session id from stdin, one line on failure, exit 0", () => {
  const root = makeProject(path.join(base, "hook"));
  const r = hook(
    root,
    JSON.stringify({ session_id: "1f0c-hook", hook_event_name: "SessionStart", source: "startup" }),
  );
  assert.equal(r.code, 0);
  assert.match(r.out, /^you: session 1f0c-hook "1f0c-hoo"\. you hold no card$/m);
  const none = hook(path.join(base, "no project here"), "{}");
  assert.equal(none.code, 0);
  assert.equal(
    none.out,
    `record unavailable: ${path.join(base, "no project here", ".claude", "grove-project.json")} is missing, so ${path.join(base, "no project here")} is not set up as a Grove project. open Grove once\n`,
  );
  // after /clear the registry entry for the claude pid may still name the old session. stdin wins
  const reg = path.join(base, "hook registry");
  writeRegistry(reg, process.pid, "sess-old", "alpha");
  const cleared = hook(
    root,
    JSON.stringify({ session_id: "sess-new", source: "clear" }),
    cleanEnv({ GROVE_RECORD_REGISTRY: reg, CLAUDE_PID: String(process.pid) }),
  );
  assert.match(cleared.out, /^you: session sess-new "sess-new"\. you hold no card$/m);
  // by hand, stdin from a terminal or /dev/null: env is used
  const byHand = spawnSync(process.execPath, [BIN, "state", "--hook", "--root", root], {
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({ CLAUDE_CODE_SESSION_ID: "from-env", GROVE_RECORD_REGISTRY: "/nonexistent" }),
    encoding: "utf8",
  });
  assert.match(byHand.stdout, /^you: session from-env/m);
});

test("the hook is fast: 50 and 200 cards, a whole process each time", () => {
  const lines: string[] = [];
  for (const n of [9, 50, 200]) {
    const root = path.join(base, `speed ${n}`);
    fixture(root, n, { conclusions: n * 5 });
    hook(root, "{}");
    const runs = Array.from({ length: 15 }, () => hook(root, '{"session_id":"x"}').ms);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) state(root);
    const inproc = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    lines.push(
      `${n} cards, ${n * 5} conclusions: node src/bin.ts state --hook median ${median(runs).toFixed(0)}ms (min ${Math.min(...runs).toFixed(0)}, max ${Math.max(...runs).toFixed(0)}), stateText in process ${inproc.toFixed(1)}ms`,
    );
    if (n === 50) assert.ok(median(runs) < 150, lines.at(-1));
  }
  const empty = Array.from({ length: 15 }, () => {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, ["-e", ""]);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  });
  lines.push(`floor: node -e "" median ${median(empty).toFixed(0)}ms`);
  fs.writeFileSync(path.join(RESULTS, "state-timing.txt"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
});
