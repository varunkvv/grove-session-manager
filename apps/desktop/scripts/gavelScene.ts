// gavel, the judgment day odds robot: its art (src/renderer/gavel/parts.txt and anim-parts.txt) to
// the groups and rects the Gavel primitive draws. the scene tree is the animation's (the sprite's
// anim/spec.py SCENE): every group a keyframe in gavel.css moves, in paint order, each with the
// moods it shows in. `node scripts/gavel.ts` writes it out; design.test.ts fails while it is stale.
import { readFileSync } from "node:fs";
import path from "node:path";

export const W = 28;
export const H = 22;
const MOODS = ["delighted", "standing-down", "watching", "coming-for-you", "furious"] as const;
type Mood = (typeof MOODS)[number];
const [DEL, STD, WAT, CFY, FUR] = MOODS;

/** one char per colour. each is a --color-bot-* token (ui.tsx GAVEL_INK) */
export const INKS = ["K", "D", "O", "S", "M", "L", "H", "R", "r", "V", "v", "g"] as const;
export type Ink = (typeof INKS)[number];

export type Parts = Record<string, string[]>;

/** `@part name` then its rows, `@mood name` then `layer part x y`. `#` comments */
export function parseParts(text: string): {
  parts: Parts;
  moods: Record<string, Array<[string, string, number, number]>>;
} {
  const parts: Parts = {};
  const moods: Record<string, Array<[string, string, number, number]>> = {};
  let cur:
    | { kind: "part"; rows: string[] }
    | { kind: "mood"; rows: Array<[string, string, number, number]> }
    | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("#")) continue;
    if (line.startsWith("@size")) cur = null;
    else if (line.startsWith("@part")) {
      const rows: string[] = [];
      parts[line.split(/\s+/)[1] ?? ""] = rows;
      cur = { kind: "part", rows };
    } else if (line.startsWith("@mood")) {
      const rows: Array<[string, string, number, number]> = [];
      moods[line.split(/\s+/)[1] ?? ""] = rows;
      cur = { kind: "mood", rows };
    } else if (!line.trim()) cur = null;
    else if (cur?.kind === "part") cur.rows.push(line);
    else if (cur?.kind === "mood") {
      const [layer = "", part = "", x = "0", y = "0"] = line.split(/\s+/);
      cur.rows.push([layer, part, Number(x), Number(y)]);
    }
  }
  return { parts, moods };
}

interface Leaf {
  t: "p";
  part: string;
  x: number;
  y: number;
  /** [x0, y0, x1, y1) of the part kept, in place */
  crop?: [number, number, number, number];
  /** only these chars */
  keep?: string;
  recolor?: Record<string, string>;
}

interface Group {
  t: "g";
  cls: string;
  kids: Array<Group | Leaf>;
  moods?: Mood[];
  overlay?: boolean;
  /** a resting offset per mood: in gavel.css, not in the markup */
  rest?: Partial<Record<Mood, [number, number]>>;
}

const P = (
  part: string,
  x: number,
  y: number,
  o: Omit<Leaf, "t" | "part" | "x" | "y"> = {},
): Leaf => ({
  t: "p",
  part,
  x,
  y,
  ...o,
});
const G = (
  cls: string,
  kids: Array<Group | Leaf>,
  o: { moods?: Mood[]; overlay?: boolean; rest?: Group["rest"] } = {},
): Group => ({ t: "g", cls, kids, ...o });

