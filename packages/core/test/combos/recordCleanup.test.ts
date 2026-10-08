import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderClaudeMdStub, renderLongTaskAgent } from "../../src/combos/claudeMd.ts";
import {
  recordPrefixes,
  removeRecordRuntime,
  withoutRecord,
} from "../../src/combos/recordCleanup.ts";
import { syncComboFiles } from "../../src/combos/sync.ts";
import type { Combo } from "../../src/types.ts";
import { makeSandbox } from "../helpers/transcript.ts";

// a project exactly as grove 0.10 made and synced it, captured from 0.10's own code before it left
// the repo (artifacts/core-workflow/capture-0.10-fixtures.ts in the chat-features combo). its
// paths are under /Users/you/claude-ws
const FIXTURE = path.join(import.meta.dirname, "../fixtures/record-0.10");
const THEN = "/Users/you/claude-ws";

/** every file under a folder, with its bytes and when it was last written */
function snapshot(dir: string): Record<string, { text: string; mtimeMs: number }> {
  const out: Record<string, { text: string; mtimeMs: number }> = {};
  for (const name of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const file = path.join(dir, name);
    const s = statSync(file);
    if (s.isFile()) out[name] = { text: readFileSync(file, "utf8"), mtimeMs: s.mtimeMs };
  }
  return out;
}

/** the 0.10 project in a temp app root, with a card and a conclusion an agent wrote */
function project() {
  const appRoot = path.join(makeSandbox("grove-cleanup-"), "claude-ws");
  const root = path.join(appRoot, "auth-sso");
  cpSync(FIXTURE, root, { recursive: true });
  // the paths 0.10 wrote are this machine's
  for (const [name, { text }] of Object.entries(snapshot(root))) {
    writeFileSync(path.join(root, name), text.replaceAll(THEN, appRoot));
  }
  mkdirSync(path.join(root, "cards", "AUTH-1"), { recursive: true });
  writeFileSync(path.join(root, "cards", "AUTH-1", "card.md"), "# Point staging at okta\n");
  mkdirSync(path.join(root, "conclusions"));
  writeFileSync(path.join(root, "conclusions", "D-1.md"), "one okta app per environment\n");
  const combo: Combo = { name: "auth-sso", root, note: "SSO for the dashboard", folders: [] };
  const file = (name: string) => path.join(root, name);
  const read = (name: string) => readFileSync(file(name), "utf8");
  const json = (name: string) => JSON.parse(read(name));
  const clean = () => syncComboFiles(appRoot, combo, { cleanRecord: true });
  return { appRoot, root, combo, file, read, json, clean };
}

