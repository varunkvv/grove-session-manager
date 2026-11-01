import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsFilePath } from "../src/settings.ts";
import { stepTextScale, TEXT_SCALES } from "../src/textScale.ts";
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

  it("the palette is one of the three, absent for anything else", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).palette).toBeUndefined();
    expect((await saveSettings(app, { palette: "rose-pine" })).palette).toBe("rose-pine");
    expect((await loadSettings(app)).palette).toBe("rose-pine");
    expect((await saveSettings(app, { palette: "solarized" })).palette).toBe("solarized");
    writeFileSync(settingsFilePath(app), JSON.stringify({ palette: "dracula" }));
    expect((await loadSettings(app)).palette).toBeUndefined();
  });

  it("what the Usage screen shows is one of the two, absent for anything else", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).usageMode).toBeUndefined();
    expect((await saveSettings(app, { usageMode: "actual" })).usageMode).toBe("actual");
    expect((await loadSettings(app)).usageMode).toBe("actual");
    expect((await saveSettings(app, { usageMode: "api-equivalent" })).usageMode).toBe(
      "api-equivalent",
    );
    writeFileSync(settingsFilePath(app), JSON.stringify({ usageMode: "both" }));
    expect((await loadSettings(app)).usageMode).toBeUndefined();
  });

  it("the text size is one of its steps, absent for 100 and for anything else", async () => {
    const app = makeSandbox("grove-settings-");
    expect((await loadSettings(app)).textScale).toBeUndefined();
    for (const step of [90, 110, 120, 135, 150] as const) {
      expect((await saveSettings(app, { textScale: step })).textScale).toBe(step);
      expect((await loadSettings(app)).textScale).toBe(step);
    }
    // the default, written or not, reads as no setting
    writeFileSync(settingsFilePath(app), JSON.stringify({ textScale: 100 }));
    expect((await loadSettings(app)).textScale).toBeUndefined();
    for (const bad of [125, "120", 1.2, null]) {
      writeFileSync(settingsFilePath(app), JSON.stringify({ textScale: bad }));
      expect((await loadSettings(app)).textScale).toBeUndefined();
    }
    // saved back to 100 the key goes
    await saveSettings(app, { textScale: 120 });
    expect((await saveSettings(app, { textScale: undefined })).textScale).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsFilePath(app), "utf8"))).not.toHaveProperty("textScale");
  });

  it("a text size step goes one up or down, stays at either end, and 0 is back to 100", () => {
    expect(stepTextScale(undefined, 1)).toBe(110);
    expect(stepTextScale(100, -1)).toBe(90);
    expect(stepTextScale(120, 1)).toBe(135);
    expect(stepTextScale(135, -1)).toBe(120);
    expect(stepTextScale(150, 1)).toBe(150);
    expect(stepTextScale(90, -1)).toBe(90);
    expect(stepTextScale(150, 0)).toBe(100);
    expect(stepTextScale(90, 0)).toBe(100);
    // a size that is no step is taken as 100
    expect(stepTextScale(125, 1)).toBe(110);
    expect(TEXT_SCALES).toEqual([90, 100, 110, 120, 135, 150]);
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
