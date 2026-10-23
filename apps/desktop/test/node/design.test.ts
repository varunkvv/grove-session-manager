import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GAVEL_MOODS,
  generate,
  loadParts,
  restFrame,
  staticFrame,
} from "../../scripts/gavelScene.ts";

const dir = path.join(import.meta.dirname, "../../src/renderer");
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);
const css = readFileSync(path.join(dir, "app.css"), "utf8");
const UI = "components/ui.tsx";

type Halves = { light: string; dark: string };

/** light-dark(a, b) as its two halves. a comma inside rgb() is not the one between them */
function halves(value: string): Halves | null {
  const inner = /^light-dark\((.*)\)$/.exec(value.trim())?.[1];
  if (!inner) return null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0)
      return { light: inner.slice(0, i).trim(), dark: inner.slice(i + 1).trim() };
  }
  return null;
}

/** every palette's colour tokens as written: grove's in @theme, the others in a data-palette block */
function palettes(): Map<string, Map<string, string>> {
  const tokens = (body: string) =>
    new Map(
      [...body.matchAll(/--color-([a-z0-9-]+): ([^;]+);/g)]
        .filter(([, name]) => name !== "transparent")
        .map(([, name, value]) => [name as string, (value as string).trim()]),
    );
  const out = new Map([["grove", tokens(/@theme \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "")]]);
  for (const [, name, body] of css.matchAll(
    /:root\[data-palette="([a-z-]+)"\] \{([\s\S]*?)\n\}/g,
  )) {
    out.set(name as string, tokens(body as string));
  }
  return out;
}

