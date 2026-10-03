import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComboSyncReport } from "@grove/core";
import { renderLauncher, syncProject } from "@grove/record";
import { describe, expect, it } from "vitest";
import { configProblem, ServerChecks, talkToServer } from "../../src/main/services/serverCheck.ts";

const sandbox = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "grove-check-")));
const recordSource = path.resolve(import.meta.dirname, "../../../../packages/record/src/bin.ts");

/** a stand-in bundle that speaks just enough MCP. `mode` picks how it misbehaves */
const fakeBundle = (mode: "ok" | "silent" | "notools") => `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined || ${JSON.stringify(mode)} === "silent") return;
  const result =
    m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
    : m.method === "tools/list" ? { tools: ${mode === "notools" ? '[{ name: "other" }]' : '[{ name: "record_state" }, { name: "my_cards" }]'} }
    : { content: [{ type: "text", text: "# record" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

/** the launcher grove writes, pointing at this node and at `bundle` */
function setup(bundle?: string) {
  const dir = sandbox();
  const launcher = path.join(dir, "record");
  const target = bundle ?? path.join(dir, "record.cjs");
  writeFileSync(launcher, renderLauncher({ execPath: process.execPath, bundle: target }), {
    mode: 0o755,
  });
  const root = path.join(dir, "project");
  return { dir, launcher, bundle: target, root };
}

const report = (r: Partial<ComboSyncReport>): ComboSyncReport => ({
  root: "/p",
  settings: "unchanged",
  mcp: "unchanged",
  warnings: [],
  shadowed: [],
  ...r,
});

describe("talking to the real record server through the launcher", () => {
  it("a project with its project file is ok", async () => {
    const { launcher, root } = setup(recordSource);
    expect(syncProject(root, { prefix: "TOY", name: "toy", goal: "ship it" }).ok).toBe(true);
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0" });
    expect(r).toMatchObject({ state: "ok", tools: 14 });
  });

  it("a folder with no project file answers initialize and tools/list, then fails record_state", async () => {
    const { launcher, root } = setup(recordSource);
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0" });
    expect(r.state === "failed" && r.stage).toBe("record_state");
    expect(r.state === "failed" && r.message).toMatch(
      /^The record server cannot read this project: record unavailable: .+\.$/,
    );
  });
});

describe("the ways a check fails", () => {
  it("a server that never answers times out", async () => {
    const { launcher, bundle, root } = setup();
    writeFileSync(bundle, fakeBundle("silent"));
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0", timeoutMs: 400 });
    expect(r).toMatchObject({
      state: "failed",
      stage: "initialize",
      message: "The record server did not answer: no answer in 400ms.",
    });
  });

  it("a server that dies says so with the end of its stderr, from the start of a line", async () => {
    const { launcher, bundle, root } = setup();
    writeFileSync(
      bundle,
      `for (let i = 0; i < 40; i++) console.error("line " + i + " of a long stack trace"); process.exit(3);`,
    );
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0" });
    expect(r).toMatchObject({ state: "failed", stage: "initialize" });
    const detail = (r.state === "failed" && r.detail) || "";
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.split("\n").every((l) => /^line \d+ of a long stack trace$/.test(l))).toBe(true);
    expect(detail.endsWith("line 39 of a long stack trace")).toBe(true);
  });

  it("a server without record_state", async () => {
    const { launcher, bundle, root } = setup();
    writeFileSync(bundle, fakeBundle("notools"));
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0" });
    expect(r).toMatchObject({
      state: "failed",
      stage: "tools/list",
      message: "The record server answered without its tools.",
    });
  });

  it("a missing launcher cannot start", async () => {
    const { launcher, root } = setup();
    rmSync(launcher);
    const r = await talkToServer({ launcher, root, appVersion: "0.5.0" });
    expect(r.state === "failed" && r.stage).toBe("spawn");
    expect(r.state === "failed" && r.message).toMatch(
      /^The record server could not start: .*ENOENT/,
    );
  });

  it("the config stage reads the statuses, not only the warnings", () => {
    expect(configProblem(report({}))).toBeUndefined();
    expect(configProblem(report({ disabled: true }))).toBe(
      "the grove server is turned off for this project in .claude/settings.local.json",
    );
    expect(
      configProblem(report({ warnings: [{ code: "mcp-invalid-json", message: "bad json." }] })),
    ).toBe("bad json.");
    expect(configProblem(report({ mcp: "skipped-unexpected-shape" }))).toBe(
      "/p/.mcp.json is not an object with an mcpServers object, so the grove server was not added.",
    );
    expect(configProblem(report({ settings: "skipped-unexpected-shape" }))).toBe(
      "/p/.claude/settings.local.json is not an object with a hooks object, so the grove server was not turned on.",
    );
    // a missing root is not a config problem. the project view says it on its own
    expect(configProblem(report({ skipped: "no-root", disabled: true }))).toBeUndefined();
  });
});

describe("ServerChecks", () => {
  it("a missing bundle is put back once, then the check passes", async () => {
    const { launcher, bundle, root } = setup();
    let repairs = 0;
    const checks = new ServerChecks({
      launcher,
      bundle,
      appVersion: "0.5.0",
      report: () => undefined,
      repair: async () => {
        repairs++;
        writeFileSync(bundle, fakeBundle("ok"));
      },
    });
    const r = await checks.run({ name: "toy", root, folders: [] });
    expect(r).toMatchObject({ state: "ok", tools: 2 });
    expect(repairs).toBe(1);
    expect(checks.results.get(root)).toBe(r);
  });

  it("a broken server with both files in place is reported, not repaired", async () => {
    const { launcher, bundle, root } = setup();
    writeFileSync(bundle, fakeBundle("notools"));
    let repairs = 0;
    const checks = new ServerChecks({
      launcher,
      bundle,
      appVersion: "0.5.0",
      report: () => undefined,
      repair: async () => {
        repairs++;
      },
    });
    expect((await checks.run({ name: "toy", root, folders: [] })).state).toBe("failed");
    expect(repairs).toBe(0);
  });

  it("a config problem is reported without starting the server, as stage config", async () => {
    const { launcher, bundle, root } = setup();
    const seen: string[] = [];
    const checks = new ServerChecks({
      launcher,
      bundle,
      appVersion: "0.5.0",
      report: (r) => report({ root: r, disabled: true }),
      // the bundle is missing too: a config failure never repairs
      repair: async () => {
        seen.push("repair");
      },
      onResult: (combo, check) => seen.push(`${combo.name}:${check.state}`),
    });
    const r = await checks.run({ name: "toy", root, folders: [] });
    expect(r).toMatchObject({
      state: "failed",
      stage: "config",
      message: "the grove server is turned off for this project in .claude/settings.local.json",
    });
    expect(seen).toEqual(["toy:failed"]);
  });
});
