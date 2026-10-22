// the viewer's Open: a file of the window's session, in the app the Mac opens it with. through
// main's ipc as a chat window calls it, with electron's shell stood in for
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  openPath: vi.fn(async (_file: string) => ""),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      fake.handlers.set(name, fn),
  },
  shell: { openPath: fake.openPath },
}));

import { type Deps, registerIpc } from "../../src/main/ipc.ts";

const SID = "ffffffff-0000-4000-8000-000000000001";
const sender = {};
const event = { sender, senderFrame: { url: "app://renderer/index.html" } };
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-open-")));
const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-open-out-")));
writeFileSync(path.join(dir, "shot.png"), "x");
writeFileSync(path.join(outside, "secret.png"), "x");

// a session made in a chat window, with its window open: its folder is the one it may show
registerIpc({
  env: {},
  sessions: { byId: () => [] },
  combos: { list: () => [] },
  chatWindows: {
    has: (id: string) => id === SID,
    sessionOf: (s: unknown) => (s === sender ? SID : undefined),
  },
  fresh: new Map([[SID, { where: { cwd: dir, dirs: [] } }]]),
} as unknown as Deps);

const open = (file: unknown) => fake.handlers.get("grove:chatOpenFile")?.(event, file);

describe("Open in the viewer", () => {
  beforeEach(() => {
    fake.openPath.mockClear();
  });

  it("hands a file of the session's to the Mac, as it really is", async () => {
    expect(await open(path.join(dir, "shot.png"))).toEqual({ ok: true, value: undefined });
    expect(fake.openPath).toHaveBeenCalledWith(path.join(dir, "shot.png"));
    // the same file by a way round
    expect(await open(path.join(dir, "..", path.basename(dir), "shot.png"))).toMatchObject({
      ok: true,
    });
    expect(fake.openPath).toHaveBeenLastCalledWith(path.join(dir, "shot.png"));
  });

  it("opens nothing outside the session's folders", async () => {
    for (const file of [
      path.join(outside, "secret.png"),
      `${dir}/../${path.basename(outside)}/secret.png`,
      "shot.png",
      path.join(dir, "missing.png"),
      42,
    ]) {
      expect(await open(file), String(file)).toMatchObject({
        ok: false,
        error: { code: "not-allowed" },
      });
    }
    expect(fake.openPath).not.toHaveBeenCalled();
  });

  it("says what the Mac said when it could not open it", async () => {
    fake.openPath.mockResolvedValueOnce("No application knows how to open it.");
    expect(await open(path.join(dir, "shot.png"))).toEqual({
      ok: false,
      error: { code: "open-failed", message: "No application knows how to open it." },
    });
  });
});
