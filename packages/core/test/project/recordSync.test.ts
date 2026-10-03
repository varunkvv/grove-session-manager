import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  allowRules,
  callAsPerson,
  HOOK_MARKER,
  hookGroup,
  mcpServerEntry,
  RULES_FILE,
  readProject,
  renderRules,
} from "@grove/record";
import { describe, expect, it } from "vitest";
import { prepareComboOpen } from "../../src/combos/prepare.ts";
import { stringifyLike } from "../../src/fsx.ts";
import { getStateDir } from "../../src/paths.ts";
import {
  findShadowingServers,
  type RecordInstall,
  syncComboFiles,
  syncComboSettings,
  syncMcpJson,
  withRecordHook,
} from "../../src/project/recordSync.ts";
import {
  statusEventsDir,
  statusHookCommand,
  withStatusHooks,
} from "../../src/sessions/liveStatus.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

function setup(folders: Combo["folders"] = []) {
  const appRoot = path.join(makeSandbox("grove-recsync-"), "claude-ws");
  const root = path.join(appRoot, "auth-sso");
  mkdirSync(root, { recursive: true });
  const combo: Combo = { name: "auth-sso", root, note: "ship sso", folders };
  const install: RecordInstall = { launcher: path.join(appRoot, ".grove", "bin", "record") };
  const file = {
    mcp: path.join(root, ".mcp.json"),
    settings: path.join(root, ".claude", "settings.local.json"),
    rules: path.join(root, RULES_FILE),
    project: path.join(root, ".claude", "grove-project.json"),
  };
  const statusHooks = withStatusHooks({}, statusHookCommand(statusEventsDir(getStateDir(appRoot))));
  const group = hookGroup({ launcher: install.launcher, root });
  return { appRoot, root, combo, install, file, statusHooks, group };
}

const read = (f: string) => readFileSync(f, "utf8");
const json = (f: string) => JSON.parse(read(f));
const write = (f: string, text: string) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
const mtimes = (files: string[]) => files.map((f) => statSync(f).mtimeMs);

describe(".mcp.json", () => {
  it("missing: grove's entry alone, 2 spaces and a newline", async () => {
    const { combo, install, file, root } = setup();
    expect(await syncMcpJson(combo, install)).toEqual({ status: "created" });
    expect(read(file.mcp)).toBe(
      stringifyLike({
        mcpServers: { grove: mcpServerEntry({ launcher: install.launcher, root }) },
      }),
    );
  });

  it("invalid JSON and an unexpected shape are left alone", async () => {
    const { combo, install, file } = setup();
    write(file.mcp, "{ nope");
    const r = await syncMcpJson(combo, install);
    expect(r.status).toBe("skipped-invalid-json");
    expect(r.warning?.message).toBe(
      `${file.mcp} is not valid JSON, so the grove server was not added.`,
    );
    expect(read(file.mcp)).toBe("{ nope");
    for (const text of ['{"mcpServers": []}', "[]", '{"other": 1}']) {
      write(file.mcp, text);
      expect((await syncMcpJson(combo, install)).status, text).toBe("skipped-unexpected-shape");
      expect(read(file.mcp)).toBe(text);
    }
  });

  it("keeps someone else's servers, keys and indent, replaces a stale grove entry, then stops writing", async () => {
    const { combo, install, file, root } = setup();
    const theirs = { command: "npx", args: ["their-server"] };
    const before = {
      first: true,
      mcpServers: { theirs, grove: { command: "/old/.grove/bin/record", args: ["mcp"] } },
      last: 1,
    };
    write(file.mcp, `${JSON.stringify(before, null, 4)}\n`);
    expect((await syncMcpJson(combo, install)).status).toBe("written");
    const entry = mcpServerEntry({ launcher: install.launcher, root });
    expect(read(file.mcp)).toBe(
      `${JSON.stringify({ ...before, mcpServers: { theirs, grove: entry } }, null, 4)}\n`,
    );
    const [m] = mtimes([file.mcp]);
    expect((await syncMcpJson(combo, install)).status).toBe("unchanged");
    expect(mtimes([file.mcp])).toEqual([m]);
  });
});

