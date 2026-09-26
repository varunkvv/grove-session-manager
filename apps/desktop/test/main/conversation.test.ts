import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversationCacheDir, scanSessionAgents } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  call,
  compactBoundary,
  jsonl,
  prompt,
  result,
  says,
  text,
} from "../../../../packages/core/test/helpers/sessionTranscript.ts";
import { AgentInspector } from "../../src/main/services/agentInspector.ts";
import { Conversations, SAVE_EVERY_MS } from "../../src/main/services/conversations.ts";
import type { ConversationTurn, ConversationTurns } from "../../src/shared/ipc.ts";

// a stretch of a real 107MB session with every string replaced, and one background agent of it
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../packages/core/test/fixtures/conversation",
);
const SESSION = "78b60000-0000-4000-8000-000000000001";
const AGENT = "a78b6000000000002";

const inspectors: AgentInspector[] = [];
afterEach(() => {
  for (const i of inspectors.splice(0)) i.dispose();
});

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-conversation-")));
  cpSync(FIXTURES, path.join(dir, "projects"), { recursive: true });
  return dir;
}

async function open(dir: string, opts: { running?: boolean; tailMs?: number } = {}) {
  const key = path.join(dir, "projects", `${SESSION}.jsonl`);
  const snapshot = await scanSessionAgents(key, { sessionLive: false });
  const pushes: ConversationTurns[] = [];
  const inspector = new AgentInspector({
    stateDir: path.join(dir, "state"),
    snapshot: (k) => (k === key ? snapshot : undefined),
    transcript: (k) => (k === key ? key : undefined),
    running: () => opts.running ?? false,
    onTurns: (p) => pushes.push(p),
    tailMs: opts.tailMs ?? 20,
  });
  inspectors.push(inspector);
  return { key, inspector, pushes };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("a session's conversation, from main", () => {
  it("sends every turn with its numbers and its answer, and none of the work", async () => {
    const { key, inspector } = await open(sandbox());
    const res = await inspector.followConversation(key);
    const view = res?.conversation;
    expect(view?.items).toHaveLength(33);
    expect(view?.turns).toBe(30);
    expect(view?.model).toMatch(/^claude-/);
    expect(view?.live).toBeUndefined();
    const turns = view?.items.filter((i): i is ConversationTurn => i.kind === "turn") ?? [];
    for (const [i, item] of (view?.items ?? []).entries()) expect(item.n).toBe(i);
    expect(turns.filter((t) => t.answer).length).toBeGreaterThan(20);
    expect(turns.find((t) => t.prompt?.kind === "command")?.output).toBeTruthy();
    // no steps travel with it: the work line's numbers are all there is of the work
    expect(JSON.stringify(view)).not.toContain('"steps"');
    expect(turns.reduce((n, t) => n + t.tools, 0)).toBe(view?.tools);
  });

  it("opens one turn's work, with an Agent call linked to the agent it started", async () => {
    const { key, inspector } = await open(sandbox());
    const view = (await inspector.followConversation(key))?.conversation;
    const turns = view?.items.filter((i): i is ConversationTurn => i.kind === "turn") ?? [];
    const withAgents = turns.find((t) => t.agents > 0);
    const steps = await inspector.conversationSteps(key, withAgents?.n ?? -1);
    const agentCalls = steps?.filter((s) => s.kind === "tool" && s.name === "Agent") ?? [];
    expect(agentCalls).toHaveLength(withAgents?.agents ?? -1);
    expect(agentCalls.some((s) => s.kind === "tool" && s.agentId === AGENT)).toBe(true);
    // the answer is drawn on its own, not again among the steps
    const answered = turns.find((t) => t.answer && t.tools > 0);
    const work = await inspector.conversationSteps(key, answered?.n ?? -1);
    expect(work?.some((s) => s.kind === "text" && answered?.answer?.startsWith(s.text))).toBe(
      false,
    );
    // a mark's step is a line of the opened work
    const planned = turns.find((t) => t.marks.some((m) => m.kind === "plan"));
    const planSteps = await inspector.conversationSteps(key, planned?.n ?? -1);
    for (const m of planned?.marks ?? []) {
      if (m.kind === "said") continue;
      expect(planSteps?.find((s) => s.n === m.step)).toMatchObject({ kind: "tool" });
    }
    expect(await inspector.conversationSteps(key, 999)).toBeNull();
    expect(await inspector.conversationSteps("/nowhere.jsonl", 0)).toBeNull();
  });

  it("opens a step by reading it back from the transcript, and only from the one the index names", async () => {
    const { key, inspector } = await open(sandbox());
    const view = (await inspector.followConversation(key))?.conversation;
    const turn = view?.items.find(
      (i): i is ConversationTurn => i.kind === "turn" && i.filesEdited > 0,
    );
    const steps = await inspector.conversationSteps(key, turn?.n ?? -1);
    const edit = steps?.find((s) => s.kind === "tool" && s.name === "Edit");
    const detail = await inspector.conversationStep(key, edit?.kind === "tool" ? edit.id : "");
    expect(detail?.diffs?.[0]?.hunks.length).toBeGreaterThan(0);
    expect(JSON.parse(detail?.input ?? "{}")).toHaveProperty("file_path");
    expect(await inspector.conversationStep(key, "toolu_not_there")).toBeNull();
    expect(await inspector.conversationStep("/etc/passwd", "x")).toBeNull();
  });

  it("lands a search on the turn that holds it, and on the step when it is in the work", async () => {
    const { key, inspector } = await open(sandbox());
    const base = (await inspector.followConversation(key))?.conversation;
    const turns = base?.items.filter((i): i is ConversationTurn => i.kind === "turn") ?? [];
    const prompted = turns.find((t) => t.prompt?.kind === "human" && t.prompt.text.length > 40);
    const words = prompted?.prompt?.text.split(" ").slice(0, 6).join(" ") ?? "";
    const hit = await inspector.followConversation(key, words);
    expect(hit?.found?.n).toBeDefined();
    const at = hit?.conversation.items[hit.found?.n ?? -1];
    expect(at?.kind).toBe("turn");
    // a command no prompt or answer says lands inside the work
    const steps = await inspector.conversationSteps(key, turns.find((t) => t.tools > 5)?.n ?? -1);
    const bash = steps?.find((s) => s.kind === "tool" && s.name === "Bash" && s.target.length > 30);
    // every word of it in a long plan earlier on, and word for word in a later prompt: the prompt
    const later = turns
      .filter((t) => t.prompt?.kind === "human" && t.prompt.text.length > 30)
      .at(-1);
    const exact = later?.prompt?.text.slice(0, 30) ?? "";
    const phrase = await inspector.followConversation(key, exact);
    expect(phrase?.found?.n).toBe(later?.n);
    const inWork = await inspector.followConversation(
      key,
      bash?.kind === "tool" ? bash.target.slice(0, 40) : "",
    );
    expect(inWork?.found?.step).toBeDefined();
  });

  it("keeps the fold in .grove, and starts from it next time", async () => {
    const dir = sandbox();
    const first = await open(dir);
    const view = (await first.inspector.followConversation(first.key))?.conversation;
    const cache = conversationCacheDir(path.join(dir, "state"));
    for (let i = 0; i < 100 && !(existsSync(cache) && readdirSync(cache).length); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readdirSync(cache)).toHaveLength(1);
    // same size, same time, different bytes: only the cache can still give the old answer
    const info = statSync(first.key);
    writeFileSync(first.key, " ".repeat(info.size));
    utimesSync(first.key, info.atime, info.mtime);
    const again = await open(dir);
    expect((await again.inspector.followConversation(again.key))?.conversation).toEqual(view);
  });
});

/** a session still writing, with one turn done and one under way */
function runningSession() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-conversation-tail-")));
  mkdirSync(path.join(dir, "projects"), { recursive: true });
  const key = path.join(dir, "projects", `${SESSION}.jsonl`);
  writeFileSync(
    key,
    jsonl([
      prompt("what does the parser do?", 0),
      says("m1", text("It reads one line at a time."), 2),
      prompt("make it faster", 10),
      says("m2", call("t1", "Read", { file_path: "/work/api/parse.ts" }), 11),
      result("t1", "export function parse() {}", 12),
    ]),
  );
  return { dir, key };
}

