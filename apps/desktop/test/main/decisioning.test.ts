import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MODEL,
  emptyScores,
  GAVEL,
  type ModelEntry,
  type ScoreFile,
  scoresFileName,
  toKept,
} from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DecisioningService,
  decisioningSetup,
  macosSupported,
} from "../../src/main/services/decisioning.ts";
import {
  DownloadError,
  downloadModel,
  modelBytes,
  modelReady,
  removeModel,
  weightsPath,
} from "../../src/main/services/modelFile.ts";
import { buildOddsView } from "../../src/main/services/odds.ts";
import { Scorer, type ScorerChild } from "../../src/main/services/scorer.ts";
import { scorerHandler } from "../../src/scorer/handler.ts";
import type { FromScorer, ToScorer } from "../../src/scorer/protocol.ts";
import type { DecisioningStatus } from "../../src/shared/ipc.ts";

const sandbox = (p: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));

// ---------- a stand-in model server: Range requests, like the Hugging Face CDN

const WEIGHTS = Buffer.from(`${"x".repeat(64 * 1024)}the end of a pretend gguf`);
const SHA = createHash("sha256").update(WEIGHTS).digest("hex");
const FILE = { file: "pretend.gguf", sha256: SHA, size: WEIGHTS.length };

let server: Server | undefined;
let requests: Array<string | undefined> = [];