describe("settings.local.json", () => {
  it("withRecordHook and withStatusHooks each leave the other's groups alone", () => {
    const { group, appRoot } = setup();
    const cmd = statusHookCommand(statusEventsDir(getStateDir(appRoot)));
    const status = { hooks: [{ type: "command", command: cmd }] };
    const person = { hooks: [{ type: "command", command: "echo hi" }] };
    const oldRecord = { hooks: [{ type: "command", command: `old state ${HOOK_MARKER}` }] };
    const hooks = {
      SessionStart: [status, oldRecord, person],
      Stop: [oldRecord],
    };
    expect(withRecordHook(hooks, group)).toEqual({ SessionStart: [status, person, group] });
    const both = withRecordHook(hooks, group);
    const again = withStatusHooks(both, cmd);
    expect(again.SessionStart).toEqual([person, group]);
    expect(withRecordHook(again, group)).toEqual(again);
  });

  it("a missing file gets the status hooks and the record's keys in one write", async () => {
    const { appRoot, combo, install, file, statusHooks, group } = setup();
    expect(await syncComboSettings(appRoot, combo, install)).toEqual({ status: "created" });
    expect(read(file.settings)).toBe(
      stringifyLike({
        hooks: { ...statusHooks, SessionStart: [group] },
        enabledMcpjsonServers: ["grove"],
        permissions: { allow: allowRules(install.launcher) },
      }),
    );
    const settings = json(file.settings);
    // no matcher, no async: the form checked in a vs code tab, and a hook whose stdout reaches the model
    expect(settings.hooks.SessionStart).toEqual([group]);
    expect(Object.keys(settings.hooks.SessionStart[0])).toEqual(["hooks"]);
    const [m] = mtimes([file.settings]);
    expect((await syncComboSettings(appRoot, combo, install)).status).toBe("unchanged");
    expect(mtimes([file.settings])).toEqual([m]);
  });

  it("keeps the person's entries in place and removes only an old launcher's rule", async () => {
    const { appRoot, combo, install, file, statusHooks, group } = setup();
    const before = {
      model: "opus",
      enabledMcpjsonServers: ["linear"],
      permissions: {
        allow: ["Bash(git:*)", "Bash(/Old/Place/.grove/bin/record:*)", "mcp__grove", "Read"],
        deny: ["Bash(rm:*)"],
      },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    write(file.settings, `${JSON.stringify(before, null, 2)}\n`);
    expect((await syncComboSettings(appRoot, combo, install)).status).toBe("written");
    expect(json(file.settings)).toEqual({
      model: "opus",
      enabledMcpjsonServers: ["linear", "grove"],
      permissions: {
        allow: ["Bash(git:*)", "mcp__grove", "Read", allowRules(install.launcher)[1]],
        deny: ["Bash(rm:*)"],
      },
      hooks: { ...statusHooks, SessionStart: [...before.hooks.SessionStart, group] },
    });
    expect((await syncComboSettings(appRoot, combo, install)).status).toBe("unchanged");
  });

  it("the person turned grove off: both lists left alone, and said on every run", async () => {
    const { appRoot, combo, install, file } = setup();
    write(
      file.settings,
      JSON.stringify({ enabledMcpjsonServers: ["linear"], disabledMcpjsonServers: ["grove"] }),
    );
    const r = await syncComboSettings(appRoot, combo, install);
    expect(r).toEqual({ status: "written", disabled: true });
    const s = json(file.settings);
    expect(s.enabledMcpjsonServers).toEqual(["linear"]);
    expect(s.disabledMcpjsonServers).toEqual(["grove"]);
    expect(await syncComboSettings(appRoot, combo, install)).toEqual({
      status: "unchanged",
      disabled: true,
    });
  });

  it("a malformed allow or server list is left alone with a warning, the rest still syncs", async () => {
    const { appRoot, combo, install, file, group } = setup();
    write(
      file.settings,
      JSON.stringify({ enabledMcpjsonServers: "grove", permissions: { allow: "everything" } }),
    );
    const r = await syncComboSettings(appRoot, combo, install);
    expect(r.status).toBe("written");
    expect(r.warning?.message).toContain("enabledMcpjsonServers");
    expect(r.warning?.message).toContain("permissions.allow");
    const s = json(file.settings);
    expect(s.enabledMcpjsonServers).toBe("grove");
    expect(s.permissions).toEqual({ allow: "everything" });
    expect(s.hooks.SessionStart).toEqual([group]);
  });

  it("invalid JSON and an unexpected shape are left alone, as the status sync does", async () => {
    const { appRoot, combo, install, file } = setup();
    write(file.settings, "{ nope");
    const r = await syncComboSettings(appRoot, combo, install);
    expect(r.status).toBe("skipped-invalid-json");
    expect(r.warning?.code).toBe("settings-invalid-json");
    write(file.settings, '{"hooks": []}');
    expect((await syncComboSettings(appRoot, combo, install)).status).toBe(
      "skipped-unexpected-shape",
    );
    expect(read(file.settings)).toBe('{"hooks": []}');
  });
});

describe("syncComboFiles", () => {
  it("writes the four files from the package's renderers, then nothing on a second run", async () => {
    const { appRoot, combo, install, file, root } = setup();
    const r = await syncComboFiles(appRoot, combo, "AUTH", install);
    expect(r).toEqual({
      root,
      settings: "created",
      mcp: "created",
      rules: "written",
      project: "written",
      warnings: [],
      shadowed: [],
    });
    expect(read(file.rules)).toBe(
      renderRules({ launcher: install.launcher, prefix: "AUTH", root }),
    );
    expect(readProject(root)).toMatchObject({
      name: "auth-sso",
      prefix: "AUTH",
      goal: "ship sso",
      rev: 1,
    });
    expect(existsSync(path.join(root, ".claude", "long-work.md"))).toBe(true);

    const all = [file.mcp, file.settings, file.rules, file.project];
    const before = mtimes(all);
    expect(await syncComboFiles(appRoot, combo, "AUTH", install)).toEqual({
      root,
      settings: "unchanged",
      mcp: "unchanged",
      rules: "unchanged",
      project: "unchanged",
      warnings: [],
      shadowed: [],
    });
    expect(mtimes(all)).toEqual(before);
  });

  it("puts back a hand-edited rules file and bumps rev once per real change", async () => {
    const { appRoot, combo, install, file, root } = setup();
    await syncComboFiles(appRoot, combo, "AUTH", install);
    writeFileSync(file.rules, "my own rules\n");
    expect((await syncComboFiles(appRoot, combo, "AUTH", install)).rules).toBe("written");
    expect(read(file.rules)).toBe(
      renderRules({ launcher: install.launcher, prefix: "AUTH", root }),
    );

    const edited = { ...combo, note: "ship sso to everyone" };
    expect((await syncComboFiles(appRoot, edited, "AUTH", install)).project).toBe("written");
    expect(readProject(root)).toMatchObject({ goal: "ship sso to everyone", rev: 2 });
    expect((await syncComboFiles(appRoot, edited, "AUTH", install)).project).toBe("unchanged");
    expect(readProject(root)?.rev).toBe(2);
  });

  it("a prefix change refused by the record is reported, not forced", async () => {
    const { appRoot, combo, install, root } = setup();
    await syncComboFiles(appRoot, combo, "AUTH", install);
    expect(callAsPerson(root, "card_create", { title: "first card" }).ok).toBe(true);
    const r = await syncComboFiles(appRoot, combo, "SSO", install);
    expect(r.project).toBe("failed");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.message).toContain("prefix cannot change");
    expect(readProject(root)?.prefix).toBe("AUTH");
  });

  it("reports the server turned off and the .mcp.json warning", async () => {
    const { appRoot, combo, install, file } = setup();
    write(file.settings, JSON.stringify({ disabledMcpjsonServers: ["grove"] }));
    write(file.mcp, "{ nope");
    const r = await syncComboFiles(appRoot, combo, "AUTH", install);
    expect(r.disabled).toBe(true);
    expect(r.mcp).toBe("skipped-invalid-json");
    expect(r.warnings.map((w) => w.code)).toEqual(["mcp-invalid-json"]);
  });

  it("a missing root writes nothing, not even the root", async () => {
    const { appRoot, combo, install, root } = setup();
    const gone = { ...combo, root: path.join(root, "..", "deleted") };
    expect(await syncComboFiles(appRoot, gone, "AUTH", install)).toEqual({
      root: gone.root,
      skipped: "no-root",
      settings: "unchanged",
      warnings: [],
      shadowed: [],
    });
    expect(existsSync(gone.root)).toBe(false);
  });

  it("with no install (the extension, a dev build) only the status hooks and long work are written", async () => {
    const { appRoot, combo, file, statusHooks } = setup();
    const r = await syncComboFiles(appRoot, combo, "AUTH", undefined);
    expect(r.settings).toBe("created");
    expect(json(file.settings)).toEqual({ hooks: statusHooks });
    for (const f of [file.mcp, file.rules, file.project]) expect(existsSync(f), f).toBe(false);
  });
});

