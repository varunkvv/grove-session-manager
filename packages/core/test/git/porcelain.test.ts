import { describe, expect, it } from "vitest";
import { parseWorktreeList, shortBranch } from "../../src/git/porcelain.ts";

const SHA = "9ffd4dbc650decc6cbfeaf681e0c5cc9274198ba";
const SHA2 = "0017ae66f232a790c331bea7fc8eec0ecfef764f";

// shaped after what git 2.54 printed for a real repo: records are attribute lines, a blank ends one
const RECORDS = [
  ["worktree /private/tmp/ws/origin", `HEAD ${SHA}`, "branch refs/heads/main"],
  [
    "worktree /private/tmp/ws/prod debug/api",
    `HEAD ${SHA2}`,
    "detached",
    "prunable gitdir file points to non-existent location",
  ],
  [
    "worktree /private/tmp/ws/usb/web",
    `HEAD ${SHA}`,
    "branch refs/heads/dev/eng-218",
    "locked on a usb stick",
  ],
  ["worktree /private/tmp/ws/alpha/lib", `HEAD ${SHA}`, "branch refs/heads/release", "locked"],
];

const asNul = (records: string[][]) => records.map((r) => `${r.join("\0")}\0\0`).join("");
const asLines = (records: string[][]) => records.map((r) => `${r.join("\n")}\n\n`).join("");

const EXPECTED = [
  {
    path: "/private/tmp/ws/origin",
    head: SHA,
    branch: "refs/heads/main",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: true,
  },
  {
    path: "/private/tmp/ws/prod debug/api",
    head: SHA2,
    detached: true,
    bare: false,
    locked: false,
    prunable: true,
    prunableReason: "gitdir file points to non-existent location",
    isMain: false,
  },
  {
    path: "/private/tmp/ws/usb/web",
    head: SHA,
    branch: "refs/heads/dev/eng-218",
    detached: false,
    bare: false,
    locked: true,
    lockedReason: "on a usb stick",
    prunable: false,
    isMain: false,
  },
  {
    path: "/private/tmp/ws/alpha/lib",
    head: SHA,
    branch: "refs/heads/release",
    detached: false,
    bare: false,
    locked: true,
    prunable: false,
    isMain: false,
  },
];

describe("parseWorktreeList", () => {
  it("-z form: main with a branch, detached, prunable and locked with and without a reason", () => {
    expect(parseWorktreeList(asNul(RECORDS))).toEqual(EXPECTED);
  });

  it("newline form parses to the same entries", () => {
    expect(parseWorktreeList(asLines(RECORDS))).toEqual(EXPECTED);
  });

  it("a bare main repository has no HEAD and no branch", () => {
    const bare = [["worktree /srv/git/api.git", "bare"], RECORDS[2]!];
    for (const text of [asNul(bare), asLines(bare)]) {
      const [main, linked] = parseWorktreeList(text);
      expect(main).toEqual({
        path: "/srv/git/api.git",
        detached: false,
        bare: true,
        locked: false,
        prunable: false,
        isMain: true,
      });
      expect(linked).toMatchObject({ path: "/private/tmp/ws/usb/web", isMain: false });
    }
  });

  it("-z keeps a newline inside a path or a reason. the newline form unquotes the reason", () => {
    const nul = parseWorktreeList(
      `worktree /ws/odd\nname\0HEAD ${SHA}\0detached\0locked line one\nline "two"\0\0`,
    );
    expect(nul).toHaveLength(1);
    expect(nul[0]).toMatchObject({ path: "/ws/odd\nname", lockedReason: 'line one\nline "two"' });

    const lines = parseWorktreeList(
      `worktree /ws/x\nHEAD ${SHA}\ndetached\nlocked "line one\\nline \\"two\\" \\303\\251"\n\n`,
    );
    expect(lines[0]!.lockedReason).toBe('line one\nline "two" é');
  });

  it("unknown attributes are skipped, empty output is no entries", () => {
    const text = `worktree /ws/a\0HEAD ${SHA}\0branch refs/heads/main\0sparkly yes\0future\0\0`;
    expect(parseWorktreeList(text)).toEqual([EXPECTED[0]].map((e) => ({ ...e, path: "/ws/a" })));
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n")).toEqual([]);
  });
});

describe("shortBranch", () => {
  it("strips refs/heads/ and nothing else", () => {
    expect(shortBranch("refs/heads/main")).toBe("main");
    expect(shortBranch("refs/heads/dev/eng-218")).toBe("dev/eng-218");
    expect(shortBranch("refs/remotes/origin/main")).toBe("refs/remotes/origin/main");
    expect(shortBranch("main")).toBe("main");
  });
});
