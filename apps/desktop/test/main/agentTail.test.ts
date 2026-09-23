import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentTimeline, scanSessionAgents } from "@grove/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentPrompt,
  agentResult,
  agentSays,
  call,
  jsonl,
  text,
} from "../../../../packages/core/test/helpers/agentTranscript.ts";
import { AgentInspector, findStep, firstChange } from "../../src/main/services/agentInspector.ts";
import type { AgentSteps } from "../../src/shared/ipc.ts";

const ID = "atail";
const inspectors: AgentInspector[] = [];
afterEach(() => {
  for (const i of inspectors.splice(0)) i.dispose();
});

/** a session with one agent that is still writing */
async function running() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-tail-")));
  const sid = "cccccccc-0000-4000-8000-000000000001";
  const key = path.join(dir, `${sid}.jsonl`);
  const sub = path.join(dir, sid, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(key, "{}\n");
  writeFileSync(path.join(sub, `agent-${ID}.meta.json`), JSON.stringify({ agentType: "Explore" }));
  const file = path.join(sub, `agent-${ID}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      agentPrompt(ID, "Find the writers."),
      agentSays(ID, "m1", call("t1", "Read", { file_path: "/work/api/a.ts" }), 1),
      agentResult(ID, "t1", "export const a = 1", 2),
    ]),
  );
  const snapshot = await scanSessionAgents(key, { sessionLive: true });
  const pushes: AgentSteps[] = [];
  const inspector = new AgentInspector({
    stateDir: path.join(dir, "state"),
    snapshot: () => snapshot,
    onSteps: (p) => pushes.push(p),
    tailMs: 20,
  });
  inspectors.push(inspector);
  return { key, file, inspector, pushes };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe("tailing the agent on screen", () => {
  it("the news starts at the first step that is not the same object", () => {
    const a = { n: 1 };
    const b = { n: 2 };
    expect(firstChange([a, b], [a, b, { n: 3 }], [])).toBe(2);
    expect(firstChange([a, b], [a, { n: 2 }], [])).toBe(1);
    // a text that stopped being the result changes what shows without changing the step
    expect(firstChange([a, b], [a, b], [1])).toBe(1);
    expect(firstChange([], [a], [])).toBe(0);
  });

  it("a search lands on the step that holds the most of it, never on the result", async () => {
    const { file } = await running();
    appendFileSync(
      file,
      jsonl([
        agentSays(ID, "m2", text("Checking the lease renewal next."), 3),
        agentSays(ID, "m3", call("t2", "Grep", { pattern: "lease", path: "/work/api" }), 4),
        agentResult(ID, "t2", "x", 5),
        agentSays(ID, "m4", text("The lease is renewed only on success."), 6),
      ]),
    );
    const state = await readAgentTimeline(file);
    // "lease renewal" is all there in the prose, only half in the Grep. the final words are the result.
    expect(findStep(state, ["lease", "renewal"])).toBe(1);
    expect(findStep(state, ["success"])).toBeUndefined();
    expect(findStep(state, [])).toBeUndefined();
  });

  it("sends what the agent appends, from the first step it changed", async () => {
    const { key, file, inspector, pushes } = await running();
    const started = await inspector.follow(key, ID);
    expect(started?.detail.steps).toMatchObject([{ kind: "tool", name: "Read", n: 0 }]);
    expect(started?.detail.steps[0]).toHaveProperty("durationMs");

    // a call starts: one new step, nothing before it sent again
    appendFileSync(
      file,
      jsonl([agentSays(ID, "m2", call("t2", "Bash", { command: "pnpm test" }), 3)]),
    );
    await until(() => pushes.length === 1);
    expect(pushes[0]).toMatchObject({ key, id: ID, gen: started?.gen, from: 1 });
    expect(pushes[0]?.steps).toMatchObject([{ kind: "tool", name: "Bash", n: 1 }]);
    expect(pushes[0]?.steps[0]).not.toHaveProperty("durationMs");
    expect(pushes[0]?.head.toolCount).toBe(2);

    // it comes back: the same step again, now with how long it took, and the agent says a word
    appendFileSync(
      file,
      jsonl([agentResult(ID, "t2", "ok", 9), agentSays(ID, "m3", text("All green. Done."), 10)]),
    );
    await until(() => pushes.length === 2);
    expect(pushes[1]?.from).toBe(1);
    expect(pushes[1]?.steps.map((s) => s.kind)).toEqual(["tool"]);
    expect(pushes[1]?.steps[0]).toMatchObject({ n: 1, durationMs: 6000 });
    // a final message with no call in it is the result, not a step
    expect(pushes[1]?.head.result).toBe("All green. Done.");

    // it carries on after all: the words are a step again, and the view says so
    appendFileSync(
      file,
      jsonl([agentSays(ID, "m3", call("t3", "Read", { file_path: "/work/api/b.ts" }), 11)]),
    );
    await until(() => pushes.length === 3);
    expect(pushes[2]?.from).toBe(2);
    expect(pushes[2]?.steps.map((s) => s.kind)).toEqual(["text", "tool"]);
    expect(pushes[2]?.head.result).toBeUndefined();
  });

  it("only the agent on screen is watched, and nothing once it is gone from it", async () => {
    const { key, file, inspector, pushes } = await running();
    const first = await inspector.follow(key, ID);
    const second = await inspector.follow(key, ID);
    expect(second?.gen).toBeGreaterThan(first?.gen ?? 0);
    appendFileSync(file, jsonl([agentSays(ID, "m2", call("t2", "Bash", { command: "ls" }), 3)]));
    await until(() => pushes.length === 1);
    expect(pushes.every((p) => p.gen === second?.gen)).toBe(true);

    expect(await inspector.follow(key, null)).toBeNull();
    appendFileSync(file, jsonl([agentResult(ID, "t2", "a b", 4)]));
    await new Promise((r) => setTimeout(r, 120));
    expect(pushes).toHaveLength(1);
    expect(await inspector.follow(key, "a-nobody")).toBeNull();
  });
});
