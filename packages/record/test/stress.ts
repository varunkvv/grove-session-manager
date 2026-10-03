// stress.ts - the race proof for the record, with real processes. a port of
// experiments/atomic-ids/stress.sh (phases A-E and K) onto the MCP front of this package, plus
// phase G for cards as directories (decision 4, last bullet).
//
//   node test/stress.ts [rounds=20] [n=30]
//   node test/stress.ts 3 30 --broken naive     a control: look-then-copy publish. must FAIL
//   node test/stress.ts 3 30 --broken rename    a control: rename publish. must FAIL
//   KEEP=1 node test/stress.ts 1                keep the last round on disk
//
// every contender is its own MCP server process (`record mcp`), one per agent, initialized first.
// then every request of a phase is written to every server at once. an "agent" is a sleep(1)
// process: its pid stands in for the claude process, so killing it makes a dead holder. the
// sessions registry is an empty folder, so only pids decide liveness.
//
//   A  ids      n card_create, n conclusion_record (a third of each kind), n comment_add on one
//               card and n card_claim on that card, all at once
//   B  release  the n-1 non-holders card_release: all refused, log unchanged. then the holder
//               releases while the n-1 others claim: at most one claim wins
//   C  dead     the holder's agent is killed. n-1 claims: all holder_gone, log unchanged. n-1
//               takeovers: exactly one wins. a second wave of takeovers changes nothing
//   D  mixed    dead holder. a third take over, a third claim, three "person" servers release
//               (grove's reassign). the log replays as legal, one record per write that said so
//   E  resume   the holder's session comes back in a new process and claims while the others
//               take over. exactly one of them wins, exactly one record is added
//   K  kill     phase A again on a fresh project, with SIGKILL to half the servers at moments
//               spread over the time phase A took. then a late writer must get highest + 1
//   G  dirs     n card_create, a third of them from servers that die between making the card's
//               directory and linking card.md into it. ids stay whole, the empty directory is
//               walked into by the next writer
import fs from "node:fs";
import path from "node:path";
import { reindex } from "../src/ops.ts";
import { sweepTemps } from "../src/publish.ts";
import { readConclusions, readIndex } from "../src/read.ts";
import { runTool as person } from "../src/tools.ts";
import { Agents, type Client, cleanEnv, makeProject, server, tmpDir } from "./lib.ts";

const argv = process.argv.slice(2);
const brokenAt = argv.indexOf("--broken");
const broken = brokenAt >= 0 ? argv[brokenAt + 1] : undefined;
if (brokenAt >= 0) argv.splice(brokenAt, 2);
const ROUNDS = Number(argv[0] ?? 20);
const N = Number(argv[1] ?? 30);
const KINDS = ["decision", "finding", "verdict"] as const;
const LETTER = { decision: "D", finding: "F", verdict: "V" } as const;

const base = tmpDir("stress");
const registry = path.join(base, "registry");
fs.mkdirSync(registry);
const agents = new Agents();
process.on("exit", () => agents.stopAll());

let fails = 0;
const totals = {
  ids: 0,
  oneWinnerRaces: 0,
  killed: 0,
  unacked: 0,
  tempsLeft: 0,
  emptyDirsWalkedInto: 0,
  dirWritersKilled: 0,
};
let round = 0;
const fail = (msg: string) => {
  fails++;
  console.log(`    FAIL r${round} ${msg}`);
};

interface Res {
  ok: boolean;
  text: string;
  code?: string;
  answered: boolean;
}

/** one tools/call, with a deadline: a killed server never answers. */
function ask(c: Client, tool: string, args: Record<string, unknown>, ms = 15_000): Promise<Res> {
  const p = c.request("tools/call", { name: tool, arguments: args }).then((m) => {
    const r = m.result as
      | { content?: { text: string }[]; isError?: boolean; _meta?: Record<string, string> }
      | undefined;
    if (!r) return { ok: false, text: JSON.stringify(m.error), code: "rpc", answered: true };
    return {
      ok: !r.isError,
      text: r.content?.[0]?.text ?? "",
      code: r._meta?.["grove/code"],
      answered: true,
    };
  });
  const none = (why: string): Res => ({ ok: false, text: why, answered: false });
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    // a server that died answers nothing. what it wrote, if anything, is on disk
    c.exited.then(() => new Promise<Res>((res) => setTimeout(() => res(none("server died")), 50))),
    new Promise<Res>((res) => (timer = setTimeout(() => res(none("no answer")), ms))),
  ]).finally(() => clearTimeout(timer));
}

