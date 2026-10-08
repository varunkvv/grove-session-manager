// fixture projects for e2e: what combos.json and Claude Code's own folders hold when the app starts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { comboDirSlug } from "@grove/core";
import type { Fixture } from "./fixture.ts";

/** a combos.json entry and its root */
export function writeProject(
  fx: Fixture,
  o: { name: string; goal?: string; folders?: unknown[] },
): { id: string; root: string } {
  const id = comboDirSlug(o.name);
  const root = path.join(fx.root, id);
  mkdirSync(root, { recursive: true });
  const file = path.join(fx.root, "combos.json");
  const combos: unknown[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).combos : [];
  combos.push({
    name: o.name,
    root,
    ...(o.goal ? { note: o.goal } : {}),
    folders: o.folders ?? [],
  });
  writeFileSync(file, JSON.stringify({ combos }, null, 2));
  return { id, root };
}

let sessions = 0;
/** <claudeDir>/sessions/<n>.json with pid = the test process, so the app sees a live holder */
export function liveSession(
  fx: Fixture,
  o: {
    sessionId: string;
    kind: "interactive" | "bg";
    entrypoint?: string;
    status?: "busy" | "idle";
  },
): void {
  const dir = path.join(fx.claudeDir, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${++sessions}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: o.sessionId,
      status: o.status ?? "idle",
      kind: o.kind,
      ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
    }),
  );
}

/** <root>/.grove/interrupted.json, before launch: sessions that stopped mid-turn, and when */
export function interrupted(fx: Fixture, ids: Record<string, number>): void {
  const dir = path.join(fx.root, ".grove");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "interrupted.json"),
    JSON.stringify(Object.fromEntries(Object.entries(ids).map(([id, at]) => [id, { at }]))),
  );
}
