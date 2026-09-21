import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { pendingDir, writeIntent } from "@grove/core";
import { describe, expect, it } from "vitest";
import { drainIntents } from "../src/drain.ts";
import { fakeDeps, SID, writeSession } from "./helpers/fakeDeps.ts";

function setup(rootName = "prod-debug") {
  const probe = fakeDeps();
  const root = path.join(probe.base, "ws", rootName);
  mkdirSync(path.join(root, "api"), { recursive: true });
  return { root, base: probe.base };
}

describe("draining resume intents", () => {
  it("an intent for this workspace is claimed, deleted and resumed", async () => {
    const { root } = setup();
    const f = fakeDeps({ root });
    writeSession(f.deps.projectsDir, root, SID.a);
    await writeIntent(f.deps.appRoot, { sessionId: SID.a, cwd: root, prompt: "go" });
    expect(await drainIntents(f.deps, "activation")).toBe("command");
    expect(f.commands[0]!.args).toEqual([SID.a, "go"]);
    expect(readdirSync(pendingDir(f.deps.appRoot))).toEqual([]);
    expect(await drainIntents(f.deps, "activation")).toBeNull();
  });

  it("an intent for another folder is left for its own window", async () => {
    const { root, base } = setup();
    const f = fakeDeps({ root });
    const other = path.join(base, "ws", "prod-debug-2");
    mkdirSync(other, { recursive: true });
    await writeIntent(f.deps.appRoot, { sessionId: SID.a, cwd: other });
    expect(await drainIntents(f.deps, "activation")).toBeNull();
    expect(readdirSync(pendingDir(f.deps.appRoot))).toHaveLength(1);
  });

  it("'inside' matches only on activation. a watcher or focus event takes exact matches only", async () => {
    const { root } = setup();
    const f = fakeDeps({ root });
    writeSession(f.deps.projectsDir, path.join(root, "api"), SID.a);
    await writeIntent(f.deps.appRoot, { sessionId: SID.a, cwd: path.join(root, "api") });
    expect(await drainIntents(f.deps, "watch")).toBeNull();
    expect(await drainIntents(f.deps, "focus")).toBeNull();
    expect(await drainIntents(f.deps, "activation")).toBe("command");
  });

  it("expired intents are ignored", async () => {
    const { root } = setup();
    const f = fakeDeps({ root });
    await writeIntent(f.deps.appRoot, {
      sessionId: SID.a,
      cwd: root,
      issuedAt: Date.now() - 10 * 60_000,
    });
    expect(await drainIntents(f.deps, "activation")).toBeNull();
    expect(f.commands).toEqual([]);
  });

  it("a window with no folder does nothing", async () => {
    const f = fakeDeps({ root: undefined });
    await writeIntent(f.deps.appRoot, { sessionId: SID.a, cwd: "/anything" });
    expect(await drainIntents(f.deps, "activation")).toBeNull();
  });
});