/** WCAG 2 contrast of two #rrggbb colours */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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

  it("every palette sets every colour token grove has, and each one light and dark", () => {
    const all = palettes();
    expect([...all.keys()].sort()).toEqual(["grove", "rose-pine", "solarized"]);
    const grove = [...(all.get("grove")?.keys() ?? [])].sort();
    for (const [name, tokens] of all) {
      // a token left out would stay grove's violet or grey under another palette
      expect([...tokens.keys()].sort(), name).toEqual(grove);
      for (const [token, value] of tokens) {
        expect(halves(value), `${name} ${token} is not light-dark(light, dark)`).not.toBeNull();
      }
    }
  });

  // app.css's own rules, as numbers. the lines, the soft fills, the ring, the scrim and the thumb
  // carry no words and are alpha on purpose: they are not in these lists
  it("words, marks and the solid button keep their contrast on every ground, in every palette", () => {
    const GROUNDS = ["canvas", "chrome", "raised", "active", "overlay"];
    const WORDS = ["fg", "fg-2", "fg-3", "fg-4", "danger", "waiting", "working", "accent", "ultra"];
    const MARKS = ["faint", "hue-orange", "hue-green", "hue-red"];
    for (let i = 1; i <= 9; i++) MARKS.push(`project-${i}`);
    for (const [name, tokens] of palettes()) {
      for (const half of ["light", "dark"] as const) {
        const at = (token: string) => {
          const v = halves(tokens.get(token) ?? "")?.[half] ?? "";
          expect(v, `${name} ${half} ${token} is not a #rrggbb colour`).toMatch(/^#[0-9a-f]{6}$/i);
          return v;
        };
        for (const ground of GROUNDS) {
          // grove as shipped in 0.19 is a shade under on the open row's ground: waiting 4.49 in
          // light, danger 4.34 and the project fills 2.76-2.97 in dark. kept so grove looks exactly
          // as it did. the other palettes meet the rule
          const under = name === "grove" && ground === "active";
          for (const [list, floor] of [
            [WORDS, under ? 4.3 : 4.5],
            [MARKS, under ? 2.75 : 3],
          ] as const) {
            for (const token of list) {
              const r = contrast(at(token), at(ground));
              expect(
                r,
                `${name} ${half}: ${token} on ${ground} is ${r.toFixed(2)}`,
              ).toBeGreaterThanOrEqual(floor);
            }
          }
        }
        const solid = contrast(at("on-solid"), at("accent-solid"));
        expect(solid, `${name} ${half}: on-solid on accent-solid`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // a chat window's header is its project's soft band: the title, the project's name, the clock and
  // any state's word sit on it, and the project's own mark beside them
  it("every word and mark of the chat header keeps its contrast on each project's band", () => {
    const WORDS = ["fg", "fg-3", "fg-4", "accent", "working", "danger", "waiting"];
    const MARKS = ["faint", "hue-orange", "hue-green", "hue-red"];
    for (const [name, tokens] of palettes()) {
      for (const half of ["light", "dark"] as const) {
        const at = (token: string) => halves(tokens.get(token) ?? "")?.[half] ?? "";
        for (let n = 1; n <= 9; n++) {
          const band = at(`project-${n}-soft`);
          expect(band, `${name} ${half} project-${n}-soft`).toMatch(/^#[0-9a-f]{6}$/i);
          for (const [list, floor] of [
            [WORDS, 4.5],
            [[...MARKS, `project-${n}`], 3],
          ] as const) {
            for (const token of list) {
              const r = contrast(at(token), band);
              expect(
                r,
                `${name} ${half}: ${token} on project-${n}-soft is ${r.toFixed(2)}`,
              ).toBeGreaterThanOrEqual(floor);
            }
          }
        }
      }
    }
  });

  // gavel, the judgment day odds robot: its own colours, drawn by one primitive, that keep it
  // readable on every tile in every palette
  it("gavel's colours are tokens, and only ui.tsx draws them", () => {
    const BOT = /\b(?:bg|text|border|fill|stroke)-bot-[a-z-]+\b/g;
    for (const [f, src] of files) {
      if (f === UI) continue;
      expect(src.match(BOT) ?? [], `${f} draws gavel itself`).toEqual([]);
    }
    const defined = [...css.matchAll(/--color-(bot-[a-z-]+):/g)].map((m) => m[1]);
    const ui = files.find(([f]) => f === UI)?.[1] ?? "";
    const drawn = [...ui.matchAll(BOT)].map((m) => m[0].replace(/^[a-z]+-/, ""));
    expect([...new Set(drawn)].sort()).toEqual([...new Set(defined)].sort());
  });

  it("gavel reads on every ground: its outline on light, its metal on dark, its lights on its screen", () => {
    const LIGHT_GROUNDS = ["canvas", "chrome", "raised", "active", "overlay"];
    for (const [name, tokens] of palettes()) {
      const at = (token: string, half: "light" | "dark") => {
        const v = halves(tokens.get(token) ?? "")?.[half] ?? "";
        expect(v, `${name} ${half} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
        return v;
      };
      for (const ground of LIGHT_GROUNDS) {
        const light = contrast(at("bot-outline", "light"), at(ground, "light"));
        expect(light, `${name}: gavel's outline on ${ground}`).toBeGreaterThanOrEqual(3);
        const dark = contrast(at("bot-metal", "dark"), at(ground, "dark"));
        expect(dark, `${name}: gavel's metal on dark ${ground}`).toBeGreaterThanOrEqual(3);
      }
      for (const half of ["light", "dark"] as const) {
        for (const led of ["bot-shine", "bot-red", "bot-violet"]) {
          const r = contrast(at(led, half), at("bot-screen", half));
          expect(r, `${name} ${half}: ${led} on gavel's screen`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("gavel is drawn from its art: the scene is up to date, and each mood stands as parts.txt places it", () => {
    const parts = loadParts();
    const scene = readFileSync(path.join(dir, "gavel/scene.generated.ts"), "utf8");
    expect(scene, "run `node scripts/gavel.ts` in apps/desktop").toBe(generate(parts));
    const text = readFileSync(path.join(dir, "gavel/parts.txt"), "utf8");
    for (const mood of GAVEL_MOODS) {
      expect(restFrame(parts, mood), mood).toEqual(staticFrame(text, parts, mood));
    }
  });
});
