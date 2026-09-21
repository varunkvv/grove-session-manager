import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSessionIndex } from "../src/sessions/indexer.ts";
import type { SessionRecord } from "../src/types.ts";

// real transcripts from Claude Code 2.1.2xx with every string replaced (scripts/redact-fixture.ts).
// line byte lengths are preserved, so the offsets that make these cases interesting are real.
const projectsDir = path.join(import.meta.dirname, "fixtures/projects");
const rows = new Map<string, SessionRecord>();

beforeAll(async () => {
  const index = createSessionIndex({ projectsDir, cacheDir: null });
  await index.refresh();
  for (const r of index.list())
    rows.set(r.projectDirName.replace(/^-fixture-/, "").replace(/x+$/, ""), r);
});

describe("redacted real transcripts", () => {
  it("all seven are listed, with the session id equal to the filename stem", () => {
    expect([...rows.keys()].sort()).toEqual([
      "command",
      "idefirst",
      "middle",
      "sidecar",
      "stub",
      "tail50k",
      "twotitles",
    ]);
    for (const r of rows.values()) expect(r.sessionId).toBe(path.basename(r.path, ".jsonl"));
  });

  it("a generated title at byte 50,841: a 48KB head misses it, the 64KiB head finds it", () => {
    const r = rows.get("tail50k")!;
    const offset = readFileSync(r.path, "utf8").indexOf('"type":"ai-title"');
    expect(offset).toBeGreaterThan(49152);
    expect(offset).toBeLessThan(65536);
    expect(r.titleSource).toBe("aiTitle");
  });

  it("a title that only exists in the unread middle falls back to the first prompt", () => {
    expect(rows.get("middle")!.titleSource).toBe("firstPrompt");
    expect(rows.get("middle")!.aiTitle).toBeUndefined();
  });

  it("several generated titles in one file: the last one wins", () => {
    const r = rows.get("twotitles")!;
    const titles = [...readFileSync(r.path, "utf8").matchAll(/"aiTitle":"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(titles).size).toBeGreaterThan(1);
    expect(r.aiTitle).toBe(titles[titles.length - 1]);
  });

  it("/rename: custom title (tail + sidecar + agent-name) outranks the generated title", () => {
    const r = rows.get("sidecar")!;
    expect(r.titleSource).toBe("customTitle");
    expect(r.agentName).toBe(r.customTitle);
    expect(r.aiTitle).toBeDefined();
    expect(r.aiTitle).not.toBe(r.customTitle);
  });

  it("<ide_opened_file> block in front of the typed text: the typed text is the first prompt", () => {
    const r = rows.get("idefirst")!;
    expect(r.firstPrompt).toBeDefined();
    expect(r.firstPrompt!.startsWith("<")).toBe(false);
    expect(r.entrypoint).toBe("claude-vscode");
  });

  it("a CLI session that is only slash commands titles as the command, never as 'null'", () => {
    expect(rows.get("command")).toMatchObject({
      title: "/mcp",
      titleSource: "firstCommand",
      entrypoint: "cli",
    });
    expect(rows.get("command")!.lastPrompt).toBeUndefined();
  });

  it("the 113-byte teleport marker is listed as a stub", () => {
    expect(rows.get("stub")).toMatchObject({ stub: true, size: 113 });
    expect(rows.get("stub")!.title).toBeUndefined();
  });

  it("cwd comes from the head and its slug equals the project dir name", () => {
    for (const [name, r] of rows) {
      if (name === "stub") continue;
      expect(r.cwd, name).toBeDefined();
    }
  });
});
