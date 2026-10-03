import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderLauncher } from "@grove/record";
import { describe, expect, it } from "vitest";
import {
  bundleVersionOf,
  installRecordRuntime,
  recordInstallFor,
  recordPaths,
} from "../../src/main/services/recordInstall.ts";

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-install-")));

function setup(sourceVersion = "0.5.3") {
  const appRoot = sandbox();
  const source = path.join(appRoot, "record.src.cjs");
  writeFileSync(source, `// grove-record app=${sourceVersion}\nconsole.log("record");\n`);
  const o = { appRoot, execPath: "/Applications/Grove.app/Contents/MacOS/Grove", source };
  return { o: { ...o, appVersion: sourceVersion }, ...recordPaths(appRoot) };
}

describe("the launcher", () => {
  it("is renderLauncher's text, executable, and never rewritten with equal bytes", async () => {
    const { o, launcher, bundle } = setup();
    const first = await installRecordRuntime(o);
    expect(first).toMatchObject({ launcherChanged: true, bundleChanged: true });
    expect(first.error).toBeUndefined();
    expect(readFileSync(launcher, "utf8")).toBe(renderLauncher({ execPath: o.execPath, bundle }));
    expect(statSync(launcher).mode & 0o777).toBe(0o755);

    const inode = statSync(launcher).ino;
    const second = await installRecordRuntime(o);
    expect(second).toMatchObject({ launcherChanged: false, bundleChanged: false });
    // a new inode costs a few hundred ms on its first exec
    expect(statSync(launcher).ino).toBe(inode);
  });

  it("is rewritten when the app moved, and when it lost its execute bit", async () => {
    const { o, launcher, bundle } = setup();
    await installRecordRuntime(o);
    const moved = { ...o, execPath: "/Users/someone/Applications/Grove.app/Contents/MacOS/Grove" };
    expect((await installRecordRuntime(moved)).launcherChanged).toBe(true);
    expect(readFileSync(launcher, "utf8")).toContain(`G='${moved.execPath}'`);
    expect(readFileSync(launcher, "utf8")).toBe(
      renderLauncher({ execPath: moved.execPath, bundle }),
    );

    chmodSync(launcher, 0o644);
    expect((await installRecordRuntime(moved)).launcherChanged).toBe(true);
    expect(statSync(launcher).mode & 0o100).toBe(0o100);
  });
});

describe("the bundle", () => {
  it("is copied when missing, left when equal", async () => {
    const { o, bundle } = setup();
    expect((await installRecordRuntime(o)).bundleChanged).toBe(true);
    expect(readFileSync(bundle, "utf8")).toBe(readFileSync(o.source, "utf8"));
    const inode = statSync(bundle).ino;
    expect((await installRecordRuntime(o)).bundleChanged).toBe(false);
    expect(statSync(bundle).ino).toBe(inode);
  });

  it("an older one is replaced, a newer one is left for the newer Grove", async () => {
    const { o, bundle } = setup("0.5.3");
    await installRecordRuntime(o);

    writeFileSync(bundle, "// grove-record app=0.5.2\nold\n");
    expect((await installRecordRuntime(o)).bundleChanged).toBe(true);
    expect(readFileSync(bundle, "utf8")).toBe(readFileSync(o.source, "utf8"));

    writeFileSync(bundle, "// grove-record app=0.6.1\nnewer\n");
    const r = await installRecordRuntime(o);
    expect(r).toMatchObject({ bundleChanged: false, newerInstalled: "0.6.1" });
    expect(readFileSync(bundle, "utf8")).toBe("// grove-record app=0.6.1\nnewer\n");
  });

  it("a missing source is an error, not a throw", async () => {
    const { o } = setup();
    const r = await installRecordRuntime({ ...o, source: path.join(o.appRoot, "nope.cjs") });
    expect(r.error).toContain("nope.cjs");
    expect(r.bundleChanged).toBe(false);
  });

  it("the version is read from the banner on the first line only", () => {
    expect(bundleVersionOf('// grove-record app=0.5.12\n"use strict";')).toBe("0.5.12");
    expect(bundleVersionOf(`${"x".repeat(600)}// grove-record app=9.9.9`)).toBeNull();
    expect(bundleVersionOf("no banner")).toBeNull();
  });
});

describe("who installs", () => {
  it("a dev build next to the installed app installs nothing and syncs no record file", () => {
    const appRoot = "/Users/someone/claude-ws";
    expect(recordInstallFor({ isPackaged: false, customRoot: false, appRoot })).toBeUndefined();
    expect(recordInstallFor({ isPackaged: true, customRoot: false, appRoot })).toEqual({
      launcher: "/Users/someone/claude-ws/.grove/bin/record",
    });
    expect(recordInstallFor({ isPackaged: false, customRoot: true, appRoot })?.launcher).toBe(
      "/Users/someone/claude-ws/.grove/bin/record",
    );
  });
});
