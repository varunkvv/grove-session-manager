// the menu as data. no electron import, so the accelerators can be checked in a unit test.
import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";

export interface MenuTemplateOptions {
  appName: string;
  isDev: boolean;
  isMac: boolean;
  send: (id: MenuCommandId) => void;
}

/**
 * accelerators live here and not in the page, so they work wherever DOM focus is.
 * there is no reload in production: Cmd+R belongs to Refresh.
 */
export function buildMenuTemplate(o: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const command = (
    label: string,
    accelerator: string,
    id: MenuCommandId,
    extra: Partial<MenuItemConstructorOptions> = {},
  ): MenuItemConstructorOptions => ({ label, accelerator, click: () => o.send(id), ...extra });
  const separator: MenuItemConstructorOptions = { type: "separator" };
  const settings = command("Settings…", "CmdOrCtrl+,", "settings");

  const appMenu: MenuItemConstructorOptions = {
    label: o.appName,
    submenu: [
      { role: "about" },
      separator,
      settings,
      separator,
      { role: "services" },
      separator,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      separator,
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      command("New Combo…", "CmdOrCtrl+N", "new-combo"),
      command("Open Combo in Editor", "CmdOrCtrl+O", "open-combo"),
      separator,
      command("Edit Combo…", "CmdOrCtrl+E", "edit-combo"),
      command("Repair Combo", "CmdOrCtrl+Shift+R", "repair-combo"),
      ...(o.isMac ? [] : [separator, settings, separator, { role: "quit" } as const]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      separator,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      separator,
      command("Find", "CmdOrCtrl+F", "focus-search"),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      command("This Combo's Sessions", "CmdOrCtrl+1", "scope-combo"),
      command("All Sessions", "CmdOrCtrl+2", "scope-all"),
      command("Agents", "CmdOrCtrl+3", "scope-agents"),
      separator,
      // a toggle needs exactly one owner. the page takes the key already, and a press both the
      // page and the menu acted on would open the pane and close it again.
      command("Inspect Agents", "CmdOrCtrl+I", "inspect", { registerAccelerator: false }),
      separator,
      command("Refresh", "CmdOrCtrl+R", "refresh"),
      ...(o.isDev
        ? [
            separator,
            { role: "reload", accelerator: "CmdOrCtrl+Alt+R" } as const,
            { role: "toggleDevTools" } as const,
          ]
        : []),
    ],
  };

  return [...(o.isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, { role: "windowMenu" }];
}
