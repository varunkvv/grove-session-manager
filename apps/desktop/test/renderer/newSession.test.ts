import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHOICES,
  loadChoices,
  longWorkHint,
  longWorkOptions,
  primaryLabel,
  promptHint,
  saveChoices,
  settingsNote,
} from "../../src/renderer/logic/newSession.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("what the new-session dialog remembers", () => {
  it("the last choice of every field, per combo", () => {
    const store = memory();
    const picked = {
      where: "background",
      longWork: "foreground",
      model: "haiku",
      mode: "plan",
      effort: "low",
    } as const;
    saveChoices(store, "ops", picked);
    expect(loadChoices(store, "ops")).toEqual(picked);
    expect(loadChoices(store, "docs")).toEqual(DEFAULT_CHOICES);
  });

  it("the editor and every Default is where a combo starts", () => {
    expect(DEFAULT_CHOICES).toEqual({
      where: "editor",
      longWork: "combo",
      model: "",
      mode: "",
      effort: "",
    });
  });

  it("anything unreadable, or no longer on a list, is the default for that field alone", () => {
    const store = memory();
    store.map.set(
      "grove.newSession.ops",
      JSON.stringify({ where: "terminal", model: "gpt-9", mode: "dontAsk", effort: "max" }),
    );
    expect(loadChoices(store, "ops")).toEqual({
      ...DEFAULT_CHOICES,
      where: "terminal",
      effort: "max",
    });
    store.map.set("grove.newSession.ops", "{ nope");
    expect(loadChoices(store, "ops")).toEqual(DEFAULT_CHOICES);
    store.map.set("grove.newSession.ops", "null");
    expect(loadChoices(store, "ops")).toEqual(DEFAULT_CHOICES);
  });

  it("storage that throws, or is not there, never breaks the dialog", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadChoices(throwing, "ops")).toEqual(DEFAULT_CHOICES);
    expect(() => saveChoices(throwing, "ops", DEFAULT_CHOICES)).not.toThrow();
    expect(loadChoices(null, "ops")).toEqual(DEFAULT_CHOICES);
    expect(() => saveChoices(null, "ops", DEFAULT_CHOICES)).not.toThrow();
  });
});

describe("what the dialog says", () => {
  it("the button says what happens", () => {
    expect(primaryLabel("editor", "VS Code")).toBe("Open in VS Code");
    expect(primaryLabel("editor", "Cursor")).toBe("Open in Cursor");
    expect(primaryLabel("terminal", "VS Code")).toBe("Open in Terminal");
    expect(primaryLabel("background", "VS Code")).toBe("Start in background");
  });

  it("the prompt hint says whether it is sent, and whether it is needed", () => {
    expect(promptHint("editor")).toMatch(/^Optional\..*input box/);
    expect(promptHint("terminal")).toMatch(/^Optional\..*first message/);
    expect(promptHint("background")).not.toMatch(/Optional/);
  });

  it("haiku in plan mode says that it plans with Sonnet. nothing else gets a note", () => {
    expect(settingsNote({ model: "haiku", mode: "plan" })).toMatch(/plans with Sonnet/);
    expect(settingsNote({ model: "haiku", mode: "" })).toBeNull();
    expect(settingsNote({ model: "sonnet", mode: "plan" })).toBeNull();
    expect(settingsNote({ model: "", mode: "plan" })).toBeNull();
  });

  it("the combo default names what the combo says now", () => {
    expect(longWorkOptions("background")[0]?.label).toBe("Combo default (in the background)");
    expect(longWorkOptions("foreground")[0]?.label).toBe(
      "Combo default (here, in the conversation)",
    );
    expect(longWorkOptions("background").map((o) => o.value)).toEqual([
      "combo",
      "background",
      "foreground",
    ]);
  });

  it("an override says where it goes: on the prompt for the editor, the system prompt for the CLI", () => {
    expect(longWorkHint("editor", "foreground")).toMatch(/first line/);
    expect(longWorkHint("terminal", "foreground")).toMatch(/system prompt/);
    expect(longWorkHint("background", "background")).toMatch(/system prompt/);
    expect(longWorkHint("editor", "combo")).toMatch(/long-work\.md/);
  });
});
