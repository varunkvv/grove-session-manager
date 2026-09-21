import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTranscriptFile, scanProjects } from "../../src/sessions/scan.ts";
import { makeSandbox, SID, userEntry, writeTranscript } from "../helpers/transcript.ts";

describe("scanProjects", () => {
  it("zero-byte file skipped", async () => {
    const projects = makeSandbox("grove-scan-");
    writeTranscript(projects, "/Users/you/src/api", SID.a, [userEntry("hi")]);
    writeFileSync(path.join(projects, "-Users-you-src-api", `${SID.b}.jsonl`), "");
    const stats = await scanProjects(projects);
    expect(stats.map((s) => s.stem)).toEqual([SID.a]);
  });

  it("orphaned, superseded, memory and sidecar content are never listed", async () => {
    const projects = makeSandbox("grove-scan-");
    const file = writeTranscript(projects, "/Users/you/src/api", SID.a, [userEntry("hi")]);
    const dir = path.dirname(file);
    writeFileSync(path.join(dir, `${SID.a}.orphaned-1790000000-ab12.jsonl`), '{"type":"user"}\n');
    writeFileSync(path.join(dir, `${SID.a}.jsonl.superseded-1790000000`), '{"type":"user"}\n');
    mkdirSync(path.join(dir, "memory"));
    writeFileSync(path.join(dir, "memory", "MEMORY.md"), "- x\n");
    mkdirSync(path.join(dir, SID.a, "subagents"), { recursive: true });
    writeFileSync(path.join(dir, SID.a, "subagents", "agent-abc.jsonl"), '{"isSidechain":true}\n');
    writeFileSync(path.join(dir, SID.a, "custom-title.json"), '{"customTitle":"named"}');
    mkdirSync(path.join(projects, "-Users-you-memory-only", "memory"), { recursive: true });

    const stats = await scanProjects(projects);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.sidecarMtimeMs).toBeGreaterThan(0);
    expect(stats[0]!.projectDirName).toBe("-Users-you-src-api");
  });

  it("a missing projects dir is an empty listing, not an error", async () => {
    expect(await scanProjects(path.join(makeSandbox(), "nope"))).toEqual([]);
  });

  it("isTranscriptFile", () => {
    expect(isTranscriptFile(`${SID.a}.jsonl`)).toBe(true);
    expect(isTranscriptFile(`${SID.a}.orphaned-1-x.jsonl`)).toBe(false);
    expect(isTranscriptFile(`${SID.a}.jsonl.superseded-1`)).toBe(false);
    expect(isTranscriptFile("journal.json")).toBe(false);
    expect(isTranscriptFile(".jsonl")).toBe(false);
  });
});
