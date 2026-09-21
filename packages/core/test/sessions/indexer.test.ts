import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cacheFileName } from "../../src/sessions/cache.ts";
import { createSessionIndex } from "../../src/sessions/indexer.ts";
import {
  aiTitle,
  assistantEntry,
  customTitle,
  makeSandbox,
  record,
  SID,
  text,
  toJsonl,
  userEntry,
  writeTranscript,
} from "../helpers/transcript.ts";

function setup() {
  const base = makeSandbox("grove-index-");
  const projectsDir = path.join(base, "projects");
  const cacheDir = path.join(base, "cache");
  mkdirSync(projectsDir);
  return { base, projectsDir, cacheDir };
}

describe("SessionIndex", () => {
  it("machinery-only session listed untitled", async () => {
    const { projectsDir, cacheDir } = setup();
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry([text("<ide_opened_file>x</ide_opened_file>")]),
      userEntry("Caveat: nothing typed here"),
      record("mode", { mode: "normal" }),
    ]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    const [row] = index.list();
    expect(index.list()).toHaveLength(1);
    expect(row!.title).toBeUndefined();
    expect(row!.parsed).toBe(true);
    expect(row!.sessionId).toBe(SID.a);
    expect(row!.cwd).toBe("/Users/you/src/api");
  });

  it("a teleported-from stub is still listed, by time and path", async () => {
    const { projectsDir, cacheDir } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.b, [
      { type: "teleported-from", remoteSessionId: "session_01", branch: "main", messageCount: 0 },
    ]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    const [row] = index.list();
    expect(row).toMatchObject({
      path: file,
      sessionId: SID.b,
      projectDirName: "-Users-you-src-api",
    });
    expect(row!.title).toBeUndefined();
    expect(row!.stub).toBe(true);
    expect(row!.activityMs).toBe(row!.mtimeMs);
  });

  it("a file that is not JSONL at all is listed and nothing throws", async () => {
    const { projectsDir, cacheDir } = setup();
    const dir = path.join(projectsDir, "-Users-you-src-api");
    mkdirSync(dir);
    writeFileSync(path.join(dir, `${SID.c}.jsonl`), Buffer.from([0, 1, 2, 3, 255, 254, 10, 10]));
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    expect(index.list()).toHaveLength(1);
    expect(index.health()).toBe("degraded");
  });

  it("cache hit on the second run, miss after the file changes", async () => {
    const { projectsDir, cacheDir } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("one"),
      aiTitle("First"),
    ]);
    writeTranscript(projectsDir, "/Users/you/src/web", SID.b, [userEntry("two")]);

    const first = createSessionIndex({ projectsDir, cacheDir });
    await first.load();
    expect(await first.refresh()).toMatchObject({ files: 2, cacheHits: 0, parsed: 2 });
    expect(readdirSync(cacheDir)).toEqual([cacheFileName()]);

    const second = createSessionIndex({ projectsDir, cacheDir });
    await second.load();
    expect(await second.refresh()).toMatchObject({ files: 2, cacheHits: 2, parsed: 0 });
    expect(second.list().find((r) => r.path === file)!.title).toBe("First");

    appendFileSync(file, toJsonl([aiTitle("Renamed")]));
    const third = createSessionIndex({ projectsDir, cacheDir });
    await third.load();
    expect(await third.refresh()).toMatchObject({ cacheHits: 1, parsed: 1 });
    expect(third.list().find((r) => r.path === file)!.title).toBe("Renamed");
  });

  it("a rename that only touches the custom-title sidecar is a cache miss", async () => {
    const { projectsDir, cacheDir } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("one")]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    expect(index.list()[0]!.title).toBe("one");

    const sidecarDir = path.join(path.dirname(file), SID.a);
    mkdirSync(sidecarDir);
    writeFileSync(
      path.join(sidecarDir, "custom-title.json"),
      JSON.stringify({ customTitle: "export api project" }),
    );
    expect(await index.refresh()).toMatchObject({ cacheHits: 0, parsed: 1 });
    expect(index.list()[0]).toMatchObject({
      title: "export api project",
      titleSource: "customTitle",
    });
  });

  it("the parse cap lists the remainder unparsed, newest files get the budget", async () => {
    const { projectsDir, cacheDir } = setup();
    const ids = [SID.a, SID.b, SID.c, SID.d];
    ids.forEach((id, i) => {
      const file = writeTranscript(projectsDir, "/Users/you/src/api", id, [
        userEntry(`prompt ${i}`),
      ]);
      const t = new Date(Date.parse("2026-09-10T00:00:00Z") + i * 60_000);
      utimesSync(file, t, t);
    });
    const index = createSessionIndex({ projectsDir, cacheDir, maxParsed: 2 });
    expect(await index.refresh()).toMatchObject({ files: 4, parsed: 2, unparsed: 2 });
    const rows = index.list();
    expect(rows).toHaveLength(4);
    expect(
      rows
        .filter((r) => r.parsed)
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual([SID.c, SID.d].sort());
  });

  it("refreshFile: a metadata-only append is not a change, a new turn is", async () => {
    const { projectsDir, cacheDir } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("one", { timestamp: "2026-09-01T10:00:00.000Z" }),
      aiTitle("Title"),
    ]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();

    appendFileSync(file, toJsonl([record("mode", { mode: "normal" }), aiTitle("Title")]));
    expect((await index.refreshFile(file)).changed).toBe(false);

    appendFileSync(
      file,
      toJsonl([assistantEntry("reply", { timestamp: "2026-09-05T10:00:00.000Z" })]),
    );
    const r = await index.refreshFile(file);
    expect(r.changed).toBe(true);
    expect(r.record!.activityMs).toBe(Date.parse("2026-09-05T10:00:00.000Z"));
  });

  it("refreshFile picks up a brand-new transcript and a deletion", async () => {
    const { projectsDir, cacheDir } = setup();
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    const file = writeTranscript(projectsDir, "/Users/you/ws/prod-debug", SID.a, [
      userEntry("new session"),
    ]);
    expect((await index.refreshFile(file)).changed).toBe(true);
    expect(index.list()).toHaveLength(1);
    unlinkSync(file);
    expect((await index.refreshFile(file)).changed).toBe(true);
    expect(index.list()).toHaveLength(0);
  });

  it("sessions that expire on disk leave the listing and the cache", async () => {
    const { projectsDir, cacheDir } = setup();
    const file = writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("one")]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    unlinkSync(file);
    expect(await index.refresh()).toMatchObject({ files: 0, removed: 1 });
    expect(readFileSync(path.join(cacheDir, cacheFileName()), "utf8")).not.toContain(SID.a);
  });

  it("sorted by last activity, not by mtime", async () => {
    const { projectsDir, cacheDir } = setup();
    // touched today by a late metadata append, but last used two weeks ago
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [
      userEntry("old conversation", { timestamp: "2026-08-20T10:00:00.000Z" }),
      customTitle("old"),
    ]);
    const recent = writeTranscript(projectsDir, "/Users/you/src/web", SID.b, [
      userEntry("recent conversation", { timestamp: "2026-09-19T10:00:00.000Z" }),
    ]);
    const past = new Date("2026-09-19T10:00:05.000Z");
    utimesSync(recent, past, past);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.refresh();
    expect(index.list().map((r) => r.sessionId)).toEqual([SID.b, SID.a]);
    expect(index.list()[1]!.mtimeMs).toBeGreaterThan(index.list()[0]!.mtimeMs);
  });

  it("two indexes saving at once always leave valid JSON", async () => {
    const { projectsDir, cacheDir } = setup();
    for (const [i, id] of [SID.a, SID.b, SID.c].entries()) {
      writeTranscript(projectsDir, `/Users/you/src/r${i}`, id, [userEntry(`p${i}`)]);
    }
    const a = createSessionIndex({ projectsDir, cacheDir });
    const b = createSessionIndex({ projectsDir, cacheDir });
    await Promise.all([a.refresh(), b.refresh(), a.refresh(), b.refresh()]);
    const parsed = JSON.parse(readFileSync(path.join(cacheDir, cacheFileName()), "utf8"));
    expect(Object.keys(parsed.entries)).toHaveLength(3);
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("persist 'if-cold' only writes after a big parse, 'never' never writes", async () => {
    const { projectsDir, cacheDir } = setup();
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("one")]);
    await createSessionIndex({ projectsDir, cacheDir, persist: "if-cold" }).refresh();
    await createSessionIndex({ projectsDir, cacheDir, persist: "never" }).refresh();
    expect(() => readdirSync(cacheDir)).toThrow();
  });

  it("old cache versions are swept, a cache for another projects dir is ignored", async () => {
    const { projectsDir, cacheDir } = setup();
    mkdirSync(cacheDir);
    writeFileSync(path.join(cacheDir, "session-index.v0.json"), "{}");
    writeFileSync(path.join(cacheDir, "session-index.json"), "{}");
    writeFileSync(
      path.join(cacheDir, cacheFileName()),
      JSON.stringify({
        projectsDir: "/somewhere/else",
        entries: { "/x.jsonl": { key: "1:1:0", meta: { recognized: 1 } } },
      }),
    );
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("one")]);
    const index = createSessionIndex({ projectsDir, cacheDir });
    await index.load();
    expect(await index.refresh()).toMatchObject({ cacheHits: 0, parsed: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(cacheDir)).toEqual([cacheFileName()]);
  });

  it("onBatch gets the stat-only listing first, then the parsed rows", async () => {
    const { projectsDir, cacheDir } = setup();
    writeTranscript(projectsDir, "/Users/you/src/api", SID.a, [userEntry("one")]);
    const batches: boolean[][] = [];
    await createSessionIndex({ projectsDir, cacheDir }).refresh({
      onBatch: (rows) => batches.push(rows.map((r) => r.parsed)),
    });
    expect(batches).toEqual([[false], [true]]);
  });
});
