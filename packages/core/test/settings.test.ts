import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsFilePath } from "../src/settings.ts";
import { makeSandbox } from "./helpers/transcript.ts";

describe("settings", () => {
  it("zed is an editor: it round-trips through the file", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await saveSettings(app, { editor: "zed" })).editor).toBe("zed");
    expect(JSON.parse(readFileSync(settingsFilePath(app), "utf8")).editor).toBe("zed");
    expect((await loadSettings(app)).editor).toBe("zed");
  });

  it("an editor grove does not know is VS Code", async () => {
    const app = makeSandbox("grove-settings-");
    writeFileSync(settingsFilePath(app), JSON.stringify({ editor: "emacs" }));
    expect((await loadSettings(app)).editor).toBe("vscode");
  });

  it("grove chat is off unless it is true", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).chat).toBeUndefined();
    writeFileSync(settingsFilePath(app), JSON.stringify({ chat: "yes" }));
    expect((await loadSettings(app)).chat).toBeUndefined();
    expect((await saveSettings(app, { chat: true })).chat).toBe(true);
    expect((await loadSettings(app)).chat).toBe(true);
  });
});
