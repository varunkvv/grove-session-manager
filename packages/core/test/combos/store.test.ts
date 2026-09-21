import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { combosFilePath, loadCombos, updateCombos } from "../../src/combos/store.ts";
import { makeSandbox } from "../helpers/transcript.ts";

describe("combos.json store", () => {
  it("a missing file is an empty list, and loading never creates it", async () => {
    const app = makeSandbox("grove-store-");
    expect(await loadCombos(app)).toMatchObject({ status: "missing", combos: [] });
    expect(() => readFileSync(combosFilePath(app))).toThrow();
  });

  it("update keeps unknown keys, broken entries and the file's indentation", async () => {
    const app = makeSandbox("grove-store-");
    const original = `{
\t"$comment": "hand edited",
\t"combos": [
\t\t{ "name": "keep", "colour": "teal", "folders": ["/Users/you/src/api"] },
\t\t{ "name": "broken", "folders": [{ "mode": "worktree" }] }
\t]
}
`;
    writeFileSync(combosFilePath(app), original);
    const res = await updateCombos(app, (combos) => [
      ...combos,
      { name: "added", root: `${app}/added`, folders: [] },
    ]);
    expect(res.ok).toBe(true);

    const text = readFileSync(combosFilePath(app), "utf8");
    expect(text).toContain('\n\t"$comment": "hand edited"');
    expect(text.endsWith("\n")).toBe(true);
    const saved = JSON.parse(text);
    expect(saved.combos.map((c: { name: string }) => c.name)).toEqual(["keep", "added", "broken"]);
    expect(saved.combos[0].colour).toBe("teal");
    expect(saved.combos[2]).toEqual({ name: "broken", folders: [{ mode: "worktree" }] });

    const loaded = await loadCombos(app);
    expect(loaded.combos.map((c) => c.name)).toEqual(["keep", "added"]);
    expect(loaded.problems).toHaveLength(1);
  });

  it("an unparseable file is reported and never overwritten", async () => {
    const app = makeSandbox("grove-store-");
    writeFileSync(combosFilePath(app), '{ "combos": [ oops');
    expect((await loadCombos(app)).status).toBe("invalid");
    const res = await updateCombos(app, () => []);
    expect(res.ok).toBe(false);
    expect(readFileSync(combosFilePath(app), "utf8")).toBe('{ "combos": [ oops');
  });
});
