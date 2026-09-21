import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Combo, ComboFolder, FolderOutcome, FolderStatus } from "@grove/core";
import { describe, expect, it, vi } from "vitest";
import { resolveAssetPath } from "../../src/main/assets.ts";
import { resolveAppEnv, userDataDirFor } from "../../src/main/env.ts";
import { OpQueue } from "../../src/main/opQueue.ts";
import { isTrustedUrl } from "../../src/main/origin.ts";
import { diffRows, PatchCoalescer } from "../../src/main/patchCoalescer.ts";
import { Pusher } from "../../src/main/push.ts";
import { parseDraft } from "../../src/main/services/draft.ts";
import { compareVersions, findBundledCompanion } from "../../src/main/services/editor.ts";
import {
  claudeBinCandidates,
  isResumeScriptName,
  resumeScriptBody,
  resumeScriptPath,
} from "../../src/main/services/resumeScript.ts";
import {
  branchLabelOf,
  buildComboView,
  emptyRuntime,
  folderKey,
  mergeStatus,
  outcomeToast,
  statusFromOutcome,
} from "../../src/main/services/views.ts";
import { clampBounds } from "../../src/main/windowState.ts";

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-main-")));

describe("OpQueue", () => {
  it("a mutate lane of one serialises git work that would otherwise fight over a repo lock", async () => {
    const queue = new OpQueue({ mutate: 1, read: 4 });
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
    };
    await Promise.all([queue.run("mutate", job("a", 20)), queue.run("mutate", job("b", 1))]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("the read lane runs several at once", async () => {
    const queue = new OpQueue({ mutate: 1, read: 4 });
    let peak = 0;
    let live = 0;
    const job = async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 10));
      live--;
    };
    await Promise.all(Array.from({ length: 4 }, () => queue.run("read", job)));
    expect(peak).toBe(4);
  });

  it("a queued job with the same key is absorbed, a running one is not", async () => {
    const queue = new OpQueue({ read: 1 });
    const runs = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const first = queue.run("read", runs, { key: "reconcile" });
    const second = queue.run("read", runs, { key: "reconcile" });
    const third = queue.run("read", runs, { key: "reconcile" });
    expect(second).toBe(third);
    await Promise.all([first, second, third]);
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it("one failure does not take down the lane", async () => {
    const queue = new OpQueue({ mutate: 1 });
    const failed = queue.run("mutate", async () => {
      throw new Error("git said no");
    });
    await expect(failed).rejects.toThrow("git said no");
    await expect(queue.run("mutate", async () => "fine")).resolves.toBe("fine");
    expect(queue.busy("mutate")).toBe(false);
  });

  it("a job that throws synchronously rejects instead of wedging the lane", async () => {
    const queue = new OpQueue({ mutate: 1 });
    await expect(
      queue.run("mutate", (() => {
        throw new Error("boom");
      }) as () => Promise<void>),
    ).rejects.toThrow("boom");
    await expect(queue.onIdle()).resolves.toBeUndefined();
  });
});

describe("PatchCoalescer", () => {
  it("the first change goes out at once and a burst folds into one trailing patch", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const p = new PatchCoalescer<{ key: string; n: number }>({
      intervalMs: 150,
      keyOf: (r) => r.key,
      emit,
      now: () => Date.now(),
    });
    p.upsert([{ key: "a", n: 1 }]);
    expect(emit).toHaveBeenCalledTimes(1);
    p.upsert([{ key: "b", n: 1 }]);
    p.upsert([{ key: "b", n: 2 }]);
    p.upsert([{ key: "c", n: 1 }]);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[1]?.[0]).toEqual({
      upserts: [
        { key: "b", n: 2 },
        { key: "c", n: 1 },
      ],
      removes: [],
      replace: false,
    });
    vi.useRealTimers();
  });

  it("the last word on a key wins inside one patch", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const p = new PatchCoalescer<{ key: string }>({ intervalMs: 50, keyOf: (r) => r.key, emit });
    p.upsert([{ key: "a" }]);
    emit.mockClear();
    p.upsert([{ key: "a" }]);
    p.remove(["a"]);
    vi.advanceTimersByTime(50);
    expect(emit.mock.calls[0]?.[0]).toEqual({ upserts: [], removes: ["a"], replace: false });
    vi.useRealTimers();
  });

  it("diffRows sends only what actually changed", () => {
    const have = new Map([
      ["a", { key: "a", title: "one" }],
      ["b", { key: "b", title: "two" }],
    ]);
    const { upserts, removes } = diffRows(
      have,
      [
        { key: "a", title: "one" },
        { key: "c", title: "new" },
      ],
      (r) => r.key,
    );
    expect(upserts).toEqual([{ key: "c", title: "new" }]);
    expect(removes).toEqual(["b"]);
  });
});

