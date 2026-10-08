import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(import.meta.dirname, "../../src/renderer");
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);
const css = readFileSync(path.join(dir, "app.css"), "utf8");
const UI = "components/ui.tsx";

// the visual rules, enforced: colours only through tokens, a meaning has one hue and one place
// that draws it, no gradients, one shadow
describe("design lint", () => {
  it("no raw colours outside app.css", () => {
    for (const [f, src] of files) {
      expect(src.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(/g) ?? [], f).toEqual([]);
    }
  });

  it("no colour and no font size is written by hand in a class", () => {
    // arbitrary values are for layout: w-[84px], max-w-[860px]. a colour or a size is a token.
    const BY_HAND =
      /\b(?:bg|text|border|fill|stroke|outline|ring|divide|decoration|placeholder|caret)-\[/g;
    for (const [f, src] of files) expect(src.match(BY_HAND) ?? [], f).toEqual([]);
  });

  it("no gradients anywhere", () => {
    for (const [f, src] of files) expect(/gradient/i.test(src), f).toBe(false);
    expect(/gradient/i.test(css)).toBe(false);
  });

  it("the only shadow is the overlay shadow, and it is ours rather than a tailwind utility", () => {
    for (const [f, src] of files) {
      expect(src.match(/\bshadow-(?:\[|[a-z0-9-]+)/g) ?? [], f).toEqual([]);
    }
  });

  // a token with only one value is the way this breaks, so check every colour carries both
  it("every colour token has a light value as well as a dark one", () => {
    const theme = /@theme \{([\s\S]*?)\n\}/.exec(css);
    expect(theme, "the theme block is gone").not.toBeNull();
    const colours = [...(theme?.[1] ?? "").matchAll(/(--color-[a-z0-9-]+): ([^;]+);/g)];
    expect(colours.length).toBeGreaterThan(30);
    for (const [, name, value] of colours) {
      if (name === "--color-transparent") continue;
      expect(value?.trim().startsWith("light-dark("), `${name} has one appearance only`).toBe(true);
    }
  });

  it("a state and a project get their colour from ui.tsx and nowhere else", () => {
    const HUE = /\b(?:bg|text|border|fill|stroke)-(?:hue-[a-z]+|project-[1-9])\b/g;
    for (const [f, src] of files) {
      if (f === UI) continue;
      expect(src.match(HUE) ?? [], `${f} picks a state or project colour itself`).toEqual([]);
    }
    // every hue the stylesheet defines is drawn by a primitive, and none is drawn that is not defined
    const defined = [...css.matchAll(/--color-(hue-[a-z]+|project-[1-9]):/g)].map((m) => m[1]);
    const ui = files.find(([f]) => f === UI)?.[1] ?? "";
    const drawn = [...ui.matchAll(HUE)].map((m) => m[0].replace(/^[a-z]+-/, ""));
    expect([...new Set(drawn)].sort()).toEqual([...new Set(defined)].sort());
  });

  it("the accent is the primary action, a link, focus, a count, the selected item and your turn: all of them primitives", () => {
    const ACCENT = /\b(?:bg|text|border|outline|fill|stroke)-accent(?:-solid|-soft|-line)?\b/g;
    for (const [f, src] of files) {
      if (f === UI) continue;
      expect(src.match(ACCENT) ?? [], `${f} uses the accent directly`).toEqual([]);
    }
  });

  it("the faint grey is for icons, never for words", () => {
    // 3:1 is enough for a chevron and too little for text. an icon asks for it with <Icon faint>.
    for (const [f, src] of files) {
      if (f === UI) continue;
      expect(src.match(/\btext-faint\b/g) ?? [], `${f} writes text in the faint grey`).toEqual([]);
    }
  });
});
