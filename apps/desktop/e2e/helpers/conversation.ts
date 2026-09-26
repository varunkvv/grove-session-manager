import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectSlug } from "@grove/core";
import type { Fixture } from "./fixture.ts";

export * as t from "../../../../packages/core/test/helpers/sessionTranscript.ts";

type Line = Record<string, unknown>;

/**
 * lines from the session transcript builders, made this fixture's: its session, its folder, and
 * times moved so the newest line is `endAgoMs` before now. the builders count from a fixed day.
 */
function place(
  lines: object[],
  o: { sessionId: string; cwd: string; endAgoMs: number; shift?: number },
): { lines: Line[]; shift: number; end: number } {
  const stamps = lines.flatMap((l) => {
    const ts = Date.parse(String((l as Line).timestamp ?? ""));
    return Number.isFinite(ts) ? [ts] : [];
  });
  const last = Math.max(...stamps);
  const shift = o.shift ?? Date.now() - o.endAgoMs - last;
  const moved = lines.map((raw) => {
    const l = { ...(raw as Line) };
    if (typeof l.timestamp === "string") {
      l.timestamp = new Date(Date.parse(l.timestamp) + shift).toISOString();
    }
    if (l.type !== "ai-title") {
      if ("sessionId" in l) l.sessionId = o.sessionId;
      if ("cwd" in l) l.cwd = o.cwd;
    } else l.sessionId = o.sessionId;
    return l;
  });
  return { lines: moved, shift, end: last + shift };
}

const fileOf = (fx: Fixture, cwd: string, sessionId: string) =>
  path.join(fx.projectsDir, claudeProjectSlug(cwd), `${sessionId}.jsonl`);

/** a whole session transcript, from the builders in the core tests' helpers */
export function writeConversation(
  fx: Fixture,
  o: { cwd: string; sessionId: string; title: string; lines: object[]; endAgoMs?: number },
): { file: string; shift: number } {
  const placed = place(o.lines, { ...o, endAgoMs: o.endAgoMs ?? 60_000 });
  const rows = [...placed.lines, { type: "ai-title", aiTitle: o.title, sessionId: o.sessionId }];
  const file = fileOf(fx, o.cwd, o.sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const when = new Date(placed.end);
  utimesSync(file, when, when);
  return { file, shift: placed.shift };
}

/** more lines at the end of a session being written, on the same clock as the ones before */
export function appendConversation(
  file: string,
  o: { cwd: string; sessionId: string; shift: number; lines: object[] },
): void {
  const placed = place(o.lines, { ...o, endAgoMs: 0 });
  appendFileSync(file, `${placed.lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