interface Agent {
  i: number;
  session: string;
  pid: number;
  c: Client;
}

async function startServers(
  root: string,
  who: { session: string; pid: number }[],
  opts: { broken?: string; person?: boolean } = {},
): Promise<Client[]> {
  const cs = who.map((w) =>
    server(
      root,
      cleanEnv(
        opts.person
          ? { GROVE_RECORD_REGISTRY: registry, GROVE_RECORD_ACTOR: "person" }
          : {
              GROVE_RECORD_REGISTRY: registry,
              GROVE_RECORD_SESSION: w.session,
              GROVE_RECORD_PID: String(w.pid),
              GROVE_RECORD_AGENT: `agent ${w.session.slice(5)}`,
            },
      ),
      { broken: opts.broken },
    ),
  );
  await Promise.all(cs.map((c) => c.init()));
  return cs;
}

async function closeAll(cs: Client[]): Promise<void> {
  await Promise.all(
    cs.map((c) =>
      c.child.exitCode !== null || c.child.signalCode !== null ? c.exited : c.close(),
    ),
  );
}

// ---------- reading what is on disk ----------

function ls(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function whole(file: string): boolean {
  const t = fs.readFileSync(file, "utf8");
  return /^---\nv: 1\n[\s\S]*?\n---\n/.test(t) && t.endsWith("\n");
}

function fm(file: string): Record<string, string> {
  const t = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  const out: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^([a-z_]+): (.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.startsWith('"') ? JSON.parse(kv[2]!) : kv[2]!;
  }
  return out;
}

function bodyOf(file: string): string {
  const t = fs.readFileSync(file, "utf8");
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(t);
  return (m?.[1] ?? "").replace(/\n$/, "");
}

/** numbers 1..n with no hole. returns the problem, or "". */
function contiguous(nums: number[], what: string): string {
  const s = [...nums].sort((a, b) => a - b);
  for (let k = 0; k < s.length; k++)
    if (s[k] !== k + 1) return `${what}: position ${k + 1} holds ${s[k]} (${s.join(",")})`;
  return "";
}

function temps(root: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const name of ls(d)) {
      const f = path.join(d, name);
      if (name.startsWith(".tmp.")) n++;
      else if (fs.statSync(f).isDirectory()) walk(f);
    }
  };
  walk(root);
  return n;
}

/**
 * replay a card's claim log and check every step is legal. port of stress.sh replay().
 * returns ["free" | "done" | "canceled" | "held <session>", problems].
 */
function replay(root: string, card: string): [string, string[]] {
  const dir = path.join(root, "cards", card, "claims");
  const files = ls(dir)
    .filter((f) => /^\d{4}\.md$/.test(f))
    .sort();
  const problems: string[] = [];
  let state = "free";
  let holder = "";
  let prevSession = "";
  files.forEach((f, k) => {
    const n = k + 1;
    const file = path.join(dir, f);
    if (f !== `${String(n).padStart(4, "0")}.md`) problems.push(`hole: record ${n} is ${f}`);
    if (!whole(file)) {
      problems.push(`${f} is not whole`);
      return;
    }
    const r = fm(file);
    if (Number(r.seq) !== n) problems.push(`${f}: seq ${r.seq}`);
    if (Number(r.prev) !== n - 1) problems.push(`${f}: prev ${r.prev}, wanted ${n - 1}`);
    if (n > 1 && r.prev_session !== prevSession)
      problems.push(
        `${f}: decided against ${r.prev_session}, but record ${n - 1} was ${prevSession}`,
      );
    const by = r.session ?? "";
    const person = by === "person";
    const ev = r.event;
    if (state === "done" || state === "canceled") problems.push(`${f}: ${ev} after ${state}`);
    else if (ev === "claim") {
      if (state === "held" && holder !== by)
        problems.push(`${f}: claim by ${by} while ${holder} holds it`);
      state = "held";
      holder = by;
    } else if (ev === "takeover") {
      if (state !== "held") problems.push(`${f}: takeover of a card nobody held`);
      if (holder === by) problems.push(`${f}: takeover from itself`);
      state = "held";
      holder = by;
    } else if (ev === "release") {
      if (state !== "held") problems.push(`${f}: release of a card nobody held`);
      else if (holder !== by && !person) problems.push(`${f}: release by ${by}, holder ${holder}`);
      state = "free";
      holder = "";
    } else if (ev === "done") {
      if (state !== "held" || holder !== by)
        problems.push(`${f}: done by ${by}, holder ${holder || "nobody"}`);
      state = "done";
    } else if (ev === "cancel") {
      if (state === "held" && holder !== by && !person)
        problems.push(`${f}: cancel by ${by}, holder ${holder}`);
      state = "canceled";
    } else problems.push(`${f}: unknown event ${ev}`);
    prevSession = by;
  });
  return [state === "held" ? `held ${holder}` : state, problems];
}

