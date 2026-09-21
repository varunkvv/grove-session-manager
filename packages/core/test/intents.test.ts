import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionUri,
  installedExtensionVersion,
  resolveEditor,
  runDetached,
} from "../src/editor.ts";
import {
  claimIntent,
  INTENT_TTL_MS,
  intentFileName,
  listIntents,
  matchIntent,
  pendingDir,
  sweepIntents,
  writeIntent,
} from "../src/intents.ts";
import { makeSandbox, SID } from "./helpers/transcript.ts";

describe("resume intents", () => {
  it("write -> list -> claim. one intent per folder, the last click wins", async () => {
    const app = makeSandbox("grove-intent-");
    const cwd = path.join(app, "prod-debug");
    mkdirSync(cwd);
    await writeIntent(app, { sessionId: SID.a, cwd });
    const file = await writeIntent(app, { sessionId: SID.b, cwd, prompt: "continue" });
    expect(path.basename(file)).toBe(intentFileName(cwd));

    const listed = await listIntents(app);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.intent).toMatchObject({
      version: 1,
      sessionId: SID.b,
      cwd,
      prompt: "continue",
    });

    expect(await claimIntent(file)).toMatchObject({ sessionId: SID.b });
    expect(await claimIntent(file)).toBeNull();
    expect(readdirSync(pendingDir(app))).toEqual([]);
  });

  it("two windows racing for one intent: exactly one gets it", async () => {
    const app = makeSandbox("grove-intent-");
    const file = await writeIntent(app, { sessionId: SID.a, cwd: app });
    const results = await Promise.all([claimIntent(file), claimIntent(file), claimIntent(file)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expired, future-dated and junk intents are ignored and swept", async () => {
    const app = makeSandbox("grove-intent-");
    const now = Date.now();
    await writeIntent(app, {
      sessionId: SID.a,
      cwd: path.join(app, "old"),
      issuedAt: now - INTENT_TTL_MS - 1000,
    });
    await writeIntent(app, {
      sessionId: SID.b,
      cwd: path.join(app, "future"),
      issuedAt: now + 3_600_000,
    });
    await writeIntent(app, { sessionId: SID.c, cwd: path.join(app, "live") });
    writeFileSync(path.join(pendingDir(app), "junk.json"), "{ nope");
    writeFileSync(
      path.join(pendingDir(app), "evil.json"),
      JSON.stringify({ sessionId: "x; rm -rf ~", cwd: "/", issuedAt: now }),
    );

    expect((await listIntents(app)).map((i) => i.intent.sessionId)).toEqual([SID.c]);
    expect(await sweepIntents(app)).toBe(4);
    expect(readdirSync(pendingDir(app))).toHaveLength(1);
  });

  it("a session id that is not a uuid is refused at write time", async () => {
    await expect(
      writeIntent(makeSandbox(), { sessionId: "../../etc/passwd", cwd: "/" }),
    ).rejects.toThrow();
  });

  it("matching: exact by folder or workspace file, inside on a component boundary, else nothing", async () => {
    const app = makeSandbox("grove-intent-");
    const root = path.join(app, "prod");
    mkdirSync(path.join(root, "api"), { recursive: true });
    const intent = (cwd: string, workspaceFile?: string) => ({
      version: 1 as const,
      sessionId: SID.a,
      cwd,
      issuedAt: 1,
      workspaceFile,
    });
    expect(matchIntent(intent(root), { root })).toBe("exact");
    expect(matchIntent(intent(path.join(root, "api")), { root })).toBe("inside");
    expect(matchIntent(intent(`${root}-debug`), { root })).toBeNull();
    expect(matchIntent(intent(app), { root })).toBeNull();
    const ws = path.join(root, "prod.code-workspace");
    expect(matchIntent(intent("/elsewhere", ws), { root: "/other", workspaceFile: ws })).toBe(
      "exact",
    );
  });
});

describe("editor handoff", () => {
  it("the documented deep link, with the editor's own scheme", () => {
    expect(buildSessionUri("vscode", SID.a)).toBe(
      `vscode://anthropic.claude-code/open?session=${SID.a}`,
    );
    expect(buildSessionUri("cursor", SID.a, "fix it & ship")).toBe(
      `cursor://anthropic.claude-code/open?session=${SID.a}&prompt=fix+it+%26+ship`,
    );
    expect(() => buildSessionUri("vscode", "nope")).toThrow();
  });

  it("absolute app-bundle paths by default, overridable for cursor and for tests", () => {
    expect(resolveEditor({ editor: "vscode" }, {}).bin).toBe(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    );
    expect(resolveEditor({ editor: "cursor" }, {})).toMatchObject({
      uriScheme: "cursor",
      label: "Cursor",
    });
    expect(resolveEditor({ editor: "vscode", editorBin: "/opt/code" }, {}).bin).toBe("/opt/code");
    expect(resolveEditor({ editor: "vscode" }, { GROVE_EDITOR_BIN: "/tmp/fake" }).bin).toBe(
      "/tmp/fake",
    );
  });

  it("a missing or relative binary is a result, not an exception", async () => {
    expect(await runDetached("code", ["x"])).toMatchObject({
      ok: false,
      error: { code: "not-absolute" },
    });
    expect(await runDetached("/nope/code", ["x"])).toMatchObject({
      ok: false,
      error: { code: "editor-missing" },
    });
  });

  it("installed extensions come from the editor's registry, minus uninstalled leftovers", async () => {
    const dir = makeSandbox("grove-ext-");
    writeFileSync(
      path.join(dir, "extensions.json"),
      JSON.stringify([
        {
          identifier: { id: "Anthropic.claude-code" },
          version: "2.1.276",
          relativeLocation: "anthropic.claude-code-2.1.276",
        },
        {
          identifier: { id: "anthropic.claude-code" },
          version: "2.1.278",
          relativeLocation: "anthropic.claude-code-2.1.278",
        },
        { identifier: { id: "gone.ext" }, version: "1.0.0", relativeLocation: "gone.ext-1.0.0" },
      ]),
    );
    writeFileSync(path.join(dir, ".obsolete"), JSON.stringify({ "gone.ext-1.0.0": true }));
    const editor = { ...resolveEditor({ editor: "vscode" }, {}), extensionsDir: dir };
    expect(await installedExtensionVersion(editor, "anthropic.claude-code")).toBe("2.1.278");
    expect(await installedExtensionVersion(editor, "gone.ext")).toBeNull();
    expect(
      await installedExtensionVersion({ ...editor, extensionsDir: "/nope" }, "x.y"),
    ).toBeNull();
  });
});
