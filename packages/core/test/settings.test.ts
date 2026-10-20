import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsFilePath, wantsModel } from "../src/settings.ts";
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

  it("judgment day odds has its own switch, off unless true, and it is what wants the model", async () => {
    const root = makeSandbox();
    writeFileSync(settingsFilePath(root), JSON.stringify({ judgmentDayOdds: "yes" }));
    const off = await loadSettings(root);
    expect(off.judgmentDayOdds).toBeUndefined();
    expect(wantsModel(off)).toBe(false);
    const on = await saveSettings(root, { judgmentDayOdds: true });
    expect(on.judgmentDayOdds).toBe(true);
    expect(wantsModel(on)).toBe(true);
  });

  it("the palette is one of the three, absent for anything else", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).palette).toBeUndefined();
    expect((await saveSettings(app, { palette: "rose-pine" })).palette).toBe("rose-pine");
    expect((await loadSettings(app)).palette).toBe("rose-pine");
    expect((await saveSettings(app, { palette: "solarized" })).palette).toBe("solarized");
    writeFileSync(settingsFilePath(app), JSON.stringify({ palette: "dracula" }));
    expect((await loadSettings(app)).palette).toBeUndefined();
  });

  it("the summon key is kept as given, and cleared it is the default again", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).summonKey).toBeUndefined();
    expect((await saveSettings(app, { summonKey: " Control+Alt+K " })).summonKey).toBe(
      "Control+Alt+K",
    );
    expect((await saveSettings(app, { summonKey: "none" })).summonKey).toBe("none");
    expect((await saveSettings(app, { summonKey: "" })).summonKey).toBeUndefined();
    writeFileSync(settingsFilePath(app), JSON.stringify({ summonKey: 7 }));
    expect((await loadSettings(app)).summonKey).toBeUndefined();
  });
});
