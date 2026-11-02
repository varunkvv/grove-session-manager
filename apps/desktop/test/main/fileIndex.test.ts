import { type ConversationState, emptyConversationState, emptyTimelineState } from "@grove/core";
import { describe, expect, it } from "vitest";
import { buildFileIndex, touchesOf } from "../../src/main/fileIndex.ts";

const noTracked = async () => [];

describe("buildFileIndex", () => {
  it("keeps the latest touch and ORs edited across touches of one path", async () => {
    const files = await buildFileIndex({
      touches: [
        { path: "/r/a.ts", at: 10, edited: false },
        { path: "/r/a.ts", at: 30, edited: true },
        { path: "/r/a.ts", at: 20, edited: false },
      ],
      folders: [],
      listTracked: noTracked,
    });
    expect(files).toEqual([{ path: "/r/a.ts", touchedAt: 30, edited: true }]);
  });

  it("adds tracked files with no touchedAt", async () => {
    const files = await buildFileIndex({
      touches: [],
      folders: ["/r"],
      listTracked: async () => ["b.ts"],
    });
    expect(files).toEqual([{ path: "/r/b.ts" }]);
    expect(files[0]?.touchedAt).toBeUndefined();
  });

  it("dedupes a path that two folders both track", async () => {
    const files = await buildFileIndex({
      touches: [],
      folders: ["/r", "/r/sub"],
      listTracked: async (folder) => (folder === "/r" ? ["sub/a.ts"] : ["a.ts"]),
    });
    expect(files.map((f) => f.path)).toEqual(["/r/sub/a.ts"]);
  });

  it("makes one entry for a touch and a tracked file at the same path, keeping the touch", async () => {
    const files = await buildFileIndex({
      touches: [{ path: "/r/a.ts", at: 5, edited: true }],
      folders: ["/r"],
      listTracked: async () => ["a.ts", "c.ts"],
    });
    expect(files).toEqual([{ path: "/r/a.ts", touchedAt: 5, edited: true }, { path: "/r/c.ts" }]);
  });

  it("sorts by path", async () => {
    const files = await buildFileIndex({
      touches: [{ path: "/r/z.ts", at: 1, edited: false }],
      folders: ["/r"],
      listTracked: async () => ["b.ts", "a.ts"],
    });
    expect(files.map((f) => f.path)).toEqual(["/r/a.ts", "/r/b.ts", "/r/z.ts"]);
  });
});

describe("touchesOf", () => {
  const tool = (name: string, p: string | undefined, at: number, isError = false) => ({
    kind: "tool" as const,
    id: `${name}-${at}`,
    name,
    target: "",
    input: "",
    at,
    use: { offset: 0, length: 0 },
    ...(p ? { path: p } : {}),
    ...(isError ? { isError: true } : {}),
  });

  it("leaves out a step that errored: a failed edit did not touch the file", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      items: [
        {
          kind: "turn",
          marks: [],
          work: {
            ...emptyTimelineState(),
            steps: [tool("Edit", "/r/a.ts", 1, true), tool("Read", "/r/b.ts", 2)],
          },
        },
      ],
    };
    expect(touchesOf(state)).toEqual([{ path: "/r/b.ts", at: 2, edited: false }]);
  });

  it("takes absolute file-tool paths with their call time, edited unless read", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      items: [
        {
          kind: "turn",
          marks: [],
          work: {
            ...emptyTimelineState(),
            steps: [
              tool("Read", "/r/a.ts", 1),
              tool("Edit", "/r/a.ts", 2),
              tool("Write", "relative.ts", 3),
              tool("Bash", undefined, 4),
            ],
          },
        },
      ],
    };
    expect(touchesOf(state)).toEqual([
      { path: "/r/a.ts", at: 1, edited: false },
      { path: "/r/a.ts", at: 2, edited: true },
    ]);
  });
});