const claimCount = (root: string, card: string) =>
  ls(path.join(root, "cards", card, "claims")).filter((f) => /^\d{4}\.md$/.test(f)).length;
const holderOf = (root: string, card: string) => replay(root, card)[0];

/** writes that said they wrote a record. "already yours" and "already done" did not. */
const wrote = (r: Res) => r.ok && !/already (yours|done|canceled)/.test(r.text);

// ---------- phase A, and K which is A with kills ----------

interface Workload {
  tag: string;
  i: number;
  tool: string;
  args: Record<string, unknown>;
  res?: Res;
}

function workload(r: number, n: number, card: string): Workload[][] {
  // server i sends its four requests in a rotated order, so all four kinds contend from the first instant
  const per: Workload[][] = [];
  for (let i = 0; i < n; i++) {
    const title = `r${r} c${i} "q" $(x) \`y\` ü`;
    const kind = KINDS[i % 3]!;
    const four: Workload[] = [
      { tag: "card", i, tool: "card_create", args: { title, body: `body of ${title}\nline two` } },
      {
        tag: "concl",
        i,
        tool: "conclusion_record",
        args: {
          kind,
          what: `what of ${title}`,
          why: `why ${i}`,
          card,
          by: i % 2 ? "agent" : "person",
        },
      },
      { tag: "comment", i, tool: "comment_add", args: { card, text: `comment of ${title}` } },
      { tag: "claim", i, tool: "card_claim", args: { card } },
    ];
    per.push([...four.slice(i % 4), ...four.slice(0, i % 4)]);
  }
  return per;
}

async function runWorkload(cs: Client[], per: Workload[][], killAt?: number[]): Promise<number> {
  const t0 = Date.now();
  const all: Promise<void>[] = [];
  per.forEach((list, i) => {
    for (const w of list)
      all.push(
        ask(cs[i]!, w.tool, w.args).then((res) => {
          w.res = res;
        }),
      );
  });
  const timers = (killAt ?? []).map((ms, i) =>
    ms < 0 ? null : setTimeout(() => cs[i]!.child.kill("SIGKILL"), ms),
  );
  await Promise.all(all);
  for (const t of timers) if (t) clearTimeout(t);
  return Date.now() - t0;
}

