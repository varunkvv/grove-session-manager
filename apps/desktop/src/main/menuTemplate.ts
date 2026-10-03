// the menu as data. no electron import, so the accelerators can be checked in a unit test.
import { KIND_WORD } from "@grove/core";
import type { MenuItemConstructorOptions } from "electron";
import type { InboxView, LandingTarget, MenuCommandId } from "../shared/ipc.ts";

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
      command("New Session…", "CmdOrCtrl+T", "new-session"),
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
      // stepping is not idempotent: a press both the page and the menu acted on would step twice
      command("Find Next", "CmdOrCtrl+G", "find-next", { registerAccelerator: false }),
      command("Find Previous", "CmdOrCtrl+Shift+G", "find-previous", {
        registerAccelerator: false,
      }),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      command("This Combo's Sessions", "CmdOrCtrl+1", "scope-combo"),
      command("All Sessions", "CmdOrCtrl+2", "scope-all"),
      command("Agents", "CmdOrCtrl+3", "scope-agents"),
      command("Inbox", "CmdOrCtrl+4", "scope-inbox"),
      separator,
      // a toggle needs exactly one owner. the page takes the key already, and a press both the
      // page and the menu acted on would open the pane and close it again.
      command("Session Pane", "CmdOrCtrl+I", "inspect", { registerAccelerator: false }),
      command("Go to Turn…", "CmdOrCtrl+J", "turns", { registerAccelerator: false }),
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

export interface TrayActions {
  land: (target: LandingTarget) => void;
  showMain: () => void;
}

/** one line, cut with an ellipsis. not squash: the two spaces after the kind word are on purpose */
function line(s: string, max: number): string {
  const flat = s.replace(/\s*[\r\n\t]\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * the menu bar item's menu: the first three inbox rows across every project (Asked and Stopped come
 * first already), then Open Grove and Quit
 */
export function trayTemplate(inbox: InboxView, a: TrayActions): MenuItemConstructorOptions[] {
  const rows = inbox.rows.slice(0, 3).map(
    (r): MenuItemConstructorOptions => ({
      label: line(`${KIND_WORD[r.kind]}  ${r.card ? `${r.card.id} ` : ""}${r.title}`, 60),
      sublabel: line(r.summary ? `${r.projectName} · ${r.summary}` : r.projectName, 80),
      click: () =>
        a.land(
          r.card
            ? { view: "card", project: r.project, cardId: r.card.id, back: "inbox" }
            : { view: "inbox", project: r.project, rowId: r.id },
        ),
    }),
  );
  return [
    ...(rows.length > 0 ? rows : [{ label: "Nothing needs you", enabled: false }]),
    { type: "separator" },
    { label: "Open Grove", click: a.showMain },
    { role: "quit" },
  ];
}
