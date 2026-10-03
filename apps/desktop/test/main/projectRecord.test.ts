import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as record from "@grove/record";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRecordService } from "../../src/main/services/projectRecord.ts";

// the record honours the GROVE_RECORD_SESSION / _AGENT / _PID overrides only with this set
process.env.GROVE_RECORD_TEST = "1";

const tmp = mkdtempSync(path.join(os.tmpdir(), "grove-project-record-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const services: ProjectRecordService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

/** a project folder the way grove's sync leaves it, and a writer acting as one agent session */
function project(name = "chat", prefix = "CHAT") {
  const root = path.join(mkdtempSync(path.join(tmp, "t-")), name);
  mkdirSync(root);
  const made = record.syncProject(root, { prefix, name, goal: "Fix the rounding." });
  if (!made.ok) throw new Error(made.text);
  const env = {
    GROVE_RECORD_TEST: "1",
    GROVE_RECORD_SESSION: "s-1",
    GROVE_RECORD_AGENT: "fixer",
    GROVE_RECORD_PID: String(process.pid),
    GROVE_RECORD_REGISTRY: path.join(tmp, "no-registry"),
  };
  const call = (tool: string, args: Record<string, unknown>) => {
    const r = record.runTool(tool, args, { root, env });
    if (!r.ok) throw new Error(r.text);
    return r;
  };
  return { id: name, root, call };
}

/** the real readers, counted */
function counting() {
  const calls: string[] = [];
  const reader = {
    readRecord: (root: string) => {
      calls.push("record");
      return record.readRecord(root);
    },
    readCard: (root: string, id: string) => {
      calls.push(id);
      return record.readCard(root, id);
    },
    readConclusions: (root: string) => {
      calls.push("conclusions");
      return record.readConclusions(root);
    },
    listCardIds: (root: string) => {
      calls.push("list");
      return record.listCardIds(root);
    },
  };
  return { calls, reader };
}

function start(p: { id: string; root: string }, reader = counting().reader) {
  const changes: Array<{ cards: boolean; conclusions: boolean }> = [];
  const svc = new ProjectRecordService({ reader, onChange: (_id, part) => changes.push(part) });
  services.push(svc);
  svc.setProjects([{ id: p.id, root: p.root }]);
  return { svc, changes };
}

/** the first read happens on a later macrotask */
const firstRead = () => new Promise((r) => setImmediate(r));

describe("ProjectRecordService", () => {
  it("reads a project whole on a later macrotask, then reports both parts", async () => {
    const p = project();
    p.call("card_create", { title: "Fix rounding" });
    p.call("conclusion_record", { kind: "decision", what: "Round half to even.", by: "agent" });
    const { svc, changes } = start(p);
    expect(svc.snapshot(p.id)).toBeUndefined();
    await firstRead();
    const snap = svc.snapshot(p.id);
    expect([...(snap?.cards.keys() ?? [])]).toEqual(["CHAT-1"]);
    expect(snap?.conclusions.map((c) => c.id)).toEqual(["D-1"]);
    expect(snap?.problems).toEqual([]);
    expect(changes).toEqual([{ cards: true, conclusions: true }]);
  });

  it("picks up cards/ made after start, and a card written after that, each within 2s", async () => {
    const p = project();
    const { svc, changes } = start(p);
    await firstRead();
    expect(svc.snapshot(p.id)?.cards.size).toBe(0);

    p.call("card_create", { title: "Fix rounding" });
    await vi.waitFor(() => expect(svc.snapshot(p.id)?.cards.has("CHAT-1")).toBe(true), {
      timeout: 2000,
    });
    p.call("card_create", { title: "Write the release note" });
    await vi.waitFor(() => expect(svc.snapshot(p.id)?.cards.has("CHAT-2")).toBe(true), {
      timeout: 2000,
    });
    p.call("conclusion_record", {
      kind: "finding",
      what: "The bug is in the parser.",
      by: "agent",
    });
    await vi.waitFor(() => expect(svc.snapshot(p.id)?.conclusions).toHaveLength(1), {
      timeout: 2000,
    });
    expect(changes.at(-1)).toEqual({ cards: false, conclusions: true });
  });

  it("re-reads only the card a comment was added to", async () => {
    const p = project();
    p.call("card_create", { title: "Fix rounding" });
    p.call("card_create", { title: "Write the release note" });
    const { calls, reader } = counting();
    const { svc } = start(p, reader);
    await firstRead();
    expect(calls).toEqual(["record"]);
    // FSEvents also reports writes made just before the watch began. wait until those reads stop
    for (let n = -1; n !== calls.length; ) {
      n = calls.length;
      await new Promise((r) => setTimeout(r, 300));
    }
    calls.length = 0;

    p.call("comment_add", { card: "CHAT-2", text: "Draft is in artifacts/notes.md." });
    await vi.waitFor(
      () => expect(svc.snapshot(p.id)?.cards.get("CHAT-2")?.comments).toHaveLength(1),
      { timeout: 2000 },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["CHAT-2"]));
  });

  it("check() finds what no watch event has reported yet, and reads nothing when nothing moved", async () => {
    const p = project();
    p.call("card_create", { title: "Fix rounding" });
    const { calls, reader } = counting();
    const { svc, changes } = start(p, reader);
    await firstRead();
    calls.length = 0;
    changes.length = 0;

    svc.check(p.id);
    expect(calls).toEqual([]);
    expect(changes).toEqual([]);

    // check() is synchronous, so the watch events of these writes cannot have been handled yet
    p.call("question_ask", { card: "CHAT-1", text: "8h or 4h?", to: "person" });
    p.call("card_create", { title: "Write the release note" });
    p.call("conclusion_record", { kind: "decision", what: "Round half to even.", by: "agent" });
    svc.check(p.id);
    const snap = svc.snapshot(p.id);
    expect(snap?.cards.get("CHAT-1")?.asksPerson).toBe(true);
    expect(snap?.cards.has("CHAT-2")).toBe(true);
    expect(snap?.conclusions.map((c) => c.id)).toEqual(["D-1"]);
    expect(new Set(calls)).toEqual(new Set(["CHAT-1", "CHAT-2", "conclusions"]));
    expect(changes).toEqual([{ cards: true, conclusions: true }]);
  });

  it("lists a cut-off file in problems, relative to the root, and still reads the rest", async () => {
    const p = project();
    p.call("card_create", { title: "Fix rounding" });
    p.call("card_create", { title: "Write the release note" });
    const { svc } = start(p);
    await firstRead();

    const file = path.join(p.root, "cards", "CHAT-1", "card.md");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
    svc.check(p.id);
    const snap = svc.snapshot(p.id);
    expect(snap?.problems.map((x) => x.file)).toEqual([path.join("cards", "CHAT-1", "card.md")]);
    expect(snap?.problems[0]?.problems.length).toBeGreaterThan(0);
    expect([...(snap?.cards.keys() ?? [])]).toEqual(["CHAT-1", "CHAT-2"]);
  });

  it("forgets a project that left the list", async () => {
    const p = project();
    const { svc } = start(p);
    await firstRead();
    expect(svc.snapshot(p.id)).toBeDefined();
    svc.setProjects([]);
    expect(svc.snapshot(p.id)).toBeUndefined();
  });
});