describe("Pusher", () => {
  it("revs rise per domain, and a destroyed window is not written to", () => {
    const sent: Array<[string, unknown]> = [];
    let destroyed = false;
    const pusher = new Pusher(() => ({
      isDestroyed: () => destroyed,
      send: (channel, payload) => sent.push([channel, payload]),
    }));
    expect(pusher.nextRev("sessions")).toBe(1);
    expect(pusher.nextRev("sessions")).toBe(2);
    expect(pusher.nextRev("combos")).toBe(1);
    expect(pusher.currentRevs()).toEqual({ sessions: 2, combos: 1 });
    pusher.send("toast", { level: "info", title: "hi" });
    destroyed = true;
    pusher.send("toast", { level: "info", title: "gone" });
    expect(sent).toEqual([["grove:toast", { level: "info", title: "hi" }]]);
  });
});

describe("what the renderer is allowed to be", () => {
  it("only our own scheme, or the dev server when there is one", () => {
    expect(isTrustedUrl("app://renderer/index.html")).toBe(true);
    expect(isTrustedUrl("app://evil/index.html")).toBe(false);
    expect(isTrustedUrl("https://example.com")).toBe(false);
    expect(isTrustedUrl("file:///etc/passwd")).toBe(false);
    expect(isTrustedUrl(undefined)).toBe(false);
    expect(isTrustedUrl("http://localhost:5183/", "http://localhost:5183")).toBe(true);
    expect(isTrustedUrl("http://localhost:9999/", "http://localhost:5183")).toBe(false);
  });

  it("the asset server stays inside the renderer directory", () => {
    const dir = "/app/out/renderer";
    expect(resolveAssetPath(dir, "/index.html")).toBe("/app/out/renderer/index.html");
    expect(resolveAssetPath(dir, "/")).toBe("/app/out/renderer/index.html");
    expect(resolveAssetPath(dir, "/assets/app.js")).toBe("/app/out/renderer/assets/app.js");
    for (const bad of [
      "/../main/index.cjs",
      "/%2e%2e/main/index.cjs",
      "/assets/../../secret",
      "/a\0b",
    ]) {
      expect(resolveAssetPath(dir, bad), bad).toBeNull();
    }
  });
});

describe("the resume script", () => {
  it("quotes a hostile folder name and refuses anything but a session id", () => {
    const body = resumeScriptBody({
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      cwd: "/tmp/it's here; rm -rf ~",
      claudeBin: "/Users/you/.local/bin/claude",
    });
    expect(body).toBe(
      "#!/bin/zsh\ncd '/tmp/it'\\''s here; rm -rf ~' 2>/dev/null || cd ~\n" +
        "exec '/Users/you/.local/bin/claude' --resume aaaaaaaa-0000-4000-8000-000000000001\n",
    );
    expect(() => resumeScriptBody({ sessionId: "x; rm -rf ~", claudeBin: "claude" })).toThrow();
    expect(() => resumeScriptPath("/state", "../../etc/passwd")).toThrow();
  });

  it("a missing folder still resumes, from home", () => {
    const body = resumeScriptBody({
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      claudeBin: "claude",
    });
    expect(body).toContain("cd ~\nexec claude --resume");
  });

  it("only our own files are swept out of the run directory", () => {
    expect(isResumeScriptName("resume-aaaaaaaa-0000-4000-8000-000000000001.command")).toBe(true);
    expect(isResumeScriptName("something-else.command")).toBe(false);
    expect(isResumeScriptName("resume-x.command")).toBe(false);
  });

  it("a configured claude path is tried first", () => {
    expect(claudeBinCandidates("/Users/you", "/opt/claude")[0]).toBe("/opt/claude");
    expect(claudeBinCandidates("/Users/you")[0]).toBe("/Users/you/.local/bin/claude");
  });
});

