import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceFilePath, writeWorkspaceFile } from "../../src/combos/workspace.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

function setup(): Combo {
  const base = makeSandbox("grove-ws-");
  const root = path.join(base, "claude-ws", "prod-debug");
  const logs = path.join(base, "src", "logs");
  mkdirSync(root, { recursive: true });
  mkdirSync(logs, { recursive: true });
  return {
    name: "Prod debug",
    root,
    folders: [
      { path: path.join(base, "src", "api"), mode: "worktree", branch: { kind: "detach" } },
      { path: logs, mode: "reference" },
    ],
  };
}

describe(".code-workspace generation", () => {
  it("lives in the root, named after the root's basename. root first, then references only", async () => {
    const combo = setup();
    const res = await writeWorkspaceFile(combo);
    expect(res).toMatchObject({
      path: path.join(combo.root, "prod-debug.code-workspace"),
      changed: true,
    });
    const ws = JSON.parse(readFileSync(res.path, "utf8"));
    expect(ws.folders.map((f: { path: string }) => path.resolve(combo.root, f.path))).toEqual([
      combo.root,
      combo.folders[1]!.path,
    ]);
    expect(ws.folders[0].name).toBe("Prod debug");
  });

  it("unchanged folders are not rewritten: VS Code reloads the window when this file changes", async () => {
    const combo = setup();
    const { path: file } = await writeWorkspaceFile(combo);
    const before = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    expect((await writeWorkspaceFile(combo)).changed).toBe(false);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("paths VS Code rewrote as relative still count as unchanged, and settings are preserved", async () => {
    const combo = setup();
    const file = workspaceFilePath(combo);
    const rel = path.relative(combo.root, combo.folders[1]!.path);
    const byVsCode = `{
	// written by VS Code
	"folders": [
		{ "name": "Prod debug", "path": "." },
		{ "name": "logs (ref)", "path": "${rel}" },
	],
	"settings": { "editor.tabSize": 4 }
}`;
    writeFileSync(file, byVsCode);
    expect((await writeWorkspaceFile(combo)).changed).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(byVsCode);

    // a new reference changes the folder list: only `folders` is replaced
    const docs = path.join(path.dirname(combo.folders[1]!.path), "docs");
    mkdirSync(docs);
    combo.folders.push({ path: docs, mode: "reference" });
    expect((await writeWorkspaceFile(combo)).changed).toBe(true);
    const ws = JSON.parse(readFileSync(file, "utf8"));
    expect(ws.settings).toEqual({ "editor.tabSize": 4 });
    expect(ws.folders).toHaveLength(3);
  });

  it("an unparseable file is set aside, not deleted, and regenerated", async () => {
    const combo = setup();
    writeFileSync(workspaceFilePath(combo), "{ nope");
    const res = await writeWorkspaceFile(combo);
    expect(res.changed).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(readdirSync(combo.root).some((n) => n.includes(".invalid-"))).toBe(true);
    expect(() => JSON.parse(readFileSync(res.path, "utf8"))).not.toThrow();
  });
});
