import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { buildMenuTemplate } from "../../src/main/menuTemplate.ts";
import type { MenuCommandId } from "../../src/shared/ipc.ts";

function items(): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  const walk = (list: MenuItemConstructorOptions[]) => {
    for (const item of list) {
      out.push(item);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(buildMenuTemplate({ appName: "Grove", isDev: false, isMac: true, send: () => {} }));
  return out;
}

describe("the menu", () => {
  it("never binds one key twice", () => {
    const keys = items().flatMap((i) => (i.accelerator ? [String(i.accelerator)] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shows cmd-I for the inspector but leaves the key to the page, which toggles it", () => {
    const sent: MenuCommandId[] = [];
    const template = buildMenuTemplate({
      appName: "Grove",
      isDev: false,
      isMac: true,
      send: (id) => sent.push(id),
    });
    const view = template.find((m) => m.label === "View");
    const submenu = (view?.submenu ?? []) as MenuItemConstructorOptions[];
    const inspect = submenu.find((i) => i.label === "Inspect Agents");
    expect(inspect?.accelerator).toBe("CmdOrCtrl+I");
    expect(inspect?.registerAccelerator).toBe(false);
    const click = inspect?.click as (() => void) | undefined;
    click?.();
    expect(sent).toEqual(["inspect"]);
  });
});
