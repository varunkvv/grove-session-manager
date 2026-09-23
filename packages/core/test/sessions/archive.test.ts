import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archivedFilePath, loadArchived, setArchived } from "../../src/sessions/archive.ts";
import { makeSandbox } from "../helpers/transcript.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

const read = (root: string) => readFileSync(archivedFilePath(root), "utf8");

describe("the archive file", () => {
  it("writes, reads back, and unarchiving removes the entry rather than flagging it", async () => {
    const root = makeSandbox("grove-archive-");
    expect(await loadArchived(root)).toMatchObject({ status: "missing", ids: new Set() });

    expect(await setArchived(root, [A, B], true, 1_700_000_000_000)).toMatchObject({ ok: true });
    expect((await loadArchived(root)).ids).toEqual(new Set([A, B]));
    expect(JSON.parse(read(root))).toEqual({
      [A]: { at: 1_700_000_000_000 },
      [B]: { at: 1_700_000_000_000 },
    });

    // archiving something already archived keeps the original `at`
    await setArchived(root, [A], true, 1_800_000_000_000);
    expect(JSON.parse(read(root))[A]).toEqual({ at: 1_700_000_000_000 });

    expect(await setArchived(root, [A], false)).toMatchObject({ ok: true });
    expect(JSON.parse(read(root))).toEqual({ [B]: { at: 1_700_000_000_000 } });
    expect((await loadArchived(root)).ids).toEqual(new Set([B]));
  });

  it("keeps what it does not understand, and the file's own indentation", async () => {
    const root = makeSandbox("grove-archive-");
    writeFileSync(
      archivedFilePath(root),
      `{\n    "${A}": { "at": 1, "why": "noisy cron run" },\n    "hand-written-nonsense": 12,\n    "${B}": true\n}\n`,
    );
    // an object entry and a bare `true` both read as archived. a number is neither.
    expect((await loadArchived(root)).ids).toEqual(new Set([A, B]));

    await setArchived(root, ["cccccccc-0000-4000-8000-000000000003"], true, 5);
    const after = JSON.parse(read(root));
    expect(after[A]).toEqual({ at: 1, why: "noisy cron run" });
    expect(after["hand-written-nonsense"]).toBe(12);
    expect(after[B]).toBe(true);
    expect(read(root)).toContain(`\n    "${A}"`);
    expect(read(root).endsWith("\n")).toBe(true);
  });

  it("a file that is not JSON, or not an object, is read as empty and never overwritten", async () => {
    const root = makeSandbox("grove-archive-");
    writeFileSync(archivedFilePath(root), "{ half written");
    expect(await loadArchived(root)).toMatchObject({ status: "invalid", ids: new Set() });
    expect(await setArchived(root, [A], true)).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(read(root)).toBe("{ half written");

    writeFileSync(archivedFilePath(root), `["${A}"]`);
    expect(await loadArchived(root)).toMatchObject({ status: "unexpected-shape", ids: new Set() });
    expect(await setArchived(root, [A], true)).toMatchObject({
      ok: false,
      error: { code: "unexpected-shape" },
    });
    expect(read(root)).toBe(`["${A}"]`);
  });

  it("lives beside combos.json, not in the cache dir", () => {
    expect(archivedFilePath("/tmp/ws")).toBe(path.join("/tmp/ws", "archived.json"));
  });
});