describe("drafts from the renderer", () => {
  it("paths are checked, not believed", async () => {
    const dir = sandbox();
    const { draft, problems } = await parseDraft({
      name: " prod-debug ",
      folders: [
        { path: dir, mode: "worktree", branch: { kind: "new", name: "prod-debug" } },
        { path: "relative/path", mode: "reference" },
        { path: path.join(dir, "missing"), mode: "reference" },
        { path: dir, mode: "worktree", branch: { kind: "new", name: "--force" } },
      ],
    });
    expect(draft?.name).toBe("prod-debug");
    // the two folders that exist survive. a branch named "--force" is reported but not silently dropped.
    expect(draft?.folders).toHaveLength(2);
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("absolute path");
    expect(problems.join(" ")).toContain("does not exist");
  });

  it("junk never becomes a combo", async () => {
    for (const junk of [null, 3, "x", {}, { name: "x" }, { folders: [] }]) {
      expect((await parseDraft(junk)).draft).toBeNull();
    }
  });

  it("a worktree with no branch means detached, and a reference never carries one", async () => {
    const dir = sandbox();
    const { draft } = await parseDraft({
      name: "c",
      folders: [
        { path: dir, mode: "worktree" },
        { path: dir, mode: "reference", branch: { kind: "new", name: "x" }, as: "ignored" },
      ],
    });
    expect(draft?.folders[0]?.branch).toEqual({ kind: "detach" });
    expect(draft?.folders[1]?.branch).toBeUndefined();
    expect(draft?.folders[1]?.as).toBeUndefined();
  });
});

describe("combo views", () => {
  const folder = (over: Partial<ComboFolder> = {}): ComboFolder => ({
    path: "/src/api",
    mode: "worktree",
    ...over,
  });
  const combo = (folders: ComboFolder[]): Combo => ({
    name: "prod-debug",
    root: "/ws/prod-debug",
    folders,
  });

  it("nothing is claimed about a combo before its first reconcile", () => {
    const view = buildComboView(
      combo([folder()]),
      undefined,
      "/ws/prod-debug/prod-debug.code-workspace",
    );
    expect(view.status).toBe("unknown");
    expect(view.folders[0]?.state).toBe("unknown");
  });

  it("one repo can be in a combo twice under different names", () => {
    const a = folder({ as: "api" });
    const b = folder({ as: "api-release", branch: { kind: "existing", name: "release" } });
    expect(folderKey(a)).not.toBe(folderKey(b));
    const view = buildComboView(combo([a, b]), emptyRuntime(), "/x");
    expect(view.folders.map((f) => f.dirName)).toEqual(["api", "api-release"]);
  });

  it("a detached worktree shows its commit, a branch shows its short name", () => {
    expect(branchLabelOf({ detached: true, head: "4f2a91c0ffee" })).toBe("detached @4f2a91c");
    expect(branchLabelOf({ branch: "refs/heads/dev/eng-218" })).toBe("dev/eng-218");
    expect(branchLabelOf({})).toBeUndefined();
  });

  it("a reconcile without dirty checks keeps the last answer instead of blinking it off", () => {
    const base: FolderStatus = {
      folder: folder(),
      target: "/ws/prod-debug/api",
      state: "ok",
      branch: "refs/heads/x",
    };
    const prev: FolderStatus = { ...base, dirty: true };
    expect(mergeStatus(prev, base).dirty).toBe(true);
    expect(mergeStatus(prev, { ...base, dirty: false }).dirty).toBe(false);
    // the worktree moved, so what was known about it no longer applies
    expect(mergeStatus(prev, { ...base, state: "stale" }).dirty).toBeUndefined();
  });

  it("a finished git command is enough to draw the row before the reconcile lands", () => {
    const created: FolderOutcome = {
      folder: folder({ branch: { kind: "new", name: "prod-debug" } }),
      target: "/ws/prod-debug/api",
      action: "created",
      state: "ok",
    };
    expect(statusFromOutcome(undefined, created)).toMatchObject({
      state: "ok",
      branch: "prod-debug",
      detached: false,
    });
    const detached: FolderOutcome = { ...created, folder: folder({ branch: { kind: "detach" } }) };
    expect(statusFromOutcome(undefined, detached)).toMatchObject({ detached: true });
  });

  it("only failures core reports instead of throwing become a toast", () => {
    const base: FolderOutcome = {
      folder: folder({ as: "api", branch: { kind: "new", name: "prod-debug" } }),
      target: "/ws/prod-debug/api",
      action: "created",
      state: "ok",
    };
    expect(outcomeToast(base, "create")).toBeNull();
    expect(outcomeToast({ ...base, action: "exists", state: "ok" }, "open")).toBeNull();

    const collision = outcomeToast(
      { ...base, action: "collision", state: "absent", heldBy: "/ws/other/api" },
      "create",
    );
    expect(collision?.title).toBe('api: branch "prod-debug" is already checked out');
    expect(collision?.body).toBe("at /ws/other/api. The rest of the combo was created.");

    const foreign = outcomeToast(
      {
        ...base,
        action: "refused-foreign",
        state: "foreign",
        message: "something else is at that path",
      },
      "open",
    );
    expect(foreign?.body).toContain("left untouched");
    expect(foreign?.body).toContain("The combo opened without it.");
  });
});