/** spec.py's SCENE, back to front */
export const SCENE: Group = G("root", [
  G("gavel-shadow", [P("shadow", 7, 21)]),
  G("gavel-body", [
    G("gavel-legs", [P("legs", 9, 19)]),
    G("gavel-upper", [
      G("gavel-arm-l", [P("arm.l.back", 7, 15)], { moods: [WAT] }),
      // pleased keeps one hand behind its back
      G("gavel-arm-r", [P("arm.r.back", 18, 15)], { moods: [WAT, DEL] }),
      P("torso", 10, 15),
      G("gavel-arm-l", [P("arm.l.idle", 7, 15)], { moods: [STD, CFY] }),
      G(
        "gavel-headpos",
        [
          G("gavel-head", [
            G("gavel-ant", [
              P("antenna.stalk", 12, 3),
              G("gavel-bulb", [P("antenna.violet", 12, 0, { crop: [0, 0, 4, 3] })], {
                moods: [DEL, STD, WAT],
              }),
              G("gavel-bulb", [P("antenna.red", 12, 0, { crop: [0, 0, 4, 3] })], {
                moods: [CFY, FUR],
              }),
              // the bulb switched off: solid off colours, the same on every tile
              G(
                "gavel-ov-bulb",
                [P("antenna.violet", 12, 0, { crop: [0, 0, 4, 3], recolor: { V: "v", H: "L" } })],
                { moods: [DEL, STD, WAT], overlay: true },
              ),
              G(
                "gavel-ov-bulb",
                [P("antenna.red", 12, 0, { crop: [0, 0, 4, 3], recolor: { R: "r", H: "L" } })],
                { moods: [CFY, FUR], overlay: true },
              ),
            ]),
            P("head", 6, 4),
            G(
              "gavel-face",
              [
                P("face.pleased", 8, 6),
                G("gavel-ov-peek", [P("ov.pleased.peek", 9, 8)], { overlay: true }),
              ],
              { moods: [DEL] },
            ),
            G(
              "gavel-face",
              [
                P("face.tolerating", 8, 6),
                G("gavel-blink-a", [P("ov.tolerating.blink", 9, 8)], { overlay: true }),
                G("gavel-blink-b", [P("ov.tolerating.blink", 9, 8)], { overlay: true }),
              ],
              { moods: [STD] },
            ),
            G(
              "gavel-face",
              [
                // the white squint
                P("face.watch", 8, 6, { crop: [0, 0, 6, 5] }),
                G("gavel-ov-squint", [P("ov.watch.squint", 9, 9)], { overlay: true }),
                // the red eye drifts as one piece, its blinks ride along
                G("gavel-eye", [
                  P("face.watch", 8, 6, { crop: [6, 0, 12, 5] }),
                  G("gavel-blink-a", [P("ov.watch.blink", 15, 7)], { overlay: true }),
                  G("gavel-blink-b", [P("ov.watch.blink", 15, 7)], { overlay: true }),
                ]),
                // turns with the eye
                G("gavel-mouth", [P("face.watch", 8, 6, { crop: [0, 5, 12, 8] })]),
              ],
              { moods: [WAT] },
            ),
            G(
              "gavel-face",
              [
                P("face.angry", 8, 6),
                G("gavel-blink-a", [P("ov.angry.blink", 9, 7)], { overlay: true }),
                G("gavel-blink-b", [P("ov.angry.blink", 9, 7)], { overlay: true }),
              ],
              { moods: [CFY] },
            ),
            G(
              "gavel-face",
              [
                P("face.furious", 8, 6),
                G("gavel-ov-halo", [P("face.furious", 8, 6, { keep: "r", recolor: { r: "K" } })], {
                  overlay: true,
                }),
              ],
              { moods: [FUR] },
            ),
            // the mood change: the screen goes dark with a CRT line. white on the way out, then the
            // new mood's LED colour on the way in
            G("gavel-ov-scan", [P("head", 6, 4, { keep: "K" }), P("ov.scan.line", 10, 9)], {
              overlay: true,
            }),
            G("gavel-ov-scanin", [P("head", 6, 4, { keep: "K" }), P("ov.scan.line", 10, 9)], {
              moods: [DEL, STD],
              overlay: true,
            }),
            G(
              "gavel-ov-scanin",
              [P("head", 6, 4, { keep: "K" }), P("ov.scan.line", 10, 9, { recolor: { H: "R" } })],
              { moods: [WAT, CFY, FUR], overlay: true },
            ),
          ]),
        ],
        // coming for you hunches 1px into the shoulders
        { rest: { [CFY]: [0, 1] } },
      ),
      G(
        // pleased: the royal wave. the open hand (rows 10-13) moves on its own
        "gavel-arm-l",
        [
          P("arm.l.cheer", 0, 10, { crop: [0, 4, 11, 8] }),
          G("gavel-hand", [P("arm.l.cheer", 0, 10, { crop: [0, 0, 5, 4] })]),
        ],
        { moods: [DEL] },
      ),
      G("gavel-arm-l", [P("arm.l.fist-up", 0, 7)], { moods: [FUR] }),
      G("gavel-arm-r", [P("arm.r.thumb", 17, 10)], { moods: [STD] }),
      G("gavel-arm-r", [P("arm.r.fist-up", 17, 7)], { moods: [CFY, FUR] }),
      G("gavel-fx", [P("anger", 23, 0)], { moods: [FUR] }),
    ]),
  ]),
  // 2px above the thumb tip while the arm is up
  G("gavel-pt", [P("fx.glint", 24, 5)], { moods: [STD], overlay: true }),
  G("gavel-pt2", [P("fx.glint.dot", 25, 6)], { moods: [STD], overlay: true }),
]);

type Pixel = [x: number, y: number, c: string];

export function leafPixels(parts: Parts, leaf: Leaf): Pixel[] {
  const rows = parts[leaf.part];
  if (!rows) throw new Error(`no part ${leaf.part}`);
  const [x0, y0, x1, y1] = leaf.crop ?? [0, 0, rows[0]?.length ?? 0, rows.length];
  const out: Pixel[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "." || x < x0 || x >= x1 || y < y0 || y >= y1) return;
      if (leaf.keep && !leaf.keep.includes(c)) return;
      out.push([leaf.x + x, leaf.y + y, leaf.recolor?.[c] ?? c]);
    });
  });
  return out;
}

