import { describe, expect, it } from "vitest";
import { fileLine, type IndexedFile, resolveFileRef } from "../src/fileIndex.ts";

const ROOT = "/Users/you/repo";
const at = (path: string, touchedAt?: number): IndexedFile => ({
  path: `${ROOT}/${path}`,
  touchedAt,
});

describe("resolveFileRef", () => {
  it("resolves an exact relative path", () => {
    const files = [at("src/a/b.ts"), at("src/c.ts")];
    expect(resolveFileRef("src/a/b.ts", files)).toBe(`${ROOT}/src/a/b.ts`);
  });

  it("resolves a bare basename when it is unique", () => {
    const files = [at("src/a/b.ts"), at("src/c.ts")];
    expect(resolveFileRef("c.ts", files)).toBe(`${ROOT}/src/c.ts`);
  });

  it("returns null for an ambiguous basename when none were touched", () => {
    const files = [at("src/a/index.ts"), at("src/b/index.ts")];
    expect(resolveFileRef("index.ts", files)).toBeNull();
  });

  it("picks the one touched candidate when only one was touched", () => {
    const files = [at("src/a/index.ts"), at("src/b/index.ts", 1000)];
    expect(resolveFileRef("index.ts", files)).toBe(`${ROOT}/src/b/index.ts`);
  });

  it("picks the most recently touched candidate when several were touched", () => {
    const files = [
      at("src/a/index.ts", 1000),
      at("src/b/index.ts", 3000),
      at("src/c/index.ts", 2000),
    ];
    expect(resolveFileRef("index.ts", files)).toBe(`${ROOT}/src/b/index.ts`);
  });

  it("returns null when the most recent candidates tie", () => {
    const files = [at("src/a/index.ts", 2000), at("src/b/index.ts", 2000)];
    expect(resolveFileRef("index.ts", files)).toBeNull();
  });

  it("strips a leading ./", () => {
    const files = [at("a/b.ts")];
    expect(resolveFileRef("./a/b.ts", files)).toBe(`${ROOT}/a/b.ts`);
  });

  it("resolves file:line and file:line:col to the file", () => {
    const files = [at("src/Files.tsx")];
    expect(resolveFileRef("Files.tsx:42", files)).toBe(`${ROOT}/src/Files.tsx`);
    expect(resolveFileRef("Files.tsx:42:7", files)).toBe(`${ROOT}/src/Files.tsx`);
    expect(fileLine("Files.tsx:42")).toBe(42);
    expect(fileLine("Files.tsx:42:7")).toBe(42);
  });

  it("returns undefined from fileLine when there is no trailing line", () => {
    expect(fileLine("Files.tsx")).toBeUndefined();
    expect(fileLine("Files.tsx:abc")).toBeUndefined();
  });

  it("returns null for .. and ~ tokens", () => {
    const files = [at("src/a.ts"), at("secret/a.ts")];
    expect(resolveFileRef("../a.ts", files)).toBeNull();
    expect(resolveFileRef("src/../a.ts", files)).toBeNull();
    expect(resolveFileRef("~/a.ts", files)).toBeNull();
  });

  it("returns an absolute token only when it is exactly an indexed file", () => {
    expect(resolveFileRef(`${ROOT}/src/a.ts`, [at("src/a.ts")])).toBe(`${ROOT}/src/a.ts`);
    expect(resolveFileRef(`${ROOT}/src/b.ts`, [at("src/a.ts")])).toBeNull();
  });

  it("returns null for an unknown file", () => {
    expect(resolveFileRef("nope.ts", [at("src/a.ts")])).toBeNull();
  });

  it("does not match a basename that is only a suffix of another segment", () => {
    const files = [at("x/gui.tsx")];
    expect(resolveFileRef("ui.tsx", files)).toBeNull();
  });
});
