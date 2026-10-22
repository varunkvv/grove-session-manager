import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { byteRange, sessionFileOf, within } from "../../src/main/sessionFiles.ts";
import { FILE_SCHEME, sessionUrl } from "../../src/shared/sessionUrl.ts";

describe("the files a chat window may show", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-files-")));
  const root = path.join(dir, "project");
  const outside = path.join(dir, "secret");
  mkdirSync(path.join(root, "plans"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "plans", "a.md"), "# a");
  writeFileSync(path.join(outside, "key.png"), "x");
  symlinkSync(outside, path.join(root, "escape"));
  symlinkSync(path.join(root, "plans", "a.md"), path.join(root, "alias.md"));

  it("serves what is under a root, and nothing a path or a link takes out of it", async () => {
    expect(await within([root], path.join(root, "plans", "a.md"))).toBe(
      path.join(root, "plans", "a.md"),
    );
    // a link that stays inside is fine
    expect(await within([root], path.join(root, "alias.md"))).toBe(
      path.join(root, "plans", "a.md"),
    );
    expect(await within([root], path.join(root, "escape", "key.png"))).toBeNull();
    expect(await within([root], path.join(root, "..", "secret", "key.png"))).toBeNull();
    expect(await within([root], "plans/a.md")).toBeNull();
    expect(await within([root], `${root}/plans/a.md\0.png`)).toBeNull();
    expect(await within([root], path.join(root, "missing.png"))).toBeNull();
    // the root itself is a folder, not a file in it
    expect(await within([root], root)).toBeNull();
    // the temp folder through its link, as macOS has it
    expect(await within(["/tmp"], path.join(root, "plans", "a.md"))).toBe(
      dir.startsWith("/private/tmp") || dir.startsWith("/tmp")
        ? path.join(root, "plans", "a.md")
        : null,
    );
  });

  it("gives a video the bytes it asks for when it seeks", () => {
    // no header, or one it does not read: all of it
    expect(byteRange(null, 100)).toBeUndefined();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeUndefined();
    expect(byteRange("bytes=-", 100)).toBeUndefined();
    expect(byteRange("items=0-1", 100)).toBeUndefined();
    expect(byteRange("bytes=9-3", 100)).toBeUndefined();
    // a-b, a-, -n
    expect(byteRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    expect(byteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=40-", 100)).toEqual({ start: 40, end: 99 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    // past the end, or nothing at all: none of it
    expect(byteRange("bytes=100-", 100)).toBeNull();
    expect(byteRange("bytes=100-200", 100)).toBeNull();
    expect(byteRange("bytes=-0", 100)).toBeNull();
    expect(byteRange("bytes=0-", 0)).toBeNull();
    expect(byteRange("bytes=-5", 0)).toBeNull();
  });

  it("reads back the session and the path the page put in a url", () => {
    const file = "/Users/me/a b/#1 ?.png";
    const url = sessionUrl(FILE_SCHEME, "cccccccc-0000-4000-8000-000000000001", file, 3);
    expect(sessionFileOf(url)).toEqual({ sessionId: "cccccccc-0000-4000-8000-000000000001", file });
    expect(sessionFileOf("grove-file:///etc/passwd")).toBeNull();
    expect(sessionFileOf("not a url")).toBeNull();
  });
});