/** horizontal runs of one colour per row, top to bottom: [x, y, width, ink] */
export function rectRuns(pixels: Pixel[]): Array<[number, number, number, string]> {
  const rows = new Map<number, Map<number, string>>();
  for (const [x, y, c] of pixels) {
    const row = rows.get(y) ?? new Map<number, string>();
    row.set(x, c);
    rows.set(y, row);
  }
  const out: Array<[number, number, number, string]> = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(y) ?? new Map<number, string>();
    const xs = [...row.keys()].sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      const x = xs[i] ?? 0;
      const c = row.get(x) ?? "";
      let n = 1;
      while (i + n < xs.length && xs[i + n] === x + n && row.get(x + n) === c) n++;
      out.push([x, y, n, c]);
      i += n;
    }
  }
  return out;
}

const DIR = path.join(import.meta.dirname, "../src/renderer/gavel");

export function loadParts(): Parts {
  const { parts } = parseParts(readFileSync(path.join(DIR, "parts.txt"), "utf8"));
  const { parts: extra } = parseParts(readFileSync(path.join(DIR, "anim-parts.txt"), "utf8"));
  for (const name of Object.keys(extra)) {
    if (parts[name]) throw new Error(`anim-parts.txt redefines ${name}`);
  }
  return { ...parts, ...extra };
}

/** a mood's still frame from the scene: overlays off, other moods' groups out, resting offsets on */
export function restFrame(parts: Parts, mood: Mood): string[] {
  const grid = Array.from({ length: H }, () => new Array<string>(W).fill("."));
  const walk = (node: Group | Leaf, dx: number, dy: number) => {
    if (node.t === "p") {
      for (const [x, y, c] of leafPixels(parts, node)) {
        const X = x + dx;
        const Y = y + dy;
        if (X >= 0 && X < W && Y >= 0 && Y < H) grid[Y]![X] = c;
      }
      return;
    }
    if (node.overlay) return;
    if (node.moods && !node.moods.includes(mood)) return;
    const [rx, ry] = node.rest?.[mood] ?? [0, 0];
    for (const k of node.kids) walk(k, dx + rx, dy + ry);
  };
  walk(SCENE, 0, 0);
  return grid.map((r) => r.join(""));
}

/** the same frame as parts.txt's own `@mood` placement paints it */
export function staticFrame(text: string, parts: Parts, mood: Mood): string[] {
  const grid = Array.from({ length: H }, () => new Array<string>(W).fill("."));
  for (const [, part, ox, oy] of parseParts(text).moods[mood] ?? []) {
    (parts[part] ?? []).forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c !== ".") grid[oy + y]![ox + x] = c;
      });
    });
  }
  return grid.map((r) => r.join(""));
}

export const GAVEL_MOODS = MOODS;

/** the module the Gavel primitive draws from */
export function generate(parts: Parts): string {
  const out: string[] = [];
  const emit = (node: Group | Leaf, depth: number): string[] => {
    const pad = "  ".repeat(depth);
    if (node.t === "p") {
      return rectRuns(leafPixels(parts, node)).map(
        ([x, y, w, c]) => `${pad}[${x}, ${y}, ${w}, ${JSON.stringify(c)}],`,
      );
    }
    const cls = node.cls + (node.overlay ? " gavel-ov" : "");
    const moods = node.moods ? `, moods: ${JSON.stringify(node.moods.join(" "))}` : "";
    return [
      `${pad}{`,
      `${pad}  cls: ${JSON.stringify(cls)}${moods},`,
      `${pad}  kids: [`,
      ...node.kids.flatMap((k) => emit(k, depth + 2)),
      `${pad}  ],`,
      `${pad}},`,
    ];
  };
  for (const k of SCENE.kids) out.push(...emit(k, 1));
  return [
    "// generated by scripts/gavel.ts from parts.txt and anim-parts.txt. edit those, then run",
    "// `node scripts/gavel.ts` in apps/desktop. design.test.ts fails while this is out of date",
    "",
    "/** one run of pixels: x, y and width in art px (1 viewBox unit), and its ink */",
    "export type GavelRect = readonly [x: number, y: number, w: number, ink: GavelInk];",
    `export type GavelInk = ${INKS.map((i) => JSON.stringify(i)).join(" | ")};`,
    "export interface GavelGroup {",
    "  cls: string;",
    "  /** the moods it shows in: absent is every mood */",
    "  moods?: string;",
    "  kids: ReadonlyArray<GavelGroup | GavelRect>;",
    "}",
    "",
    `export const GAVEL_SIZE = { w: ${W}, h: ${H} } as const;`,
    "",
    "export const GAVEL_SCENE: ReadonlyArray<GavelGroup | GavelRect> = [",
    ...out,
    "];",
    "",
  ].join("\n");
}
