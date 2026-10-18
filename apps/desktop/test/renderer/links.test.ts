import { describe, expect, it } from "vitest";
import { dirOf, localPath, webLink } from "../../src/renderer/logic/links.ts";

describe("a link in what an agent wrote", () => {
  it("only a web link is a link", () => {
    expect(webLink("https://example.com/x")).toBe("https://example.com/x");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("file:///etc/passwd")).toBeNull();
    expect(webLink("/relative")).toBeNull();
    expect(webLink(undefined)).toBeNull();
  });

  it("a path is a file, against the folder the text is from", () => {
    const base = "/Users/me/my project/plans";
    expect(localPath("shot.png", base)).toBe("/Users/me/my project/plans/shot.png");
    expect(localPath("./a b.svg", base)).toBe("/Users/me/my project/plans/a b.svg");
    expect(localPath("../artifacts/x.png", base)).toBe("/Users/me/my project/artifacts/x.png");
    expect(localPath("/tmp/x.png", base)).toBe("/tmp/x.png");
    expect(localPath("file:///tmp/x.png", base)).toBe("/tmp/x.png");
    expect(localPath("notes.md#part", base)).toBe("/Users/me/my project/plans/notes.md");
    expect(localPath("https://example.com/x.png", base)).toBeNull();
    expect(localPath("data:image/png;base64,AAAA", base)).toBeNull();
    expect(localPath("grove-file://abc/etc/passwd", base)).toBeNull();
    expect(localPath("javascript:alert(1)", base)).toBeNull();
    expect(localPath("file://host/share/x.png", base)).toBeNull();
    expect(localPath(undefined, base)).toBeNull();
    expect(dirOf("/a/b/c.md")).toBe("/a/b");
    expect(dirOf("/c.md")).toBe("/");
  });
});