describe("a project as 0.10 left it", () => {
  it("loses exactly what 0.10 put in, and a second run changes nothing", async () => {
    const p = project();
    const before = snapshot(p.root);
    const statusHooks = p.json(".claude/settings.local.json").hooks;
    delete statusHooks.SessionStart;

    const report = await p.clean();
    expect(report).toMatchObject({ settings: "written", warnings: [] });
    expect(report.cleaned.sort()).toEqual([
      ".claude/agents/long-task.md",
      ".claude/rules/grove-record.md",
      ".mcp.json",
      "CLAUDE.md",
    ]);

    // the server, which was all there was in the file grove made
    expect(existsSync(p.file(".mcp.json"))).toBe(false);
    // the rules, and the folder that held nothing else
    expect(existsSync(p.file(".claude/rules"))).toBe(false);
    // the hook, the server's name and the two allow rules. the status hooks are what is left
    expect(p.json(".claude/settings.local.json")).toEqual({ hooks: statusHooks });
    expect(Object.keys(statusHooks)).toHaveLength(9);
    expect(p.read(".claude/settings.local.json")).not.toMatch(/grove-record|bin\/record|mcp__/);
    // what a new project gets today, byte for byte
    expect(p.read("CLAUDE.md")).toBe(renderClaudeMdStub(p.combo));
    expect(p.read(".claude/agents/long-task.md")).toBe(renderLongTaskAgent(p.combo));
    for (const name of ["CLAUDE.md", ".claude/agents/long-task.md"]) {
      expect(p.read(name), name).not.toMatch(/record_state|conclusion_record|comment_add|card/i);
    }

    // the person's: their cards and conclusions, the project file, the long-work policy
    const after = snapshot(p.root);
    for (const name of [
      "cards/AUTH-1/card.md",
      "conclusions/D-1.md",
      ".claude/grove-project.json",
      ".claude/long-work.md",
    ]) {
      expect(after[name], name).toEqual(before[name]);
    }
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter((n) => n !== ".mcp.json" && n !== ".claude/rules/grove-record.md")
        .sort(),
    );

    // again: nothing to take out, and not one file written
    expect(await p.clean()).toMatchObject({ settings: "unchanged", cleaned: [], warnings: [] });
    expect(snapshot(p.root)).toEqual(after);
  });

  it("keeps every key, rule, hook and line that is the person's", async () => {
    const p = project();
    const settings = p.json(".claude/settings.local.json");
    const mine = { hooks: [{ type: "command", command: "say hello" }] };
    settings.hooks.SessionStart.unshift(mine);
    settings.hooks.PreToolUse = [mine];
    settings.enabledMcpjsonServers.unshift("linear");
    settings.disabledMcpjsonServers = ["grove"];
    settings.permissions.allow.push("Bash(pnpm test:*)", "mcp__linear");
    settings.permissions.deny = ["Bash(rm -rf:*)"];
    settings.model = "opus";
    // tabs, and no newline at the end: a hand-kept file
    writeFileSync(p.file(".claude/settings.local.json"), JSON.stringify(settings, null, "\t"));
    const mcp = p.json(".mcp.json");
    mcp.mcpServers.linear = { command: "npx", args: ["linear-mcp"] };
    mcp.note = "mine";
    writeFileSync(p.file(".mcp.json"), `${JSON.stringify(mcp, null, 4)}\n`);
    writeFileSync(p.file(".claude/rules/style.md"), "lowercase everything\n");
    // the stub was edited above and below the paragraph grove wrote, and one agent line reworded
    const md = `${p.read("CLAUDE.md").replace("# auth-sso", "# auth-sso (okta)")}\n## Mine\n\nnotes\n`;
    writeFileSync(p.file("CLAUDE.md"), md);
    const agent = p
      .read(".claude/agents/long-task.md")
      .replace("- call `record_state`. work under", "- first call `record_state`. work under");
    writeFileSync(p.file(".claude/agents/long-task.md"), agent);

    const report = await p.clean();
    expect(report.cleaned.sort()).toEqual([
      ".claude/agents/long-task.md",
      ".claude/rules/grove-record.md",
      ".mcp.json",
      "CLAUDE.md",
    ]);

    delete settings.hooks.SessionStart;
    expect(p.json(".claude/settings.local.json")).toEqual({
      ...settings,
      hooks: { ...settings.hooks, SessionStart: [mine] },
      enabledMcpjsonServers: ["linear"],
      permissions: { allow: ["Bash(pnpm test:*)", "mcp__linear"], deny: ["Bash(rm -rf:*)"] },
    });
    // its key order and its indentation are the file's own
    const text = p.read(".claude/settings.local.json");
    expect(text).toMatch(/^\{\n\t"hooks": \{\n\t\t"UserPromptSubmit"/);
    expect(text.endsWith("}")).toBe(true);
    expect(Object.keys(p.json(".claude/settings.local.json"))).toEqual(
      Object.keys(settings).filter(Boolean),
    );

    expect(p.read(".mcp.json")).toBe(
      `${JSON.stringify({ mcpServers: { linear: mcp.mcpServers.linear }, note: "mine" }, null, 4)}\n`,
    );
    expect(readdirSync(p.file(".claude/rules"))).toEqual(["style.md"]);
    const cleaned = p.read("CLAUDE.md");
    expect(cleaned.startsWith("# auth-sso (okta)\n")).toBe(true);
    expect(cleaned.endsWith("\n## Mine\n\nnotes\n")).toBe(true);
    expect(cleaned).toContain("The files in `context/` are the only\nmemory you have in common.");
    expect(cleaned).not.toContain("record_state");
    // the line that was reworded is the person's now. the two still grove's are swapped
    const kept = p.read(".claude/agents/long-task.md");
    expect(kept).toContain("- first call `record_state`. work under");
    expect(kept).toContain("- remove your entry from `context/in-progress.md`");
    expect(kept).not.toMatch(/conclusion_record|comment_add/);

    const after = snapshot(p.root);
    expect(await p.clean()).toMatchObject({ settings: "unchanged", cleaned: [] });
    expect(snapshot(p.root)).toEqual(after);
  });

  it("a server the person called grove is theirs, with its name and its tool rule", async () => {
    const p = project();
    const own = { mcpServers: { grove: { command: "/usr/local/bin/grove-notes", args: [] } } };
    writeFileSync(p.file(".mcp.json"), JSON.stringify(own));
    const before = statSync(p.file(".mcp.json")).mtimeMs;

    expect((await p.clean()).cleaned).not.toContain(".mcp.json");
    expect(p.json(".mcp.json")).toEqual(own);
    expect(statSync(p.file(".mcp.json")).mtimeMs).toBe(before);
    const settings = p.json(".claude/settings.local.json");
    expect(settings.enabledMcpjsonServers).toEqual(["grove"]);
    // 0.10's launcher rule and hook go either way
    expect(settings.permissions).toEqual({ allow: ["mcp__grove"] });
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it("is left alone by a build that does not own the projects", async () => {
    const p = project();
    const before = snapshot(p.root);
    expect(await syncComboFiles(p.appRoot, p.combo)).toMatchObject({
      settings: "unchanged",
      cleaned: [],
    });
    expect(snapshot(p.root)).toEqual(before);
  });
});

describe("a project with nothing of the record in it", () => {
  it("cleaned by hand already, or made by 0.11: nothing is written", async () => {
    const p = project();
    await p.clean();
    // by hand: an empty servers list was left behind, and the person's own files
    writeFileSync(p.file(".mcp.json"), '{ "mcpServers": {} }\n');
    const before = snapshot(p.root);
    expect(await p.clean()).toMatchObject({ settings: "unchanged", cleaned: [], warnings: [] });
    expect(snapshot(p.root)).toEqual(before);
  });

  it("a file that is not JSON is never rewritten, and a folder that is gone is not made again", async () => {
    const p = project();
    writeFileSync(p.file(".mcp.json"), "{ half written");
    writeFileSync(p.file(".claude/settings.local.json"), "{ half written");
    const report = await p.clean();
    expect(report.settings).toBe("skipped-invalid-json");
    expect(report.warnings).toHaveLength(1);
    expect(report.cleaned).not.toContain(".mcp.json");
    expect(p.read(".mcp.json")).toBe("{ half written");
    expect(p.read(".claude/settings.local.json")).toBe("{ half written");

    const gone: Combo = { name: "gone", root: path.join(p.appRoot, "gone"), folders: [] };
    expect(await syncComboFiles(p.appRoot, gone, { cleanRecord: true })).toMatchObject({
      skipped: "no-root",
      cleaned: [],
    });
    expect(existsSync(gone.root)).toBe(false);
  });
});

describe("the settings without the record", () => {
  it("leaves shapes it does not know as they are", () => {
    for (const odd of [
      {},
      { hooks: "none" },
      { hooks: { SessionStart: "x", Stop: [] } },
      { enabledMcpjsonServers: "grove" },
      { permissions: { allow: "mcp__grove" } },
      { permissions: "all" },
    ]) {
      expect(withoutRecord(odd), JSON.stringify(odd)).toEqual(odd);
    }
  });

  it("a list or an object that only held grove's goes with it", () => {
    expect(
      withoutRecord({
        enabledMcpjsonServers: ["grove"],
        permissions: { allow: ["mcp__grove", "Bash(/x/.grove/bin/record:*)"] },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "'/x' state # grove-record" }] }],
        },
      }),
    ).toEqual({ hooks: {} });
  });
});

