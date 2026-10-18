import { describe, expect, it } from "vitest";
import { acceleratorOf, keyLabel } from "../../src/renderer/logic/keys.ts";

const press = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>,
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("the summon key", () => {
  it("is written down the way electron and the mac each name it", () => {
    expect(acceleratorOf(press("KeyG", { ctrlKey: true, altKey: true, metaKey: true }))).toBe(
      "Control+Alt+Command+G",
    );
    expect(keyLabel("Control+Alt+Command+G")).toBe("⌃⌥⌘G");
    expect(acceleratorOf(press("Space", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+Space");
    expect(acceleratorOf(press("F5", { metaKey: true }))).toBe("Command+F5");
  });

  it("takes no key without ctrl, opt or cmd, and no modifier on its own", () => {
    expect(acceleratorOf(press("KeyG", {}))).toBeNull();
    expect(acceleratorOf(press("KeyG", { shiftKey: true }))).toBeNull();
    expect(acceleratorOf(press("MetaLeft", { metaKey: true }))).toBeNull();
  });
});
