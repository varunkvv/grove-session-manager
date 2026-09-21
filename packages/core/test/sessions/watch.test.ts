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
    expect(classifyWatchPath(`-ws-prod/${SID.a}/subagents/agent-1.jsonl`)).toBeNull();
    expect(classifyWatchPath(`-ws-prod/${SID.a}/tool-results/x.txt`)).toBeNull();
    expect(classifyWatchPath("-ws-prod/memory/MEMORY.md")).toBeNull();
    expect(classifyWatchPath(`-ws-prod/${SID.a}.orphaned-1-x.jsonl`)).toBeNull();
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

  it("a missing projects dir does not throw and is never created", async () => {
    const missing = path.join(makeSandbox("grove-watch-"), "projects");
    const w = watchProjects(missing, { onTranscript: () => {}, onRescan: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    w.dispose();
    expect(() => appendFileSync(path.join(missing, "x"), "")).toThrow();
  });
});