describe("following a conversation as it is written", () => {
  it("pushes the turn that changed, and the live turn's work from its first changed step", async () => {
    const { dir, key } = runningSession();
    const { inspector, pushes } = await open(dir, { running: true });
    const started = await inspector.followConversation(key);
    // running: the newest turn's work comes open
    expect(started?.conversation.live).toMatchObject({ n: 1, steps: [{ name: "Read", n: 0 }] });

    appendFileSync(key, jsonl([says("m3", call("t2", "Bash", { command: "pnpm bench" }), 13)]));
    await until(() => pushes.length === 1);
    expect(pushes[0]).toMatchObject({ key, gen: started?.gen, from: 1 });
    expect(pushes[0]?.items.map((i) => i.n)).toEqual([1]);
    expect(pushes[0]?.live).toMatchObject({ n: 1, from: 1, steps: [{ name: "Bash", n: 1 }] });
    expect(pushes[0]?.head.tools).toBe(2);

    // the call comes back and the answer arrives: the step again, with its time, and no answer step
    appendFileSync(
      key,
      jsonl([result("t2", "3x faster", 40), says("m4", text("Three times faster now."), 41)]),
    );
    await until(() => pushes.length === 2);
    expect(pushes[1]?.live?.from).toBe(1);
    expect(pushes[1]?.live?.steps).toMatchObject([{ name: "Bash", durationMs: 27_000 }]);
    expect(pushes[1]?.items[0]).toMatchObject({ kind: "turn", answer: "Three times faster now." });

    // a compaction and the next prompt: new entries, the turns before them are not sent again
    appendFileSync(key, jsonl([compactBoundary(50), prompt("ship it", 60)]));
    await until(() => pushes.length === 3);
    expect(pushes[2]?.from).toBe(2);
    expect(pushes[2]?.items.map((i) => i.kind)).toEqual(["compact", "turn"]);
    expect(pushes[2]?.live).toMatchObject({ n: 3, from: 0, steps: [] });
  });

  it("one thing on screen: a conversation replaces an agent, and leaving one never stops the other", async () => {
    const { dir, key } = runningSession();
    const { inspector, pushes } = await open(dir);
    const first = await inspector.followConversation(key);
    // an agent view closing after the conversation took its place says nothing to the conversation
    expect(await inspector.follow(key, null)).toBeNull();
    appendFileSync(key, jsonl([says("m9", call("t9", "Grep", { pattern: "parse" }), 20)]));
    await until(() => pushes.length === 1);
    expect(pushes[0]?.gen).toBe(first?.gen);

    expect(await inspector.followConversation(null)).toBeNull();
    appendFileSync(key, jsonl([result("t9", "a.ts", 21)]));
    await new Promise((r) => setTimeout(r, 120));
    expect(pushes).toHaveLength(1);
  });
});

