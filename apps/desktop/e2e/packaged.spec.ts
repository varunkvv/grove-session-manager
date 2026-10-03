// the built .app, not the out/ bundles. opt-in: `pnpm app:package` first.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron, expect, test } from "@playwright/test";
import { makeFixture } from "./helpers/fixture.ts";
import { writeProject } from "./helpers/project.ts";

const APP = path.join(import.meta.dirname, "../dist/mac-arm64/Grove.app");
const EXECUTABLE = path.join(APP, "Contents/MacOS/Grove");
// a variable, so tsc does not look for types of an .mjs it cannot check
const fuses = pathToFileURL(path.join(import.meta.dirname, "../scripts/fuses.mjs")).href;

test.skip(!existsSync(EXECUTABLE), "run `pnpm app:package` first");

test("the packaged binary still runs as node, which is how every session reaches the record", async () => {
  const { readFuses } = await import(fuses);
  const wires = readFuses(
    readFileSync(
      path.join(APP, "Contents/Frameworks/Electron Framework.framework/Electron Framework"),
    ),
  );
  expect(wires.length).toBeGreaterThan(0);
  for (const w of wires) expect(w.fuses.RunAsNode).toBe("ENABLE");
});

test("the packaged app opens, installs the record from its asar and carries the companion extension", async () => {
  const fx = makeFixture({ withCompanion: true });
  const { id } = writeProject(fx, { name: "toy", prefix: "TOY", goal: "Ship the toy" });

  const app = await _electron.launch({
    executablePath: EXECUTABLE,
    env: {
      // the fixture's, so nothing a home-relative path names is the real one
      HOME: fx.dir,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GROVE_ROOT: fx.root,
      CLAUDE_CONFIG_DIR: fx.claudeDir,
      GROVE_EDITOR_BIN: fx.fakeCode,
      GROVE_OPEN_BIN: fx.fakeOpen,
      GROVE_EXTENSIONS_DIR: fx.extensionsDir,
      GROVE_FAKE_LOG: fx.execLog,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId("app-ready").waitFor({ timeout: 45_000 });

    // the self-check talks to the server through the launcher: the bundle was read out of the
    // asar, copied next to the launcher, and run on the packaged binary as node
    const server = () =>
      page.evaluate(
        async (project) =>
          (await window.grove.bootstrap()).projects.find((p) => p.id === project)?.server,
        id,
      );
    await expect.poll(async () => (await server())?.state, { timeout: 30_000 }).toBe("ok");
    expect(await server()).toMatchObject({ state: "ok", tools: 14 });
    const bin = path.join(fx.root, ".grove", "bin");
    expect(readFileSync(path.join(bin, "record"), "utf8")).toContain(EXECUTABLE);
    expect(readFileSync(path.join(bin, "record.cjs"), "utf8")).toMatch(/^\/\/ grove-record app=\d/);

    // extraResources sits outside the asar, and the app has to be able to find it from inside
    expect(existsSync(path.join(APP, "Contents/Resources/extension/grove-companion.vsix"))).toBe(
      true,
    );
    const status = await page.evaluate(() => window.grove.editorStatus(true));
    expect(status.bundledCompanionVersion).not.toBeNull();
    expect(status.companionState).toBe("ok");
  } finally {
    await app.close().catch(() => {});
  }
});
