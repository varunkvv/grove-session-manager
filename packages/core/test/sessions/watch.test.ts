import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyWatchPath, watchProjects } from "../../src/sessions/watch.ts";
import { makeSandbox, SID, userEntry, writeTranscript } from "../helpers/transcript.ts";

describe("classifyWatchPath", () => {
  it("only depth-2 transcripts and their title sidecar count", () => {
    expect(classifyWatchPath(`-ws-prod/${SID.a}.jsonl`)).toEqual({
      kind: "transcript",
      rel: `-ws-prod/${SID.a}.jsonl`,
    });
    expect(classifyWatchPath(`-ws-prod/${SID.a}/custom-title.json`)).toEqual({
      kind: "transcript",
      rel: `-ws-prod/${SID.a}.jsonl`,
    });
    expect(classifyWatchPath("-ws-prod")).toEqual({ kind: "dir" });
    expect(classifyWatchPath(`-ws-prod/${SID.a}/tool-results/x.txt`)).toBeNull();
    expect(classifyWatchPath("-ws-prod/memory/MEMORY.md")).toBeNull();
    expect(classifyWatchPath(`-ws-prod/${SID.a}.orphaned-1-x.jsonl`)).toBeNull();
  });

  it("a subagent file points back at its session and never makes one of its own", () => {
    const owner = `-ws-prod/${SID.a}.jsonl`;
    expect(classifyWatchPath(`-ws-prod/${SID.a}/subagents/agent-1.jsonl`)).toEqual({
      kind: "subagent",
      rel: owner,
    });
    expect(classifyWatchPath(`-ws-prod/${SID.a}/subagents/agent-1.meta.json`)).toEqual({
      kind: "subagent",
      rel: owner,
    });
    // workflows nest one level further, and their journal comes back the same way
    expect(classifyWatchPath(`-ws-prod/${SID.a}/subagents/workflows/wf_a1/agent-2.jsonl`)).toEqual({
      kind: "subagent",
      rel: owner,
    });
    expect(classifyWatchPath(`-ws-prod/${SID.a}/subagents`)).toBeNull();
  });
});

describe("watchProjects", () => {
  it("a new session in a brand-new project dir fires within a second. depth-3 churn is silent", async () => {
    const projects = makeSandbox("grove-watch-");
    const seen: string[] = [];
    const w = watchProjects(
      projects,
      { onTranscript: (f) => seen.push(f), onRescan: () => {} },
      { firstDelayMs: 50, minIntervalMs: 200 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const file = writeTranscript(projects, "/Users/you/ws/brand-new", SID.a, [
      userEntry("first message"),
    ]);
    const noise = path.join(path.dirname(file), SID.a, "subagents");
    mkdirSync(noise, { recursive: true });
    writeFileSync(path.join(noise, "agent-1.jsonl"), "{}\n");

    await new Promise((r) => setTimeout(r, 900));
    expect(seen).toEqual([file]);

    // an active session appends constantly: throttled, not starved
    for (let i = 0; i < 5; i++) {
      appendFileSync(file, "{}\n");
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(new Set(seen)).toEqual(new Set([file]));
    w.dispose();
  });

  it("subagent churn reaches its own handler, throttled, and never the transcript one", async () => {
    const projects = makeSandbox("grove-watch-");
    const transcripts: string[] = [];
    const subagents: string[] = [];
    const w = watchProjects(
      projects,
      {
        onTranscript: (f) => transcripts.push(f),
        onSubagents: (f) => subagents.push(f),
        onRescan: () => {},
      },
      { firstDelayMs: 50, minIntervalMs: 200 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const file = writeTranscript(projects, "/Users/you/ws/fan-out", SID.a, [userEntry("go")]);
    const dir = path.join(path.dirname(file), SID.a, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "agent-1.meta.json"), '{"agentType":"Explore"}\n');
    await new Promise((r) => setTimeout(r, 400));
    // the transcript and its subagents are throttled apart, so neither starves the other
    for (let i = 0; i < 5; i++) {
      appendFileSync(path.join(dir, "agent-1.jsonl"), "{}\n");
      appendFileSync(file, "{}\n");
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(new Set(subagents)).toEqual(new Set([file]));
    expect(subagents.length).toBeGreaterThanOrEqual(1);
    expect(subagents.length).toBeLessThanOrEqual(4);
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    w.dispose();
  });

  it("a missing projects dir does not throw and is never created", async () => {
    const missing = path.join(makeSandbox("grove-watch-"), "projects");
    const w = watchProjects(missing, { onTranscript: () => {}, onRescan: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    w.dispose();
    expect(() => appendFileSync(path.join(missing, "x"), "")).toThrow();
  });
});