describe("keeping a running session's fold on disk", () => {
  it("writes it when it is first read, then at most every half minute while it grows", async () => {
    const { dir, key } = runningSession();
    let now = 1_000_000;
    const conversations = new Conversations({ stateDir: path.join(dir, "state"), now: () => now });
    const cache = conversationCacheDir(path.join(dir, "state"));
    const written = async () => {
      await new Promise((r) => setTimeout(r, 30));
      const [file] = existsSync(cache) ? readdirSync(cache) : [];
      return file ? JSON.parse(readFileSync(path.join(cache, file), "utf8")).mark : null;
    };
    const first = await conversations.read(key);
    expect(await written()).toBe(first?.mark);

    appendFileSync(key, jsonl([says("m5", text("more"), 30)]));
    utimesSync(key, new Date(), new Date(Date.now() + 5_000));
    const second = await conversations.read(key);
    expect(second?.state.offset).toBeGreaterThan(first?.state.offset ?? 0);
    // too soon: the disk keeps the older reading, which is still a right place to start from
    expect(await written()).toBe(first?.mark);

    now += SAVE_EVERY_MS;
    appendFileSync(key, jsonl([says("m6", text("and more"), 31)]));
    utimesSync(key, new Date(), new Date(Date.now() + 10_000));
    const third = await conversations.read(key);
    expect(await written()).toBe(third?.mark);

    // what was read since goes to disk when the session leaves the screen
    appendFileSync(key, jsonl([says("m7", text("last"), 32)]));
    utimesSync(key, new Date(), new Date(Date.now() + 15_000));
    const fourth = await conversations.read(key);
    conversations.save(key);
    expect(await written()).toBe(fourth?.mark);
  });
});
