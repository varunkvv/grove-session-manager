import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** no position means "let the window manager centre it" */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export const DEFAULT_SIZE = { width: 1180, height: 760 } as const;
export const MIN_SIZE = { width: 880, height: 520 } as const;

// how much of the window has to be on a display before its saved position is believed.
// enough to grab the title bar with.
const MIN_VISIBLE = { width: 160, height: 80 } as const;

function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (k) => typeof r[k] === "number" && Number.isFinite(r[k]),
  );
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * saved bounds -> bounds that are certainly on a screen that exists now. a monitor that was
 * unplugged, a resolution change, or a junk file all end in a sane window instead of one that
 * opens out of reach. `displays` are work areas, the primary first.
 */
export function clampBounds(saved: unknown, displays: readonly Rect[]): WindowBounds {
  if (!isRect(saved)) return { ...DEFAULT_SIZE };
  const want: Rect = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(MIN_SIZE.width, Math.round(saved.width)),
    height: Math.max(MIN_SIZE.height, Math.round(saved.height)),
  };

  let home: Rect | undefined;
  let best = 0;
  for (const d of displays) {
    const o = overlap(want, d);
    if (o.width < MIN_VISIBLE.width || o.height < MIN_VISIBLE.height) continue;
    if (o.width * o.height > best) {
      best = o.width * o.height;
      home = d;
    }
  }
  if (!home) {
    const primary = displays[0];
    return {
      width: primary ? Math.min(want.width, primary.width) : want.width,
      height: primary ? Math.min(want.height, primary.height) : want.height,
    };
  }

  const width = Math.min(want.width, home.width);
  const height = Math.min(want.height, home.height);
  return {
    x: Math.min(Math.max(want.x, home.x), home.x + home.width - width),
    y: Math.min(Math.max(want.y, home.y), home.y + home.height - height),
    width,
    height,
  };
}

export async function loadWindowState(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** sync on purpose: the last save happens while the window is closing */
export function saveWindowState(file: string, bounds: Rect): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(bounds));
  } catch {
    // losing the window position is never worth an error
  }
}
