import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsLocalPath, syncAdditionalDirectories } from "../../src/combos/settingsSync.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

function setup(refs: string[] = ["/Users/you/src/logs"]) {
  const base = makeSandbox("grove-sync-");
  const combo: Combo = {
    name: "prod-debug",
    root: path.join(base, "prod-debug"),
    folders: [
      { path: "/Users/you/src/api", mode: "worktree", branch: { kind: "detach" } },
      ...refs.map((p) => ({ path: p, mode: "reference" as const })),
    ],
  };
  mkdirSync(combo.root, { recursive: true });
  return { combo, stateDir: path.join(base, "state"), file: settingsLocalPath(combo) };
}

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("syncAdditionalDirectories", () => {
  it("no references and no file -> nothing is created", async () => {
    const { combo, stateDir, file } = setup([]);
    expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe("skipped-empty");
    expect(() => readFileSync(file)).toThrow();
  });

  it("missing file -> .claude/ is created with references only. worktrees are under the root already", async () => {
    const { combo, stateDir, file } = setup();
    expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe("created");
    expect(read(file)).toEqual({ permissions: { additionalDirectories: ["/Users/you/src/logs"] } });
  });

  it("every other key, the key order and the indentation are preserved", async () => {
    const { combo, stateDir, file } = setup();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `{\n    "env": { "FOO": "1" },\n    "permissions": {\n        "allow": ["Bash(ls:*)"],\n        "deny": []\n    },\n    "model": "opus"\n}\n`,
    );
    expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe("written");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('\n    "env"');
    expect(Object.keys(read(file))).toEqual(["env", "permissions", "model"]);
    expect(read(file).permissions).toEqual({
      allow: ["Bash(ls:*)"],
      deny: [],
      additionalDirectories: ["/Users/you/src/logs"],
    });
  });

  it("invalid JSON -> the file is left byte-identical and a warning comes back", async () => {
    const { combo, stateDir, file } = setup();
    mkdirSync(path.dirname(file), { recursive: true });
    const broken = '{ "permissions": { "allow": [ }';
    writeFileSync(file, broken);
    const res = await syncAdditionalDirectories(combo, stateDir);
    expect(res.status).toBe("skipped-invalid-json");
    expect(res.warning?.message).toContain("left untouched");
    expect(readFileSync(file, "utf8")).toBe(broken);
  });

  it("an unexpected shape is left alone", async () => {
    const { combo, stateDir, file } = setup();
    mkdirSync(path.dirname(file), { recursive: true });
    for (const body of [
      '["not an object"]',
      '{"permissions": "nope"}',
      '{"permissions": {"additionalDirectories": "x"}}',
    ]) {
      writeFileSync(file, body);
      expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe(
        "skipped-unexpected-shape",
      );
      expect(readFileSync(file, "utf8")).toBe(body);
    }
  });

  it("already in sync -> no write, the mtime does not move", async () => {
    const { combo, stateDir, file } = setup();
    await syncAdditionalDirectories(combo, stateDir);
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe("unchanged");
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("a removed reference is removed, an entry the person added with /add-dir is not", async () => {
    const { combo, stateDir, file } = setup(["/Users/you/src/logs", "/Users/you/src/docs"]);
    await syncAdditionalDirectories(combo, stateDir);
    const mine = read(file);
    mine.permissions.additionalDirectories.push("/Users/you/scratch");
    writeFileSync(file, JSON.stringify(mine, null, 2));

    combo.folders = combo.folders.filter((f) => f.path !== "/Users/you/src/docs");
    expect((await syncAdditionalDirectories(combo, stateDir)).status).toBe("written");
    expect(read(file).permissions.additionalDirectories).toEqual([
      "/Users/you/src/logs",
      "/Users/you/scratch",
    ]);
  });

  it("without the cache dir's memory we only ever add", async () => {
    const { combo, file } = setup(["/Users/you/src/logs"]);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ permissions: { additionalDirectories: ["/Users/you/old-ref"] } }),
    );
    await syncAdditionalDirectories(combo, null);
    expect(read(file).permissions.additionalDirectories).toEqual([
      "/Users/you/old-ref",
      "/Users/you/src/logs",
    ]);
  });
});
