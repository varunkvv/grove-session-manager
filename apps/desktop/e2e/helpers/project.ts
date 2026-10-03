// fixture projects for e2e, written with the record's own library so the files are exactly what
// agents write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { comboDirSlug } from "@grove/core";
import { callAsPerson, type OpResult, runTool, syncProject } from "@grove/record";
import type { Fixture } from "./fixture.ts";

// the record honours the GROVE_RECORD_SESSION / _AGENT / _PID overrides only with this set, in
// the process that writes: this one
process.env.GROVE_RECORD_TEST = "1";

/** a fixture write that was refused is a broken test, not something to carry on from */
function must(r: OpResult): OpResult {
  if (!r.ok) throw new Error(r.text);
  return r;
}

/** a combos.json entry, its root, and its project file */
export function writeProject(
  fx: Fixture,
  o: { name: string; prefix: string; goal?: string; folders?: unknown[] },
): { id: string; root: string } {
  const id = comboDirSlug(o.name);
  const root = path.join(fx.root, id);
  mkdirSync(root, { recursive: true });
  must(syncProject(root, { prefix: o.prefix, name: o.name, goal: o.goal ?? "" }));
  const file = path.join(fx.root, "combos.json");
  const combos: unknown[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).combos : [];
  combos.push({
    name: o.name,
    root,
    prefix: o.prefix,
    ...(o.goal ? { note: o.goal } : {}),
    folders: o.folders ?? [],
  });
  writeFileSync(file, JSON.stringify({ combos }, null, 2));
  return { id, root };
}

/** runTool as an agent session. GROVE_RECORD_PID is the test process, so a claim's holder is alive to the record */
export function asAgent(
  fx: Fixture,
  root: string,
  o: { sessionId: string; name: string },
): (tool: string, args: object) => OpResult {
  const env = {
    GROVE_RECORD_TEST: "1",
    GROVE_RECORD_SESSION: o.sessionId,
    GROVE_RECORD_AGENT: o.name,
    GROVE_RECORD_PID: String(process.pid),
    CLAUDE_CONFIG_DIR: fx.claudeDir,
  };
  return (tool, args) => must(runTool(tool, args, { root, env }));
}

export function asPerson(root: string): (tool: string, args: object) => OpResult {
  return (tool, args) => must(callAsPerson(root, tool, args as Record<string, unknown>));
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