describe("the record's runtime", () => {
  it("the launcher and the bundle go, with their folder when nothing else is in it", async () => {
    const appRoot = makeSandbox("grove-runtime-");
    const bin = path.join(appRoot, ".grove", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "record"), "#!/bin/sh\n");
    writeFileSync(path.join(bin, "record.cjs"), "// grove-record app=0.10.17\n");
    writeFileSync(path.join(appRoot, ".grove", "live-status.json"), "{}");

    expect(await removeRecordRuntime(appRoot)).toEqual([
      path.join(bin, "record"),
      path.join(bin, "record.cjs"),
    ]);
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(path.join(appRoot, ".grove", "live-status.json"))).toBe(true);
    expect(await removeRecordRuntime(appRoot)).toEqual([]);

    // something else in it: that stays, and so does the folder
    mkdirSync(bin);
    writeFileSync(path.join(bin, "record"), "#!/bin/sh\n");
    writeFileSync(path.join(bin, "mine"), "x");
    await removeRecordRuntime(appRoot);
    expect(readdirSync(bin)).toEqual(["mine"]);
  });
});

describe("where 0.10's dismissals move to", () => {
  it("each card prefix to its project's id, from combos.json or the project file", async () => {
    const p = project();
    const combos: Combo[] = [
      // 0.10 wrote the prefix into combos.json
      { name: "Billing export", root: "/ws/billing-export", prefix: "BILL", folders: [] },
      // not there: the project file in the folder has it
      p.combo,
      { name: "new in 0.11", root: "/ws/fresh", folders: [] },
      // its prefix is its own id: nothing to move
      { name: "same", root: "/ws/SAME", prefix: "SAME", folders: [] },
      // its prefix is another project's id: its keys cannot be told from that project's
      { name: "clash", root: "/ws/clash", prefix: "fresh", folders: [] },
    ];
    expect([...(await recordPrefixes(combos))]).toEqual([
      ["BILL", "billing-export"],
      ["AUTH", "auth-sso"],
    ]);
  });
});
