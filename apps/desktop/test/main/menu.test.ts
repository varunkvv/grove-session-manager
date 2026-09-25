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
    const inspect = submenu.find((i) => i.label === "Session Pane");
    expect(inspect?.accelerator).toBe("CmdOrCtrl+I");
    expect(inspect?.registerAccelerator).toBe(false);
    const click = inspect?.click as (() => void) | undefined;
    click?.();
    expect(sent).toEqual(["inspect"]);
    // the inbox is the next free number, and 1-3 keep what they meant
    const inbox = submenu.find((i) => i.label === "Inbox");
    expect(inbox?.accelerator).toBe("CmdOrCtrl+4");
    (inbox?.click as (() => void) | undefined)?.();
    expect(sent).toEqual(["inspect", "scope-inbox"]);
    const turns = submenu.find((i) => i.label === "Go to Turn…");
    expect(turns?.accelerator).toBe("CmdOrCtrl+J");
    expect(turns?.registerAccelerator).toBe(false);
  });

  it("shows cmd-G for the next match and leaves it to the page: a step taken twice skips one", () => {
    const edit = buildMenuTemplate({
      appName: "Grove",
      isDev: false,
      isMac: true,
      send: () => {},
    }).find((m) => m.label === "Edit");
    const submenu = (edit?.submenu ?? []) as MenuItemConstructorOptions[];
    const next = submenu.find((i) => i.label === "Find Next");
    const previous = submenu.find((i) => i.label === "Find Previous");
    expect(next?.accelerator).toBe("CmdOrCtrl+G");
    expect(previous?.accelerator).toBe("CmdOrCtrl+Shift+G");
    expect(next?.registerAccelerator).toBe(false);
    expect(previous?.registerAccelerator).toBe(false);
  });

  it("cmd-T starts a new session, from the File menu", () => {
    const sent: MenuCommandId[] = [];
    const template = buildMenuTemplate({
      appName: "Grove",
      isDev: false,
      isMac: true,
      send: (id) => sent.push(id),
    });
    const file = template.find((m) => m.label === "File");
    const item = ((file?.submenu ?? []) as MenuItemConstructorOptions[]).find(
      (i) => i.accelerator === "CmdOrCtrl+T",
    );
    expect(item?.label).toBe("New Session…");
    (item?.click as (() => void) | undefined)?.();
    expect(sent).toEqual(["new-session"]);
  });
});