describe("the window and the environment", () => {
  it("a saved position on a monitor that is gone comes back onto a real one", () => {
    const displays = [{ x: 0, y: 0, width: 1512, height: 900 }];
    expect(clampBounds({ x: 3000, y: 1200, width: 1180, height: 760 }, displays)).toMatchObject({
      width: 1180,
      height: 760,
    });
    // nothing of it was on a real screen, so the position is dropped and the platform centres it
    expect(clampBounds({ x: 3000, y: 1200, width: 1180, height: 760 }, displays).x).toBeUndefined();
    // a position that is only half off is pulled back rather than thrown away
    const nudged = clampBounds({ x: 1300, y: 100, width: 1180, height: 760 }, displays);
    expect(nudged.x).toBe(1512 - 1180);
    expect(nudged.y).toBe(100);
    // a window bigger than the screen is shrunk, never left off it
    const big = clampBounds({ x: 0, y: 0, width: 4000, height: 3000 }, displays);
    expect(big.width).toBeLessThanOrEqual(1512);
    expect(clampBounds(null, displays)).toMatchObject({ width: 1180, height: 760 });
    expect(clampBounds({ width: "wide" }, displays)).toMatchObject({ width: 1180 });
  });

  it("a test root, a dev build and the installed app never share one instance lock", () => {
    const base = {
      isPackaged: true,
      appData: "/Users/you/Library/Application Support",
      productName: "Grove",
    };
    const custom = resolveAppEnv({ GROVE_ROOT: "/tmp/ws" }, "/Users/you");
    expect(userDataDirFor(custom, base)).toBe("/tmp/ws/.grove/electron");
    const normal = resolveAppEnv({}, "/Users/you");
    expect(userDataDirFor(normal, base)).toBeNull();
    expect(userDataDirFor(normal, { ...base, isPackaged: false })).toBe(
      "/Users/you/Library/Application Support/Grove-dev",
    );
  });

  it("the app root and the projects dir follow the environment", () => {
    expect(resolveAppEnv({}, "/Users/you").appRoot).toBe("/Users/you/claude-ws");
    expect(resolveAppEnv({ GROVE_ROOT: "~/other" }, "/Users/you").appRoot).toBe("/Users/you/other");
    expect(resolveAppEnv({}, "/Users/you").openBin).toBe("/usr/bin/open");
    expect(
      resolveAppEnv({ GROVE_DEV_SERVER_URL: "http://localhost:5183" }, "/Users/you").isDev,
    ).toBe(true);
  });
});

describe("the bundled companion extension", () => {
  it("versions compare by number", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.10.0")).toBe(-1);
  });

  it("a missing bundle is reported rather than guessed at", async () => {
    expect(await findBundledCompanion(["/nope", "/also/nope"])).toBeNull();
  });
});