async function serve(body: Buffer, o: { ignoreRange?: boolean; status?: number } = {}) {
  requests = [];
  const s = createServer((req, res) => {
    requests.push(req.headers.range);
    if (o.status) {
      res.writeHead(o.status).end();
      return;
    }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (m && !o.ignoreRange) {
      const from = Number(m[1]);
      res.writeHead(206, { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(from));
    } else {
      res.writeHead(200).end(body);
    }
  });
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/m.gguf`;
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

const plenty = async () => 1e12;

describe("the model download", () => {
  it("fetches the weights, checks the hash and keeps them", async () => {
    const dir = sandbox("grove-models-");
    const url = await serve(WEIGHTS);
    const seen: number[] = [];
    await downloadModel({
      dir,
      model: FILE,
      url,
      fetch,
      free: plenty,
      onProgress: (n) => seen.push(n),
    });
    expect(readFileSync(weightsPath(dir, FILE)).equals(WEIGHTS)).toBe(true);
    expect(await modelReady(dir, FILE)).toBe(true);
    expect(seen.at(-1)).toBe(WEIGHTS.length);
    expect(requests).toEqual([undefined]);
    // ready: nothing is asked again
    await downloadModel({ dir, model: FILE, url, fetch, free: plenty });
    expect(requests).toHaveLength(1);
  });

  it("carries on from where it stopped", async () => {
    const dir = sandbox("grove-models-");
    writeFileSync(`${weightsPath(dir, FILE)}.part`, WEIGHTS.subarray(0, 1000));
    expect(await modelBytes(dir, FILE)).toBe(1000);
    const url = await serve(WEIGHTS);
    await downloadModel({ dir, model: FILE, url, fetch, free: plenty });
    expect(requests).toEqual(["bytes=1000-"]);
    expect(await modelReady(dir, FILE)).toBe(true);
  });

  it("starts again when the server ignores the range", async () => {
    const dir = sandbox("grove-models-");
    writeFileSync(`${weightsPath(dir, FILE)}.part`, Buffer.from("junk junk junk"));
    const url = await serve(WEIGHTS, { ignoreRange: true });
    await downloadModel({ dir, model: FILE, url, fetch, free: plenty });
    expect(readFileSync(weightsPath(dir, FILE)).equals(WEIGHTS)).toBe(true);
  });

  it("throws away a file that does not hash to the pin", async () => {
    const dir = sandbox("grove-models-");
    const url = await serve(Buffer.from(`${WEIGHTS.toString().slice(0, -3)}bad`));
    await expect(downloadModel({ dir, model: FILE, url, fetch, free: plenty })).rejects.toThrow(
      /did not match/,
    );
    expect(existsSync(weightsPath(dir, FILE))).toBe(false);
    expect(existsSync(`${weightsPath(dir, FILE)}.part`)).toBe(false);
  });

  it("refuses to fill the disk, and says a server error", async () => {
    const dir = sandbox("grove-models-");
    const url = await serve(WEIGHTS);
    const err = await downloadModel({ dir, model: FILE, url, fetch, free: async () => 10 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).code).toBe("disk");
    expect(requests).toEqual([]);
    await new Promise((r) => server?.close(r));
    const broken = await serve(WEIGHTS, { status: 404 });
    await expect(
      downloadModel({ dir, model: FILE, url: broken, fetch, free: plenty }),
    ).rejects.toThrow(/answered 404/);
  });

  it("names the weights by their hash: a moved or renamed upstream file is the same weights", () => {
    const a = weightsPath("/m", { sha256: SHA, size: 1 });
    expect(path.basename(a)).toBe(`${SHA.slice(0, 16)}.gguf`);
    // the same bytes under another repo and name: one file on disk
    const moved: ModelEntry = { ...DEFAULT_MODEL, repo: "someone/else", file: "x.gguf" };
    expect(weightsPath("/m", moved)).toBe(weightsPath("/m", DEFAULT_MODEL));
    // two models with the same upstream name: two files
    expect(weightsPath("/m", { sha256: "0".repeat(64), size: 1 })).not.toBe(a);
  });

  it("deletes the weights, a part and the check", async () => {
    const dir = sandbox("grove-models-");
    const url = await serve(WEIGHTS);
    await downloadModel({ dir, model: FILE, url, fetch, free: plenty });
    await removeModel(dir, FILE);
    expect(await modelReady(dir, FILE)).toBe(false);
    expect(await modelBytes(dir, FILE)).toBe(0);
  });
});

// ---------- the scorer process, as a fake child running the real handler with the stub

function fakeChild(
  o: { failLoad?: boolean; log?: ToScorer[] } = {},
): ScorerChild & { killed: boolean } {
  const on: { message: Array<(m: FromScorer) => void>; exit: Array<(c: number) => void> } = {
    message: [],
    exit: [],
  };
  const handle = scorerHandler((m) => {
    for (const l of on.message) l(m);
  });
  const child = {
    killed: false,
    postMessage(m: ToScorer) {
      o.log?.push(m);
      if (o.failLoad && m.type === "load") {
        queueMicrotask(() => {
          for (const l of on.message) l({ type: "failed", error: "no metal" });
        });
        return;
      }
      void handle(m);
    },
    on(event: "message" | "exit", l: never) {
      (on[event] as unknown[]).push(l);
      return child;
    },
    kill() {
      child.killed = true;
      for (const l of on.exit) l(0);
      return true;
    },
  };
  return child as ScorerChild & { killed: boolean };
}

const scorerOpts = {
  mode: "stub" as const,
  modelPath: "/nowhere.gguf",
  model: DEFAULT_MODEL,
  rubric: GAVEL,
};

describe("the scorer process", () => {
  it("loads once, judges in order, and goes when idle", async () => {
    const log: ToScorer[] = [];
    let spawned = 0;
    const scorer = new Scorer({
      ...scorerOpts,
      spawn: () => {
        spawned++;
        return fakeChild({ log });
      },
      idleMs: 30,
    });
    const [a, b] = await scorer.score([
      { text: "you broke the login page" },
      { text: "thanks, ship it" },
    ]);
    expect(a?.blame?.[3]).toBe(0.9);
    expect(b?.gratitude?.[2]).toBe(0.9);
    await scorer.score([{ text: "rename it" }]);
    expect(log.map((m) => m.type)).toEqual(["load", "score", "score"]);
    expect(spawned).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(scorer.running).toBe(false);
    await scorer.score([{ text: "and again" }]);
    expect(spawned).toBe(2);
    scorer.stop();
  });

  it("fails a judge whose model will not load, and starts again on the next", async () => {
    let fail = true;
    const scorer = new Scorer({ ...scorerOpts, spawn: () => fakeChild({ failLoad: fail }) });
    await expect(scorer.score([{ text: "x y z w" }])).rejects.toThrow("no metal");
    fail = false;
    expect(await scorer.score([{ text: "x y z w" }])).toHaveLength(1);
    scorer.stop();
  });
});

// ---------- the service, end to end with made-up transcripts

let line = 0;
const prompt = (text: string, minutesAgo: number, cwd = "/Users/someone/src/app") =>
  JSON.stringify({
    type: "user",
    uuid: `00000000-0000-4000-8000-${String(++line).padStart(12, "0")}`,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    cwd,
    sessionId: "s",
    message: { role: "user", content: text },
  });

function setup(
  o: { on?: boolean; battery?: boolean; ready?: boolean; transcripts?: string[] } = {},
) {
  const state = sandbox("grove-decide-");
  const models = path.join(state, "models");
  const statuses: DecisioningStatus[] = [];
  const settings = { on: o.on ?? true };
  const files = o.transcripts ?? [];
  const svc = new DecisioningService({
    stateDir: state,
    modelsDir: models,
    model: DEFAULT_MODEL,
    file: FILE,
    rubric: GAVEL,
    mode: "stub",
    enabled: () => settings.on,
    supported: true,
    transcripts: () => files.map((p) => ({ path: p, size: readFileSync(p).length })),
    onBattery: () => o.battery === true,
    busy: () => false,
    spawn: () => fakeChild(),
    fetch,
    free: plenty,
    onStatus: (s) => statuses.push(s),
  });
  return { svc, state, models, statuses, settings };
}

async function readyModel(dir: string) {
  const url = await serve(WEIGHTS);
  await downloadModel({ dir, model: FILE, url, fetch, free: plenty });
}

function transcript(lines: string[]): string {
  const file = path.join(sandbox("grove-t-"), "s.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("decisioning", () => {
  it("judges nothing while it is off or has no model", async () => {
    const t = transcript([prompt("you broke the build again", 60)]);
    const off = setup({ on: false, transcripts: [t] });
    await readyModel(off.models);
    await off.svc.load();
    await off.svc.run();
    expect(off.svc.status().prompts).toBe(0);
    expect(off.svc.odds(() => null)).toBeUndefined();

    const bare = setup({ transcripts: [t] });
    await bare.svc.load();
    await bare.svc.run();
    expect(bare.svc.status().model.state).toBe("missing");
    expect(bare.svc.odds(() => null)).toBeUndefined();
    await off.svc.dispose();
    await bare.svc.dispose();
  });

  it("reads, judges, keeps only scores, and draws the odds", async () => {
    const t = transcript([
      prompt("squash the commits into one", 300),
      prompt("you broke the login page again", 200),
      prompt("ok", 150),
      prompt("good catch on the timezone bug", 100),
    ]);
    const { svc, state, models } = setup({ transcripts: [t] });
    await readyModel(models);
    await svc.load();
    await svc.run();
    const s = svc.status();
    expect(s.model.state).toBe("ready");
    // "ok" is too short to judge
    expect([s.prompts, s.scored]).toEqual([3, 3]);
    const odds = svc.odds((key) => (key === t ? { title: "the login work", project: null } : null));
    expect(odds?.sessions).toHaveLength(1);
    expect(odds?.sessions[0]?.series).toHaveLength(3);
    expect(odds?.current?.key).toBe(t);
    expect(odds?.days.reduce((n, d) => n + d.prompts, 0)).toBe(3);
    await svc.dispose();
    const kept = readFileSync(path.join(state, scoresFileName(GAVEL)), "utf8");
    expect(kept).not.toContain("login");
    expect(kept).not.toContain("timezone");
  });

  it("on battery, judges only what is new and says what it waits for", async () => {
    const t = transcript([
      prompt("rename the old helper module", 600),
      prompt("thanks, now the tests", 1),
    ]);
    const { svc, models } = setup({ battery: true, transcripts: [t] });
    await readyModel(models);
    await svc.load();
    await svc.run();
    const s = svc.status();
    expect([s.prompts, s.scored, s.waiting]).toEqual([2, 1, "battery"]);
    await svc.dispose();
  });

  it("downloads the model when it is switched on, and deletes it at once", async () => {
    const url = await serve(WEIGHTS);
    const t = transcript([prompt("could you rebase this on main", 30)]);
    const state = sandbox("grove-decide-");
    const settings = { on: false };
    const statuses: DecisioningStatus[] = [];
    const svc = new DecisioningService({
      stateDir: state,
      modelsDir: path.join(state, "models"),
      model: DEFAULT_MODEL,
      file: FILE,
      url,
      rubric: GAVEL,
      mode: "stub",
      enabled: () => settings.on,
      supported: true,
      transcripts: () => [{ path: t, size: readFileSync(t).length }],
      onBattery: () => false,
      busy: () => false,
      spawn: () => fakeChild(),
      fetch,
      free: plenty,
      onStatus: (s) => statuses.push(s),
    });
    await svc.load();
    expect(svc.status().model.state).toBe("missing");
    settings.on = true;
    svc.switched(true);
    await expect.poll(() => svc.status().model.state).toBe("ready");
    expect(statuses.some((s) => s.model.state === "downloading")).toBe(true);
    await svc.run();
    expect(svc.status().scored).toBe(1);
    await svc.deleteModel();
    expect(svc.status().model.state).toBe("missing");
    expect(await modelReady(path.join(state, "models"), FILE)).toBe(false);
    // the scores stay: the same model gives the same answers
    expect(svc.status().scored).toBe(1);
    await svc.dispose();
  });

  it("off, on, off again: nothing runs while off, and off stops the judging but keeps the model", async () => {
    const t = transcript([
      prompt("rename the old helper module", 120),
      prompt("you broke the login page again", 60),
    ]);
    const state = sandbox("grove-decide-");
    const models = path.join(state, "models");
    const settings = { on: false };
    let spawned = 0;
    const children: Array<ScorerChild & { killed: boolean }> = [];
    const svc = new DecisioningService({
      stateDir: state,
      modelsDir: models,
      model: DEFAULT_MODEL,
      file: FILE,
      url: await serve(WEIGHTS),
      rubric: GAVEL,
      mode: "stub",
      enabled: () => settings.on,
      supported: true,
      transcripts: () => [{ path: t, size: readFileSync(t).length }],
      onBattery: () => false,
      busy: () => false,
      spawn: () => {
        spawned++;
        const c = fakeChild();
        children.push(c);
        return c;
      },
      fetch,
      free: plenty,
      onStatus: () => {},
    });
    // off, the model not on disk: nothing is fetched, read, judged or started
    await svc.load();
    await svc.run();
    expect(requests).toEqual([]);
    expect([svc.status().prompts, spawned, svc.scorerRunning]).toEqual([0, 0, false]);
    expect(svc.odds(() => null)).toBeUndefined();

    // on: the model comes down, the prompts are read and judged in the scorer's process
    settings.on = true;
    svc.switched(true);
    await expect.poll(() => svc.status().model.state).toBe("ready");
    await svc.run();
    expect([svc.status().prompts, svc.status().scored, spawned]).toEqual([2, 2, 1]);
    expect(svc.scorerRunning).toBe(true);
    expect(svc.odds(() => null)?.current).toBeDefined();

    // off again: the process goes, the tile goes, the weights stay, and a new prompt waits
    settings.on = false;
    svc.switched(false);
    expect(svc.scorerRunning).toBe(false);
    expect(children[0]?.killed).toBe(true);
    expect(svc.odds(() => null)).toBeUndefined();
    expect(await modelReady(models, FILE)).toBe(true);
    writeFileSync(t, `${readFileSync(t, "utf8")}${prompt("thanks, that fixed it for good", 1)}\n`);
    await svc.run();
    expect([svc.status().prompts, spawned]).toEqual([2, 1]);
    expect(svc.status().on).toBe(false);
    await svc.dispose();
  });

  it("is off below macOS 14, and a test root never reaches the real model", () => {
    expect(macosSupported("darwin", "14.0.0")).toBe(true);
    expect(macosSupported("darwin", "13.6.1")).toBe(false);
    expect(macosSupported("linux", "24.0")).toBe(false);
    const base = {
      stateDir: "/r/.grove",
      appData: "/Users/x/Library/Application Support",
      model: DEFAULT_MODEL,
      url: "https://huggingface.co/x",
      platform: "darwin",
      systemVersion: "26.7.0",
      totalMemory: 16 * 1024 ** 3,
    };
    const real = decisioningSetup({ ...base, env: {}, customRoot: false });
    expect(real.mode).toBe("llama");
    expect(real.url).toBe("https://huggingface.co/x");
    expect(real.modelsDir).toBe("/Users/x/Library/Application Support/Grove/models");
    // the scores have a folder of their own in the state dir: one file per task
    expect(real.stateDir).toBe("/r/.grove/decisioning");
    const test = decisioningSetup({ ...base, env: {}, customRoot: true });
    expect([test.mode, test.url, test.modelsDir]).toEqual(["stub", undefined, "/r/.grove/models"]);
    const stand = decisioningSetup({
      ...base,
      customRoot: true,
      env: {
        GROVE_MODEL_URL: "http://127.0.0.1:1/m",
        GROVE_MODEL_SHA256: "ab",
        GROVE_MODEL_SIZE: "9",
      },
    });
    expect(stand.url).toBe("http://127.0.0.1:1/m");
    expect(stand.file).toEqual({ sha256: "ab", size: 9 });
    // a model that wants more memory than the mac has is off, and says why
    const small = decisioningSetup({
      ...base,
      env: {},
      customRoot: false,
      model: { ...DEFAULT_MODEL, minMemoryGB: 32 },
    });
    expect([small.supported, small.unsupported]).toEqual([
      false,
      "Needs a Mac with 32 GB of memory or more.",
    ]);
    const old = decisioningSetup({ ...base, env: {}, customRoot: false, systemVersion: "13.6" });
    expect(old.unsupported).toBe("Needs macOS 14 or later.");
    expect(real.supported).toBe(true);
  });

  it("says when the scorer will not run, and does not try again for a minute", async () => {
    const t = transcript([prompt("rename the old helper module", 30)]);
    const { models, state } = setup();
    await readyModel(models);
    const settings = { on: true };
    let spawned = 0;
    const svc = new DecisioningService({
      stateDir: state,
      modelsDir: models,
      model: DEFAULT_MODEL,
      file: FILE,
      rubric: GAVEL,
      mode: "stub",
      enabled: () => settings.on,
      supported: true,
      transcripts: () => [{ path: t, size: readFileSync(t).length }],
      onBattery: () => false,
      busy: () => false,
      spawn: () => {
        spawned++;
        return fakeChild({ failLoad: true });
      },
      fetch,
      free: plenty,
      onStatus: () => {},
    });
    await svc.load();
    await svc.run();
    expect(svc.status().stalled).toBe("no metal");
    expect(svc.status().scored).toBe(0);
    await svc.run();
    expect(spawned).toBe(1);
    await svc.dispose();
  });
});

describe("the odds view", () => {
  const probs = (levels: Record<string, number>) =>
    Object.fromEntries(
      GAVEL.questions.map((q) => [q.id, q.criteria.map((_, i) => (i === levels[q.id] ? 1 : 0))]),
    );

  it("runs the ledger per session and per day, and leaves out what was not judged", () => {
    const file: ScoreFile = emptyScores(GAVEL);
    const day = new Date(2026, 9, 14, 10).getTime();
    file.files["/a.jsonl"] = {
      offset: 1,
      prompts: [
        { uuid: "a1", at: day, hash: "h", raw: "r1" },
        { uuid: "a2", at: day + 60_000, hash: "h", raw: "r2" },
        { uuid: "a3", at: day + 120_000, hash: "h", raw: "r3", short: true },
        { uuid: "a4", at: day + 180_000, hash: "h", raw: "r4" },
      ],
    };
    file.files["/b.jsonl"] = {
      offset: 1,
      prompts: [{ uuid: "b1", at: day + 30_000, hash: "h", raw: "r5" }],
    };
    file.scores["a1:h"] = toKept(GAVEL, "m", probs({ deference: 2, gratitude: 2, blame: 0 }));
    file.scores["a2:h"] = toKept(GAVEL, "m", probs({ deference: 1, gratitude: 0, blame: 3 }));
    // too long for the model
    file.scores["a4:h"] = { m: "m", p: [] };
    file.scores["b1:h"] = toKept(GAVEL, "m", probs({ deference: 1, gratitude: 0, blame: 0 }));
    const view = buildOddsView({
      file,
      rubric: GAVEL,
      model: { tieMargin: 0.2 },
      place: (p) => (p === "/a.jsonl" ? { title: "a", project: "p1" } : null),
    });
    expect([view.prompts, view.scored]).toEqual([4, 4]);
    // thanks (+14) then an accusation (-8.3)
    const a = view.sessions[0]?.series ?? [];
    expect(a).toHaveLength(2);
    expect(a[0]).toBeCloseTo(64);
    // b is not listed (grove no longer lists it) but its prompt is in the day
    expect(view.sessions).toHaveLength(1);
    expect(view.days).toEqual([{ day: "2026-10-14", odds: expect.any(Number), prompts: 3 }]);
    expect(view.current).toEqual({ key: "/a.jsonl", odds: a[1], at: day + 60_000 });
  });
});
