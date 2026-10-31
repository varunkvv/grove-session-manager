import { describe, expect, it } from "vitest";
import { EDITOR_PRESETS, editorFileArgs } from "../src/editor.ts";

describe("a file in its project's window", () => {
  it("vs code and cursor: the folder, then --goto the file", () => {
    for (const id of ["vscode", "cursor"] as const) {
      expect(editorFileArgs(EDITOR_PRESETS[id], "/p", "/p/a.ts")).toEqual([
        "/p",
        "--goto",
        "/p/a.ts",
      ]);
    }
  });
  it("zed: the folder and the file, never a new window", () => {
    expect(editorFileArgs(EDITOR_PRESETS.zed, "/p", "/p/a.ts")).toEqual(["/p", "/p/a.ts"]);
  });
});
