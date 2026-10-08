import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMarks, renameMarkPrefixes, setMarks } from "../src/marks.ts";
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

describe("marks filed under something that went away", () => {
  const RENAMES = new Map([
    ["AUTH", "auth-sso"],
    ["BILL", "billing-export"],
  ]);
  // as 0.10 wrote them: under each project's card prefix
  const OLD = {
    "AUTH/stopped:s1@1700000000000": { at: 1 },
    "AUTH/conclusion:D-4": { at: 2, note: "mine" },
    "OPS/stopped:s2@failed": { at: 3 },
    "BILL/stopped:s3@1700000000001": true,
    loose: { at: 5 },
  };

  it("move to the new name with their entries, their order and the file's indentation", async () => {
    const root = makeSandbox("grove-marks-");
    writeFileSync(fileIn(root), JSON.stringify(OLD, null, 4));
    expect(await renameMarkPrefixes(fileIn(root), RENAMES)).toBe(3);
    // marks written the 0.10 way are still marks, with the day they were made
    expect(read(root)).toBe(
      JSON.stringify(
        {
          "auth-sso/stopped:s1@1700000000000": { at: 1 },
          "auth-sso/conclusion:D-4": { at: 2, note: "mine" },
          "OPS/stopped:s2@failed": { at: 3 },
          "billing-export/stopped:s3@1700000000001": true,
          loose: { at: 5 },
        },
        null,
        4,
      ),
    );
    expect((await loadMarks(fileIn(root))).keys).toContain("auth-sso/stopped:s1@1700000000000");

    // a second run finds nothing to move, and does not write
    const written = statSync(fileIn(root)).mtimeMs;
    expect(await renameMarkPrefixes(fileIn(root), RENAMES)).toBe(0);
    expect(statSync(fileIn(root)).mtimeMs).toBe(written);
  });

  it("a key already under the new name wins, and a file that cannot be read is left as it is", async () => {
    const root = makeSandbox("grove-marks-");
    writeFileSync(
      fileIn(root),
      JSON.stringify({ "AUTH/stopped:s1@1": { at: 1 }, "auth-sso/stopped:s1@1": { at: 9 } }),
    );
    expect(await renameMarkPrefixes(fileIn(root), RENAMES)).toBe(1);
    expect(JSON.parse(read(root))).toEqual({ "auth-sso/stopped:s1@1": { at: 9 } });

    writeFileSync(fileIn(root), "{ not json");
    expect(await renameMarkPrefixes(fileIn(root), RENAMES)).toBe(0);
    expect(read(root)).toBe("{ not json");
    expect(await renameMarkPrefixes(fileIn(makeSandbox("grove-marks-")), RENAMES)).toBe(0);
  });
});
