import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  firstSentence,
  readAgentTimeline,
  resultText,
  scanSessionAgents,
  timelineCacheDir,
  timelineView,
} from "@grove/core";
import { describe, expect, it } from "vitest";
import { AgentInspector } from "../../src/main/services/agentInspector.ts";

// real agent transcripts with every string replaced, next to the parent lines that started them
const FIXTURES = path.resolve(
  import.meta.dirname,
  "../../../../packages/core/test/fixtures/timeline",
);
const EXPLORE = { session: "9dda0000-0000-4000-8000-000000000001", agent: "a9dda000000000002" };
const WORKFLOW = {
  session: "89950000-0000-4000-8000-000000000001",
  agent: "a8995000000000002",
  run: "wf_a8995000-003",
};
const ERRORED = { session: "1f4d0000-0000-4000-8000-000000000001", agent: "a1f4d000000000002" };
const INTERRUPTED = { session: "d8970000-0000-4000-8000-000000000001" };

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-inspector-")));
  cpSync(FIXTURES, path.join(dir, "projects"), { recursive: true });
  return dir;
}

async function open(dir: string, session: string) {
  const key = path.join(dir, "projects", `${session}.jsonl`);
  // nothing of these sessions is running any more
  const snapshot = await scanSessionAgents(key, { sessionLive: false });
  const inspector = new AgentInspector({
    stateDir: path.join(dir, "state"),
    snapshot: (k) => (k === key ? snapshot : undefined),
  });
  return { key, snapshot, inspector };
}

/** what the parent session got back from its Agent call: Claude Code's own account */
function parentReturn(dir: string, session: string, agentId: string): Record<string, unknown> {
  const file = path.join(dir, "projects", `${session}.jsonl`);
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.toolUseResult?.agentId === agentId) return entry.toolUseResult;
  }
  throw new Error(`no Agent result for ${agentId}`);
}