/** the checks of phase A. with kills, only what must hold for a killed writer. */
function checkIds(
  root: string,
  card: string,
  per: Workload[][],
  killed: boolean,
): { unacked: number } {
  const flat = per.flat();
  let unacked = 0;
  // cards. card 1 was there before
  const cardsDir = path.join(root, "cards");
  const dirs = ls(cardsDir).filter((d) => /^AUTH-\d+$/.test(d));
  const withCard = dirs.filter((d) => fs.existsSync(path.join(cardsDir, d, "card.md")));
  const p1 = contiguous(
    withCard.map((d) => Number(d.split("-")[1])),
    "cards",
  );
  if (p1) fail(p1);
  const told = new Map<string, Workload>();
  for (const w of flat.filter((x) => x.tag === "card")) {
    if (!w.res?.ok) {
      if (!killed) fail(`card_create c${w.i}: ${w.res?.text}`);
      continue;
    }
    const id = w.res.text.split(" ")[0]!;
    if (told.has(id)) fail(`card id ${id} told to c${told.get(id)!.i} and c${w.i}`);
    told.set(id, w);
    const f = path.join(cardsDir, id, "card.md");
    if (!fs.existsSync(f)) fail(`${id} was acknowledged and is not on disk`);
    else if (fm(f).title !== w.args.title || bodyOf(f) !== w.args.body)
      fail(`${id} holds another contender's card`);
  }
  for (const d of withCard) {
    const f = path.join(cardsDir, d, "card.md");
    if (!whole(f)) fail(`${d}/card.md is not whole`);
    else if (fm(f).id !== d) fail(`${d}/card.md says id ${fm(f).id}`);
    if (d !== card && !told.has(d)) unacked++;
  }
  if (!killed && withCard.length !== N + 1)
    fail(`expected ${N + 1} cards, found ${withCard.length}`);
  if (!killed && withCard.length !== dirs.length)
    fail(`${dirs.length - withCard.length} card directories with no card.md`);

  // conclusions, one counter per kind
  const cdir = path.join(root, "conclusions");
  const files = ls(cdir).filter((f) => /^[DFV]-\d+\.md$/.test(f));
  for (const k of KINDS) {
    const nums = files
      .filter((f) => f.startsWith(`${LETTER[k]}-`))
      .map((f) => Number(/-(\d+)/.exec(f)![1]));
    const p = contiguous(nums, `${k} ids`);
    if (p) fail(p);
  }
  const toldC = new Map<string, Workload>();
  for (const w of flat.filter((x) => x.tag === "concl")) {
    if (!w.res?.ok) {
      if (!killed) fail(`conclusion_record c${w.i}: ${w.res?.text}`);
      continue;
    }
    const id = w.res.text.split(" ")[0]!;
    if (toldC.has(id)) fail(`conclusion ${id} told to c${toldC.get(id)!.i} and c${w.i}`);
    toldC.set(id, w);
    const f = path.join(cdir, `${id}.md`);
    if (!fs.existsSync(f)) fail(`${id} acknowledged, not on disk`);
    else if (fm(f).what !== w.args.what || fm(f).kind !== w.args.kind)
      fail(`${id} holds another contender's conclusion`);
  }
  for (const f of files) {
    if (!whole(path.join(cdir, f))) fail(`${f} is not whole`);
    if (!toldC.has(f.replace(/\.md$/, ""))) unacked++;
  }
  if (!killed && files.length !== N) fail(`expected ${N} conclusions, found ${files.length}`);
  // the index: every line whole, one per conclusion. a killed writer may leave a file with no line
  const lines = (
    fs.existsSync(path.join(cdir, "INDEX.md"))
      ? fs.readFileSync(path.join(cdir, "INDEX.md"), "utf8")
      : ""
  )
    .split("\n")
    .filter(Boolean);
  const ids = new Set<string>();
  for (const l of lines) {
    const parts = l.split(" | ");
    if (parts.length < 7 || !/^[DFV]-\d+$/.test(parts[0]!) || !/^\d{4}-/.test(parts[2]!))
      fail(`torn INDEX line: ${l.slice(0, 120)}`);
    else if (ids.has(parts[0]!)) fail(`INDEX has ${parts[0]} twice`);
    ids.add(parts[0]!);
    if (Buffer.byteLength(l) >= 1000) fail(`INDEX line of ${Buffer.byteLength(l)} bytes`);
  }
  if (!killed && ids.size !== N) fail(`INDEX has ${ids.size} lines, wanted ${N}`);

  // comments on the contested card
  const comDir = path.join(cardsDir, card, "comments");
  const coms = ls(comDir).filter((f) => /^\d{4}\.md$/.test(f));
  const p2 = contiguous(
    coms.map((f) => Number(f.slice(0, 4))),
    "comments",
  );
  if (p2) fail(p2);
  const toldM = new Map<string, Workload>();
  for (const w of flat.filter((x) => x.tag === "comment")) {
    if (!w.res?.ok) {
      if (!killed) fail(`comment_add c${w.i}: ${w.res?.text}`);
      continue;
    }
    const id = w.res.text.split(" ")[0]!;
    if (toldM.has(id)) fail(`comment ${id} told twice`);
    toldM.set(id, w);
    const f = path.join(comDir, `${id.split("#")[1]!.padStart(4, "0")}.md`);
    if (!fs.existsSync(f) || bodyOf(f) !== w.args.text)
      fail(`${id} does not hold c${w.i}'s comment`);
  }
  for (const f of coms) {
    if (!whole(path.join(comDir, f))) fail(`comment ${f} is not whole`);
    if (!toldM.has(`${card}#${Number(f.slice(0, 4))}`)) unacked++;
  }
  if (!killed && coms.length !== N) fail(`expected ${N} comments, found ${coms.length}`);

  // the claim race: exactly one winner, or at most one with kills
  const claims = flat.filter((x) => x.tag === "claim");
  const won = claims.filter((w) => w.res?.ok);
  const held = claims.filter((w) => w.res?.code === "held");
  const records = claimCount(root, card);
  if (!killed) {
    if (won.length !== 1) fail(`claim race: ${won.length} winners`);
    if (held.length !== N - 1)
      fail(
        `claim race: ${held.length} told "held", wanted ${N - 1} (codes: ${claims.map((w) => w.res?.code ?? "ok").join(",")})`,
      );
    if (records !== 1) fail(`claim race: ${records} claim records`);
  } else {
    if (won.length > 1) fail(`claim race under kills: ${won.length} winners`);
    if (records > 1) fail(`claim race under kills: ${records} claim records`);
    if (records === 1 && won.length === 0) unacked++;
  }
  const [state, probs] = replay(root, card);
  for (const p of probs) fail(`log: ${p}`);
  if (won.length === 1 && state !== `held sess-${won[0]!.i}`)
    fail(`log says ${state}, winner was sess-${won[0]!.i}`);
  return { unacked };
}

