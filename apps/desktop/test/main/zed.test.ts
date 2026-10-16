import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Settings, stripJsonc } from "@grove/core";
import { describe, expect, it } from "vitest";
import { EditorService } from "../../src/main/services/editor.ts";
import {
  registeredZedAgent,
  upsertZedAgentServer,
  writeZedAgentServer,
} from "../../src/main/services/zed.ts";

// a real one, as zed wrote it and a person then edited it: header comments, trailing commas
const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "../fixtures/zed-settings.json"),
  "utf8",
);
const ENTRY = {
  command: "/Applications/Grove.app/Contents/MacOS/Grove",
  args: ["/Applications/Grove.app/Contents/Resources/acp-proxy/grove-acp.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1", GROVE_ROOT: "/Users/you/claude-ws" },
};
const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-zed-")));
const parse = (text: string) => JSON.parse(stripJsonc(text));

describe("grove's entry in zed's settings.json", () => {
  it("is added, and the person's comments and other agents stay as they were", () => {
    const out = upsertZedAgentServer(FIXTURE, ENTRY);
    expect(out.startsWith("// Zed settings\n//\n// For information on how to configure Zed")).toBe(
      true,
    );
    expect(out).toContain('"claude-acp"');
    expect(out).toContain('"model": "haiku"');
    const parsed = parse(out);
    expect(parsed.agent_servers["Claude (with Grove)"]).toEqual({ type: "custom", ...ENTRY });
    expect(parsed.agent_servers["claude-acp"]).toEqual({
      default_config_options: { model: "haiku" },
      type: "registry",
    });
    expect(parsed.session.trust_all_worktrees).toBe(true);
    // nothing outside agent_servers moved
    expect(out.slice(out.indexOf('"ui_font_size"'))).toBe(
      FIXTURE.slice(FIXTURE.indexOf('"ui_font_size"')),
    );
  });

  it("twice is the same as once", () => {
    const once = upsertZedAgentServer(FIXTURE, ENTRY);
    expect(upsertZedAgentServer(once, ENTRY)).toBe(once);
  });

  it("a moved proxy replaces the old path, and only that", () => {
    const once = upsertZedAgentServer(FIXTURE, ENTRY);
    const moved = upsertZedAgentServer(once, { ...ENTRY, args: ["/src/grove/grove-acp.cjs"] });
    expect(parse(moved).agent_servers["Claude (with Grove)"].args).toEqual([
      "/src/grove/grove-acp.cjs",
    ]);
    expect(moved.replace("/src/grove/grove-acp.cjs", ENTRY.args[0]!)).toBe(once);
  });

  it("an empty or missing file gets a file with just the entry", () => {
    for (const text of ["", "\n"]) {
      expect(
        parse(upsertZedAgentServer(text, ENTRY)).agent_servers["Claude (with Grove)"].type,
      ).toBe("custom");
    }
  });

  it("reads back what runs the proxy it registered, and nothing from a file without one", async () => {
    const dir = sandbox();
    const file = path.join(dir, "settings.json");
    expect(await registeredZedAgent(file)).toBeNull();
    writeFileSync(file, "{ not json");
    expect(await registeredZedAgent(file)).toBeNull();
    writeFileSync(file, FIXTURE);
    expect(await registeredZedAgent(file)).toBeNull();
    await writeZedAgentServer(file, ENTRY);
    expect(await registeredZedAgent(file)).toEqual({
      command: ENTRY.command,
      proxy: ENTRY.args[0],
    });
  });

  it("keeps the file as private as it was, and makes a new one private", async () => {
    const dir = sandbox();
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o600);
    await writeZedAgentServer(file, ENTRY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const fresh = path.join(dir, "fresh", "settings.json");
    await writeZedAgentServer(fresh, ENTRY);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("an unparseable file is left alone", async () => {
    const file = path.join(sandbox(), "settings.json");
    writeFileSync(file, "{ not json");
    await expect(writeZedAgentServer(file, ENTRY)).rejects.toMatchObject({
      code: "zed-settings-invalid",
    });
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("the editor service, with zed as the editor", () => {
  it("missing, then ok once installed, out of date for another proxy, unavailable without one", async () => {
    const dir = sandbox();
    const zedDir = path.join(dir, "zed");
    mkdirSync(zedDir);
    writeFileSync(path.join(zedDir, "settings.json"), FIXTURE);
    const bin = path.join(dir, "cli");
    writeFileSync(bin, "");
    const proxy = path.join(dir, "grove-acp.cjs");
    writeFileSync(proxy, "");
    // stands in for the Grove binary
    const grove = path.join(dir, "Grove");
    writeFileSync(grove, "");
    // never the real ~/.config/zed: extensionsDir is where zed's settings.json is looked for
    const settings: Settings = {
      editor: "zed",
      appearance: "system",
      editorBin: bin,
      extensionsDir: zedDir,
    };
    const service = (proxyFile: string | null, executable = grove) =>
      new EditorService(settings, [], proxyFile, "/Users/you/claude-ws", executable);

    const editor = service(proxy);
    expect(await editor.status(true)).toMatchObject({ id: "zed", companionState: "missing" });
    expect(await editor.companionInstalled()).toBe(false);
    await editor.installCompanion();
    const status = await editor.status();
    expect(status).toMatchObject({
      companionState: "ok",
      companionVersion: proxy,
      bundledCompanionVersion: proxy,
    });
    expect(await editor.companionInstalled()).toBe(true);
    const entry = parse(readFileSync(path.join(zedDir, "settings.json"), "utf8")).agent_servers[
      "Claude (with Grove)"
    ];
    // grove's own binary as node: zed's PATH may have no node, as on a Dock-launched zed
    expect(entry).toEqual({
      type: "custom",
      command: grove,
      args: [proxy],
      env: { ELECTRON_RUN_AS_NODE: "1", GROVE_ROOT: "/Users/you/claude-ws" },
    });

    const elsewhere = path.join(dir, "other.cjs");
    writeFileSync(elsewhere, "");
    expect((await service(elsewhere).status(true)).companionState).toBe("outdated");
    // another app's binary, an older grove's
    expect((await service(proxy, path.join(dir, "Other")).status(true)).companionState).toBe(
      "outdated",
    );
    // what 0.18.30 wrote, and what a person may have put there by hand
    for (const command of ["node", "/Users/you/.asdf/installs/nodejs/24.13.1/bin/node"]) {
      const file = path.join(zedDir, "settings.json");
      writeFileSync(
        file,
        upsertZedAgentServer(readFileSync(file, "utf8"), { ...entry, command, env: {} }),
      );
      expect((await service(proxy).status(true)).companionState).toBe("outdated");
    }
    await service(proxy).installCompanion();
    expect((await service(proxy).status(true)).companionState).toBe("ok");
    expect((await service(null).status(true)).companionState).toBe("unavailable");
    await expect(service(null).installCompanion()).rejects.toMatchObject({ code: "no-proxy" });
  });
});