describe("findShadowingServers", () => {
  it("lists working copies whose own .mcp.json declares grove", async () => {
    const { appRoot, combo, install, root } = setup([
      { path: "/src/api", mode: "worktree" },
      { path: "/src/web", mode: "worktree", as: "site" },
      { path: "/src/cli", mode: "worktree" },
      { path: "/src/docs", mode: "reference" },
    ]);
    write(path.join(root, "api", ".mcp.json"), JSON.stringify({ mcpServers: { grove: {} } }));
    write(path.join(root, "site", ".mcp.json"), JSON.stringify({ mcpServers: { other: {} } }));
    write(path.join(root, "cli", ".mcp.json"), "{ nope");
    expect(await findShadowingServers(combo)).toEqual([path.join(root, "api")]);
    expect((await syncComboFiles(appRoot, combo, "AUTH", install)).shadowed).toEqual([
      path.join(root, "api"),
    ]);
  });
});

describe("prepareComboOpen", () => {
  it("writes the record's files when the app passes record, and not otherwise", async () => {
    const { appRoot, combo, install, file } = setup();
    await prepareComboOpen(appRoot, combo);
    expect(existsSync(file.mcp)).toBe(false);
    const r = await prepareComboOpen(appRoot, combo, { record: { install, prefix: "AUTH" } });
    expect(r.warnings).toEqual([]);
    for (const f of [file.mcp, file.rules, file.project]) expect(existsSync(f), f).toBe(true);
  });
});
