import type { IndexedFile } from "@grove/core/pure";
import { describe, expect, it } from "vitest";
import { splitSessionFiles } from "../../src/renderer/logic/sessionFiles.ts";

const paths = (rows: { path: string }[]) => rows.map((r) => r.path);

describe("a session's files, split for its list", () => {
  it("leaves out a tracked file no tool call touched", () => {
    const files: IndexedFile[] = [
      { path: "/p/a.ts" },
      { path: "/p/b.ts", touchedAt: 5, edited: true },
    ];
    const { edited, read } = splitSessionFiles(files, []);
    expect(paths(edited)).toEqual(["/p/b.ts"]);
    expect(read).toEqual([]);
  });

  it("puts edited files above read ones, each newest first", () => {
    const files: IndexedFile[] = [
      { path: "/p/r-old.ts", touchedAt: 1 },
      { path: "/p/e-old.ts", touchedAt: 2, edited: true },
      { path: "/p/r-new.ts", touchedAt: 9 },
      { path: "/p/e-new.ts", touchedAt: 8, edited: true },
    ];
    const { edited, read } = splitSessionFiles(files, []);
    expect(paths(edited)).toEqual(["/p/e-new.ts", "/p/e-old.ts"]);
    expect(paths(read)).toEqual(["/p/r-new.ts", "/p/r-old.ts"]);
  });

  it("joins counts by path, and a file with no change has none", () => {
    const files: IndexedFile[] = [
      { path: "/p/a.ts", touchedAt: 3, edited: true },
      { path: "/p/b.ts", touchedAt: 2, edited: true },
    ];
    const { edited } = splitSessionFiles(files, [{ path: "/p/a.ts", added: 4, removed: 1 }]);
    expect(edited[0]).toEqual({ path: "/p/a.ts", touchedAt: 3, added: 4, removed: 1 });
    expect(edited[1]).toEqual({ path: "/p/b.ts", touchedAt: 2 });
  });

  it("moves a read file with uncommitted changes into edited, with its counts", () => {
    const files: IndexedFile[] = [{ path: "/p/a.ts", touchedAt: 3 }];
    const { edited, read } = splitSessionFiles(files, [{ path: "/p/a.ts", added: 2, removed: 0 }]);
    expect(paths(edited)).toEqual(["/p/a.ts"]);
    expect(edited[0]).toEqual({ path: "/p/a.ts", touchedAt: 3, added: 2, removed: 0 });
    expect(read).toEqual([]);
  });

  it("keeps a new file's mark, and lists a change the transcript never touched last in edited", () => {
    const files: IndexedFile[] = [{ path: "/p/t.ts", touchedAt: 7, edited: true }];
    const { edited } = splitSessionFiles(files, [
      { path: "/p/new.md", fresh: true },
      { path: "/p/bash.ts", added: 3, removed: 3 },
    ]);
    expect(edited).toEqual([
      { path: "/p/t.ts", touchedAt: 7 },
      { path: "/p/bash.ts", added: 3, removed: 3 },
      { path: "/p/new.md", fresh: true },
    ]);
  });

  it("is empty for a session that touched nothing", () => {
    expect(splitSessionFiles([], [])).toEqual({ edited: [], read: [] });
  });
});
