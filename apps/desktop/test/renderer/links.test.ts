import { describe, expect, it } from "vitest";
import { webLink } from "../../src/renderer/logic/links.ts";

describe("a link in what an agent wrote", () => {
  it("only a web link is a link", () => {
    expect(webLink("https://example.com/x")).toBe("https://example.com/x");
    expect(webLink("javascript:alert(1)")).toBeNull();
    expect(webLink("file:///etc/passwd")).toBeNull();
    expect(webLink("/relative")).toBeNull();
    expect(webLink(undefined)).toBeNull();
  });
});