describe("what a session's agents did", () => {
  it("counts an agent the way Claude Code reports it to the parent", async () => {
    const dir = sandbox();
    const { key, inspector } = await open(dir, EXPLORE.session);
    const seen = await inspector.inspect(key);
    const stats = seen.agents[EXPLORE.agent];
    const told = parentReturn(dir, EXPLORE.session, EXPLORE.agent);
    expect(stats?.toolCount).toBe(told.totalToolUseCount);
    expect(stats?.tokens).toBe(told.totalTokens);
    const content = told.content as Array<{ text: string }>;
    expect(stats?.outcome).toBe(firstSentence(content.map((b) => b.text).join("\n\n")));
    expect(stats?.model).toMatch(/^claude-/);
    expect(stats?.lastAt).toBeGreaterThan(stats?.startedAt ?? Number.POSITIVE_INFINITY);
    expect(stats?.error).toBeUndefined();
  });

  it("names a workflow from the session's own transcript, and its agent's result from the journal", async () => {
    const dir = sandbox();
    const { key, inspector } = await open(dir, WORKFLOW.session);
    const seen = await inspector.inspect(key);
    expect(seen.workflows[WORKFLOW.run]?.name).toBe("could ran next a ran from could");
    const journal = readFileSync(
      path.join(
        dir,
        "projects",
        WORKFLOW.session,
        "subagents/workflows",
        WORKFLOW.run,
        "journal.jsonl",
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "result");
    expect(seen.agents[WORKFLOW.agent]?.outcome).toBe(firstSentence(journal.result));
    // nobody gave a workflow's agent a label, so the start of what it was asked stands in
    expect(seen.agents[WORKFLOW.agent]?.asked).toBeTruthy();
  });

  it("says how an agent ended badly", async () => {
    const dir = sandbox();
    const errored = await open(dir, ERRORED.session);
    expect((await errored.inspector.inspect(errored.key)).agents[ERRORED.agent]?.error).toMatch(
      /^API Error/,
    );
    const interrupted = await open(dir, INTERRUPTED.session);
    const seen = await interrupted.inspector.inspect(interrupted.key);
    expect(Object.values(seen.agents).map((a) => a.interrupted)).toEqual([true, true]);
  });

  it("keeps a finished agent's reading in .grove, keyed by its own file", async () => {
    const dir = sandbox();
    const first = await open(dir, EXPLORE.session);
    const before = (await first.inspector.inspect(first.key)).agents[EXPLORE.agent];
    const cache = timelineCacheDir(path.join(dir, "state"));
    // written in the background, after the answer went out
    for (let i = 0; i < 50 && !existsSync(cache); i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 50 && readdirSync(cache).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(readdirSync(cache)).toHaveLength(1);

    // same size, same time, different bytes: only a cache hit can still give the old answer
    const file = first.snapshot.reads[EXPLORE.agent]?.file ?? "";
    const info = statSync(file);
    writeFileSync(file, " ".repeat(info.size));
    utimesSync(file, info.atime, info.mtime);
    const again = await open(dir, EXPLORE.session);
    expect((await again.inspector.inspect(again.key)).agents[EXPLORE.agent]).toEqual(before);
  });

  it("an agent whose transcript went away says so instead of failing the rest", async () => {
    const dir = sandbox();
    const { key, snapshot, inspector } = await open(dir, INTERRUPTED.session);
    const [gone, kept] = snapshot.agents;
    unlinkSync(snapshot.reads[gone?.id ?? ""]?.file ?? "");
    const seen = await inspector.inspect(key);
    expect(seen.agents[gone?.id ?? ""]?.gone).toBe(true);
    expect(seen.agents[kept?.id ?? ""]?.toolCount).toBeGreaterThan(0);
  });

  it("a session it does not know, or one with no agents, is an empty answer", async () => {
    const dir = sandbox();
    const { inspector } = await open(dir, EXPLORE.session);
    expect(await inspector.inspect("/nowhere.jsonl")).toEqual({
      key: "/nowhere.jsonl",
      agents: {},
      workflows: {},
    });
  });
});

describe("one agent, step by step", () => {
  it("sends every line of the timeline and nothing a line does not need", async () => {
    const dir = sandbox();
    const { key, snapshot, inspector } = await open(dir, EXPLORE.session);
    const detail = await inspector.detail(key, EXPLORE.agent);
    const file = snapshot.reads[EXPLORE.agent]?.file ?? "";
    const view = timelineView(await readAgentTimeline(file));
    expect(detail?.steps).toHaveLength(view.steps.length);
    expect(detail?.toolCount).toBe(view.toolCount);
    expect(detail?.result).toBe(view.result);
    expect(detail?.prompt).toBe(view.prompt);
    // numbered by where they sit in the fold, which only ever grows
    const ns = detail?.steps.map((s) => s.n) ?? [];
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(ns[0]).toBe(0);
    for (const step of detail?.steps ?? []) {
      expect(step).not.toHaveProperty("input");
      expect(step).not.toHaveProperty("use");
      expect(step).not.toHaveProperty("ref");
      expect(step).not.toHaveProperty("result");
    }
    // the 4MB agent on the machine this came from sends ~50KB. this one is small.
    expect(JSON.stringify(detail).length).toBeLessThan(JSON.stringify(view).length);
  });

  it("opens a step by reading its result back from the transcript", async () => {
    const dir = sandbox();
    const { key, snapshot, inspector } = await open(dir, EXPLORE.session);
    const detail = await inspector.detail(key, EXPLORE.agent);
    const bash = detail?.steps.find((s) => s.kind === "tool" && s.name === "Bash");
    expect(bash?.kind).toBe("tool");
    if (bash?.kind !== "tool") return;
    const opened = await inspector.step(key, EXPLORE.agent, bash.id);
    const file = snapshot.reads[EXPLORE.agent]?.file ?? "";
    const line = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
      .find(
        (b: { type?: string; tool_use_id?: string }) =>
          b.type === "tool_result" && b.tool_use_id === bash.id,
      );
    expect(opened?.result).toBe(resultText(line.content));
    expect(JSON.parse(opened?.input ?? "{}")).toHaveProperty("command");
    // nothing that is not a step of this agent opens
    expect(await inspector.step(key, EXPLORE.agent, "toolu_nope")).toBeNull();
    expect(await inspector.step(key, "a-nobody", bash.id)).toBeNull();
    expect(await inspector.detail(key, "a-nobody")).toBeNull();
    expect(inspector.agentFile(key, "a-nobody")).toBeNull();
    expect(inspector.agentFile(key, EXPLORE.agent)).toBe(file);
  });

  it("a workflow agent's result is what its journal recorded", async () => {
    const dir = sandbox();
    const { key, inspector } = await open(dir, WORKFLOW.session);
    const detail = await inspector.detail(key, WORKFLOW.agent);
    expect(detail?.result).toMatch(/^ran agent step/);
  });

  it("an Agent call links to the agent it started, at any depth", async () => {
    // nothing on the machine the fixtures came from has a nested agent, so this one is made up
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-nested-")));
    const sid = "eeeeeeee-0000-4000-8000-000000000001";
    const key = path.join(dir, `${sid}.jsonl`);
    const sub = path.join(dir, sid, "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(key, "{}\n");
    const line = (o: object) =>
      `${JSON.stringify({ timestamp: "2026-09-23T10:00:00.000Z", ...o })}\n`;
    writeFileSync(
      path.join(sub, "agent-aparent.jsonl"),
      line({ type: "user", message: { role: "user", content: "fan out" } }) +
        line({
          type: "assistant",
          message: {
            id: "m1",
            model: "claude-sonnet-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_child",
                name: "Agent",
                input: { description: "look" },
              },
            ],
          },
        }),
    );
    writeFileSync(
      path.join(sub, "agent-aparent.meta.json"),
      JSON.stringify({ agentType: "long-task", toolUseId: "toolu_top", spawnDepth: 1 }),
    );
    writeFileSync(
      path.join(sub, "agent-achild.jsonl"),
      line({ type: "user", message: { role: "user", content: "look" } }),
    );
    writeFileSync(
      path.join(sub, "agent-achild.meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_child", spawnDepth: 2 }),
    );
    const snapshot = await scanSessionAgents(key, { sessionLive: false });
    const inspector = new AgentInspector({
      stateDir: path.join(dir, "state"),
      snapshot: () => snapshot,
    });
    const detail = await inspector.detail(key, "aparent");
    expect(detail?.steps).toMatchObject([{ kind: "tool", name: "Agent", agentId: "achild" }]);
    expect((await inspector.inspect(key)).agents.achild?.parentId).toBe("aparent");
  });
});
