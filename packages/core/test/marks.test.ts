import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarks, setMarks } from "../src/marks.ts";
import { makeSandbox } from "./helpers/transcript.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

/** the reviewed file, in a fresh folder */
const fileIn = (root: string) => path.join(root, "reviewed.json");
const read = (root: string) => readFileSync(fileIn(root), "utf8");

describe("the marks file", () => {
  it("writes, reads back, and unmarking removes the entry rather than flagging it", async () => {
    const root = makeSandbox("grove-marks-");
    expect(await loadMarks(fileIn(root))).toMatchObject({ status: "missing", keys: new Set() });

    expect(await setMarks(fileIn(root), [A, B], true, 1_700_000_000_000)).toMatchObject({
      ok: true,
    });
    expect((await loadMarks(fileIn(root))).keys).toEqual(new Set([A, B]));
    expect(JSON.parse(read(root))).toEqual({
      [A]: { at: 1_700_000_000_000 },
      [B]: { at: 1_700_000_000_000 },
    });

    // marking something already marked keeps the original `at`
    await setMarks(fileIn(root), [A], true, 1_800_000_000_000);
    expect(JSON.parse(read(root))[A]).toEqual({ at: 1_700_000_000_000 });

    expect(await setMarks(fileIn(root), [A], false)).toMatchObject({ ok: true });
    expect(JSON.parse(read(root))).toEqual({ [B]: { at: 1_700_000_000_000 } });
    expect((await loadMarks(fileIn(root))).keys).toEqual(new Set([B]));
  });

  it("keeps what it does not understand, and the file's own indentation", async () => {
    const root = makeSandbox("grove-marks-");
    writeFileSync(
      fileIn(root),
      `{\n    "${A}": { "at": 1, "why": "noisy cron run" },\n    "hand-written-nonsense": 12,\n    "${B}": true\n}\n`,
    );
    // an object entry and a bare `true` both read as marked. a number is neither.
    expect((await loadMarks(fileIn(root))).keys).toEqual(new Set([A, B]));

    await setMarks(fileIn(root), ["cccccccc-0000-4000-8000-000000000003"], true, 5);
    const after = JSON.parse(read(root));
    expect(after[A]).toEqual({ at: 1, why: "noisy cron run" });
    expect(after["hand-written-nonsense"]).toBe(12);
    expect(after[B]).toBe(true);
    expect(read(root)).toContain(`\n    "${A}"`);
    expect(read(root).endsWith("\n")).toBe(true);
  });

  it("a file that is not JSON, or not an object, is read as empty and never overwritten", async () => {
    const root = makeSandbox("grove-marks-");
    writeFileSync(fileIn(root), "{ half written");
    expect(await loadMarks(fileIn(root))).toMatchObject({ status: "invalid", keys: new Set() });
    expect(await setMarks(fileIn(root), [A], true)).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(read(root)).toBe("{ half written");

    writeFileSync(fileIn(root), `["${A}"]`);
    expect(await loadMarks(fileIn(root))).toMatchObject({
      status: "unexpected-shape",
      keys: new Set(),
    });
    expect(await setMarks(fileIn(root), [A], true)).toMatchObject({
      ok: false,
      error: { code: "unexpected-shape" },
    });
    expect(read(root)).toBe(`["${A}"]`);
  });
});