// ---------- one round ----------

async function oneRound(r: number): Promise<void> {
  round = r;
  const t0 = Date.now();
  const root = makeProject(path.join(base, `round ${String(r).padStart(2, "0")}`));
  const card = "AUTH-1";
  const made = person(
    "card_create",
    { title: "the contested card" },
    { root, env: cleanEnv(), person: true },
  );
  if (!made.ok || !made.text.startsWith(card)) throw new Error(made.text);

  const ag: Agent[] = [];
  const pids = Array.from({ length: N }, () => agents.start());
  const cs = await startServers(
    root,
    pids.map((pid, i) => ({ session: `sess-${i}`, pid })),
    { broken },
  );
  pids.forEach((pid, i) => {
    ag.push({ i, session: `sess-${i}`, pid, c: cs[i]! });
  });
  const persons = await startServers(
    root,
    [0, 1, 2].map(() => ({ session: "person", pid: 0 })),
    { broken, person: true },
  );

  // A
  const perA = workload(r, N, card);
  const msA = await runWorkload(cs, perA);
  checkIds(root, card, perA, false);
  totals.ids += 3 * N;
  totals.oneWinnerRaces++;
  const winner = perA.flat().find((w) => w.tag === "claim" && w.res?.ok);
  let H = winner ? ag[winner.i]! : ag[0]!;

  // B
  const before = claimCount(root, card);
  const others = ag.filter((a) => a !== H);
  const relB = await Promise.all(others.map((a) => ask(a.c, "card_release", { card })));
  const notHolder = relB.filter((x) => x.code === "not_holder").length;
  if (notHolder !== others.length)
    fail(
      `B: ${notHolder} of ${others.length} non-holders refused release (${relB.map((x) => x.code ?? "ok").join(",")})`,
    );
  if (claimCount(root, card) !== before) fail("B: a refused release changed the log");
  const [relH, ...claimsB] = await Promise.all([
    ask(H.c, "card_release", { card, note: "stopping" }),
    ...others.map((a) => ask(a.c, "card_claim", { card })),
  ]);
  if (!relH!.ok) fail(`B: holder release failed: ${relH!.text}`);
  const wonB = claimsB.filter((x) => x.ok).length;
  if (wonB > 1) fail(`B: ${wonB} claims won after the release`);
  if (claimCount(root, card) !== before + 1 + wonB)
    fail(`B: ${claimCount(root, card) - before} records for ${1 + wonB} writes`);
  for (const p of replay(root, card)[1]) fail(`B log: ${p}`);

  // C - make sure someone holds it, then kill that agent
  let st = holderOf(root, card);
  if (st === "free") {
    const x = await ask(ag[0]!.c, "card_claim", { card });
    if (!x.ok) fail(`C setup: ${x.text}`);
    st = holderOf(root, card);
  }
  H = ag.find((a) => st === `held ${a.session}`)!;
  await agents.kill(H.pid);
  const live = () => ag.filter((a) => a.pid !== H.pid && !dead.has(a.pid));
  const dead = new Set<number>([H.pid]);
  const c0 = claimCount(root, card);
  const claimsC = await Promise.all(live().map((a) => ask(a.c, "card_claim", { card })));
  const gone = claimsC.filter((x) => x.code === "holder_gone").length;
  if (gone !== claimsC.length)
    fail(
      `C: ${gone} of ${claimsC.length} claims said holder_gone (${claimsC.map((x) => x.code ?? "ok").join(",")})`,
    );
  if (claimCount(root, card) !== c0) fail("C: a claim on a dead holder's card wrote a record");
  const takersC = live();
  const tk = await Promise.all(takersC.map((a) => ask(a.c, "card_takeover", { card })));
  const tkWon = tk.filter((x) => x.ok).length;
  const tkRefused = tk.filter((x) => x.code === "refused").length;
  totals.oneWinnerRaces++;
  if (tkWon !== 1 || tkRefused !== takersC.length - 1)
    fail(`C: takeover race ${tkWon} won, ${tkRefused} refused of ${takersC.length}`);
  if (claimCount(root, card) !== c0 + 1)
    fail(`C: takeover race added ${claimCount(root, card) - c0} records`);
  const c1 = claimCount(root, card);
  const tk2 = await Promise.all(live().map((a) => ask(a.c, "card_takeover", { card })));
  if (claimCount(root, card) !== c1) fail("C: the second wave of takeovers changed the log");
  if (tk2.filter((x) => x.ok).length !== 1)
    fail(
      `C: second wave, ${tk2.filter((x) => x.ok).length} told ok (only the holder's "already yours")`,
    );
  for (const p of replay(root, card)[1]) fail(`C log: ${p}`);

  // D - the holder dies again. takeovers, claims and the person's releases at once
  const T = ag.find((a) => holderOf(root, card) === `held ${a.session}`);
  if (!T) fail(`D setup: nobody holds ${card} (${holderOf(root, card)})`);
  else {
    await agents.kill(T.pid);
    dead.add(T.pid);
    const d0 = claimCount(root, card);
    const l = live();
    const half = Math.floor(l.length / 2);
    const resD = await Promise.all([
      ...l.slice(0, half).map((a) => ask(a.c, "card_takeover", { card })),
      ...l.slice(half).map((a) => ask(a.c, "card_claim", { card })),
      ...persons.map((p) => ask(p, "card_release", { card, note: "reassigned by the person" })),
    ]);
    const writes = resD.filter(wrote).length;
    if (claimCount(root, card) - d0 !== writes)
      fail(`D: ${claimCount(root, card) - d0} records for ${writes} writes that said so`);
    for (const p of replay(root, card)[1]) fail(`D log: ${p}`);
  }

  // E - the holder's session comes back in a new process while everyone else takes over
  let X = ag.find((a) => holderOf(root, card) === `held ${a.session}`);
  if (!X) {
    X = live()[0]!;
    const x = await ask(X.c, "card_claim", { card });
    if (!x.ok) fail(`E setup: ${x.text}`);
  }
  const newPid = agents.start();
  await agents.kill(X.pid);
  dead.add(X.pid);
  const [resumed] = await startServers(root, [{ session: X.session, pid: newPid }], { broken });
  const e0 = claimCount(root, card);
  const rivals = live().filter((a) => a !== X);
  const resE = await Promise.all([
    ask(resumed!, "card_claim", { card }),
    ...rivals.map((a) => ask(a.c, "card_takeover", { card })),
  ]);
  totals.oneWinnerRaces++;
  const wonE = resE.filter((x) => x.ok).length;
  if (wonE !== 1)
    fail(
      `E: ${wonE} of ${resE.length} won the resume race (${resE.map((x) => x.code ?? "ok").join(",")})`,
    );
  if (claimCount(root, card) !== e0 + 1) fail(`E: ${claimCount(root, card) - e0} records added`);
  for (const p of replay(root, card)[1]) fail(`E log: ${p}`);
  await closeAll([...cs, ...persons, resumed!]);

  // K - phase A on a fresh project, half the servers killed while it runs
  const rootK = makeProject(path.join(base, `round ${String(r).padStart(2, "0")} K`));
  person(
    "card_create",
    { title: "the contested card" },
    { root: rootK, env: cleanEnv(), person: true },
  );
  const pidsK = Array.from({ length: N }, () => agents.start());
  const csK = await startServers(
    rootK,
    pidsK.map((pid, i) => ({ session: `sess-${i}`, pid })),
    { broken },
  );
  const killAt = csK.map((_, i) =>
    i % 2 === 0 ? Math.floor(Math.random() * Math.max(msA, 20)) : -1,
  );
  const perK = workload(r, N, card);
  await runWorkload(csK, perK, killAt);
  await closeAll(csK);
  const killedK = csK.filter((c) => c.child.signalCode === "SIGKILL").length;
  totals.killed += killedK;
  const { unacked } = checkIds(rootK, card, perK, true);
  totals.unacked += unacked;
  totals.ids += perK.flat().filter((w) => w.res?.ok && w.tag !== "claim").length;
  // a killed writer can leave a conclusion with no INDEX line. reindex adds it, and never twice
  reindex(rootK);
  const idx = readIndex(rootK).length;
  const files = readConclusions(rootK).length;
  const lineIds = fs
    .readFileSync(path.join(rootK, "conclusions", "INDEX.md"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" | ")[0]);
  if (idx !== files || new Set(lineIds).size !== lineIds.length || lineIds.length !== files)
    fail(`K: after reindex ${lineIds.length} INDEX lines for ${files} conclusions`);
  // a writer after the kills gets highest + 1
  const [late] = await startServers(rootK, [{ session: "sess-late", pid: agents.start() }]);
  const highest = Math.max(
    ...ls(path.join(rootK, "cards"))
      .filter((d) => fs.existsSync(path.join(rootK, "cards", d, "card.md")))
      .map((d) => Number(d.split("-")[1])),
  );
  const lateRes = await ask(late!, "card_create", { title: "after the kills" });
  if (lateRes.text.split(" ")[0] !== `AUTH-${highest + 1}`)
    fail(`K: late writer got ${lateRes.text.split(" ")[0]}, wanted AUTH-${highest + 1}`);
  await closeAll([late!]);
  const leftK = temps(rootK);
  totals.tempsLeft += leftK;
  sweepTemps(
    [
      path.join(rootK, "cards"),
      path.join(rootK, "conclusions"),
      path.join(rootK, "cards", card, "comments"),
      path.join(rootK, "cards", card, "claims"),
    ],
    0,
  );
  if (temps(rootK) !== 0) fail(`K: ${temps(rootK)} temp files left after sweepTemps`);

  // G - card directories, with writers killed between their two steps
  const rootG = makeProject(path.join(base, `round ${String(r).padStart(2, "0")} G`));
  // and a plain file where card 1's folder would go, as a hand edit leaves it. it must be stepped over
  fs.mkdirSync(path.join(rootG, "cards"), { recursive: true });
  fs.writeFileSync(path.join(rootG, "cards", "AUTH-1"), "written by hand\n");
  const modes = Array.from({ length: N }, (_, i) =>
    i % 3 !== 0 ? undefined : i % 2 === 0 ? "die-after-card-mkdir" : "die-before-card-link",
  );
  const csG = modes.map((m, i) =>
    server(
      rootG,
      cleanEnv({
        GROVE_RECORD_REGISTRY: registry,
        GROVE_RECORD_SESSION: `sess-${i}`,
        GROVE_RECORD_PID: String(agents.start()),
        GROVE_RECORD_AGENT: `agent ${i}`,
      }),
      { broken: m ?? broken },
    ),
  );
  await Promise.all(csG.map((c) => c.init()));
  const resG = await Promise.all(
    csG.map((c, i) => ask(c, "card_create", { title: `g${i}` }, 10_000)),
  );
  await closeAll(csG);
  const diedG = csG.filter((c) => c.child.signalCode === "SIGKILL").length;
  totals.dirWritersKilled += diedG;
  const isDirG = (d: string) => fs.statSync(path.join(rootG, "cards", d)).isDirectory();
  const dirsG = ls(path.join(rootG, "cards")).filter((d) => /^AUTH-\d+$/.test(d) && isDirG(d));
  const fullG = dirsG.filter((d) => fs.existsSync(path.join(rootG, "cards", d, "card.md")));
  const emptyG = dirsG.filter((d) => !fullG.includes(d)).map((d) => Number(d.split("-")[1]));
  const pG = contiguous(
    [1, ...fullG.map((d) => Number(d.split("-")[1]))],
    "G cards and the stray file",
  );
  if (pG) fail(pG);
  const toldG = new Set<string>();
  resG.forEach((x, i) => {
    if (!x.ok) {
      if (!modes[i] && !broken) fail(`G: c${i} (no kill) got ${x.text}`);
      return;
    }
    const id = x.text.split(" ")[0]!;
    if (toldG.has(id)) fail(`G: ${id} told twice`);
    toldG.add(id);
    if (fm(path.join(rootG, "cards", id, "card.md")).title !== `g${i}`)
      fail(`G: ${id} holds another writer's card`);
  });
  if (fullG.length !== toldG.size)
    fail(`G: ${fullG.length} cards on disk, ${toldG.size} acknowledged`);
  const taken = fullG.length + 1; // the cards and the stray file
  if (emptyG.length > 1 || (emptyG.length === 1 && emptyG[0] !== taken + 1))
    fail(`G: empty card directories ${emptyG.join(",")} with ${fullG.length} cards`);
  // then one writer dies alone, so an empty directory is certain to be left at highest + 1
  const solo = server(
    rootG,
    cleanEnv({
      GROVE_RECORD_REGISTRY: registry,
      GROVE_RECORD_SESSION: "sess-g-solo",
      GROVE_RECORD_PID: String(agents.start()),
    }),
    {
      broken: r % 2 ? "die-before-card-link" : "die-after-card-mkdir",
    },
  );
  await solo.init();
  const soloRes = await ask(solo, "card_create", { title: "dies alone" }, 10_000);
  await solo.exited;
  if (soloRes.answered || solo.child.signalCode !== "SIGKILL")
    fail(`G: the solo writer was not killed (${soloRes.text})`);
  totals.dirWritersKilled++;
  const want = taken + 1;
  if (
    !fs.existsSync(path.join(rootG, "cards", `AUTH-${want}`)) ||
    fs.existsSync(path.join(rootG, "cards", `AUTH-${want}`, "card.md"))
  )
    fail(`G: no empty AUTH-${want} after the solo writer died`);
  // the next writer walks into the empty directory
  const [g2] = await startServers(rootG, [{ session: "sess-g-late", pid: agents.start() }]);
  const lateG = await ask(g2!, "card_create", { title: "after the dead writers" });
  await closeAll([g2!]);
  if (lateG.text.split(" ")[0] !== `AUTH-${want}`)
    fail(`G: late writer got ${lateG.text.split(" ")[0]}, wanted AUTH-${want}`);
  else totals.emptyDirsWalkedInto++;
  const emptyAfter = ls(path.join(rootG, "cards")).filter(
    (d) =>
      /^AUTH-\d+$/.test(d) && isDirG(d) && !fs.existsSync(path.join(rootG, "cards", d, "card.md")),
  );
  if (emptyAfter.length) fail(`G: still empty after the late writer: ${emptyAfter.join(",")}`);

  console.log(
    `round ${String(r).padStart(2)}: A ${msA}ms, claim won by sess-${winner?.i}, K killed ${killedK} servers (${unacked} records published and not acknowledged, ${leftK} temp files), G ${diedG} writers died mid-create in the race (${emptyG.length} empty dir left by it) + 1 alone, its dir reused, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (process.env.KEEP !== "1")
    for (const d of [root, rootK, rootG]) fs.rmSync(d, { recursive: true, force: true });
  agents.stopAll();
  agents.procs = [];
}

console.log(
  `stress: ${ROUNDS} rounds, ${N} contenders, node ${process.version}${broken ? `, BROKEN publish: ${broken}` : ""}\nroots under ${base}`,
);
const started = Date.now();
for (let r = 1; r <= ROUNDS; r++) {
  try {
    await oneRound(r);
  } catch (e) {
    fail(`round crashed: ${(e as Error).stack}`);
  }
}
console.log(
  `TOTAL: ${ROUNDS} rounds, ${fails} failed checks. ${totals.ids} ids handed out, ${totals.oneWinnerRaces} one-winner races, ${totals.killed} servers killed mid-run in K, ${totals.unacked} records published and never acknowledged, ${totals.tempsLeft} temp files left by kills (swept), ${totals.dirWritersKilled} card writers killed between mkdir and link in G, ${totals.emptyDirsWalkedInto} empty card directories reused. ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
process.exit(fails ? 1 : 0);
