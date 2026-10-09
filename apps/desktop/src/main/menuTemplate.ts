// the menu as data. no electron import, so the accelerators can be checked in a unit test.
import { KIND_WORD } from "@grove/core";
import type { MenuItemConstructorOptions } from "electron";
import type { InboxView, LandingTarget, MenuCommandId } from "../shared/ipc.ts";

export interface MenuTemplateOptions {
  appName: string;
  /** VS Code or Cursor */
  editorLabel: string;
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
      command("New Project…", "CmdOrCtrl+N", "new-project"),
      command(`Open Project in ${o.editorLabel}`, "CmdOrCtrl+O", "open-project"),
      command("Edit Project…", "CmdOrCtrl+E", "edit-project"),
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
      command("All Sessions", "CmdOrCtrl+1", "go-inbox"),
      command("Project Sessions", "CmdOrCtrl+2", "go-sessions"),
      separator,
      // the page owns cmd-K, so it works while a field has focus. a toggle the page and the menu
      // both acted on would open the palette and close it again
      command("Go to…", "CmdOrCtrl+K", "palette", { registerAccelerator: false }),
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

export interface TrayActions {
  land: (target: LandingTarget) => void;
  showMain: () => void;
}

/** one line, cut with an ellipsis. not squash: the two spaces after the kind word are on purpose */
function line(s: string, max: number): string {
  const flat = s.replace(/\s*[\r\n\t]\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** the menu bar item's menu: the three newest inbox rows across every project, then Open Grove and Quit */
export function trayTemplate(inbox: InboxView, a: TrayActions): MenuItemConstructorOptions[] {
  const rows = inbox.rows.slice(0, 3).map(
    (r): MenuItemConstructorOptions => ({
      label: line(`${KIND_WORD[r.kind]}  ${r.title}`, 60),
      sublabel: line(r.summary ? `${r.where} · ${r.summary}` : r.where, 80),
      // its row, with its panel open
      click: () => a.land({ view: "inbox", session: r.sessionId }),
    }),
  );
  return [
    ...(rows.length > 0 ? rows : [{ label: "Nothing needs you", enabled: false }]),
    { type: "separator" },
    { label: "Open Grove", click: a.showMain },
    { role: "quit" },
  ];
}
