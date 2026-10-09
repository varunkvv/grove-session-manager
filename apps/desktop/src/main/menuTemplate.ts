// the menu as data. no electron import, so the accelerators can be checked in a unit test.
import { formatDuration, KIND_WORD } from "@grove/core";
import type { MenuItemConstructorOptions } from "electron";
import type { InboxView, LandingTarget, MenuCommandId, SessionHit } from "../shared/ipc.ts";

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
      // one item for both ways: the menu is not rebuilt when the project on screen changes. the
      // page owns the key, like cmd-K: the menu and the page both acting would archive it and
      // bring it straight back
      command("Archive or Unarchive Project", "CmdOrCtrl+Shift+A", "archive-project", {
        registerAccelerator: false,
      }),
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
      command("Usage", "CmdOrCtrl+3", "go-usage"),
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
  /** a working session: wherever a click on a notification about it lands */
  open: (sessionId: string) => void;
  showMain: () => void;
}

/** what the menu bar item's menu is drawn from */
export interface TrayView {
  inbox: InboxView;
  /** the sessions with a turn in flight that a list can name, as All sessions orders them */
  working: ReadonlyArray<Pick<SessionHit, "sessionId" | "title" | "where" | "since">>;
  /** the turns in flight by their status. more than `working` while one has no transcript read yet */
  running: number;
  /** when the mac was told to stay awake. null while it may sleep */
  awakeSince: number | null;
  /** the setting */
  keepAwake: boolean;
  now: number;
}

/** the working sessions the menu names before it says how many more there are */
const TRAY_WORKING = 5;

/** `for 12m`, to the minute: the menu is built again once a minute and no more often */
function span(since: number, now: number): string {
  const ms = Math.max(0, now - since);
  return ms < 60_000 ? "just started" : `for ${formatDuration(ms)}`;
}

/** one line, cut with an ellipsis. not squash: the two spaces after the kind word are on purpose */
function line(s: string, max: number): string {
  const flat = s.replace(/\s*[\r\n\t]\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * whether the mac is being kept awake and for how long, then the sessions that keep it so: the
 * ones working. the line is always there, so the menu answers it with nothing running too
 */
function workingItems(v: TrayView, a: TrayActions): MenuItemConstructorOptions[] {
  const count = v.running > 0 ? `${v.running} working` : "nothing working";
  const head =
    v.awakeSince !== null
      ? `Keeping the Mac awake · ${count} · ${span(v.awakeSince, v.now)}`
      : `${v.keepAwake ? "The Mac can sleep" : "Keep awake is off"} · ${count}`;
  const more = v.working.length - TRAY_WORKING;
  // running by its status, and no transcript of it read yet: there is no title to give it
  const unnamed = v.running - v.working.length;
  return [
    { label: head, enabled: false },
    ...v.working.slice(0, TRAY_WORKING).map(
      (s): MenuItemConstructorOptions => ({
        label: line(s.title, 60),
        sublabel: line(
          s.since === undefined ? s.where : `${s.where} · ${span(s.since, v.now)}`,
          80,
        ),
        click: () => a.open(s.sessionId),
      }),
    ),
    ...(more > 0 ? [{ label: `and ${more} more`, click: () => a.land({ view: "inbox" }) }] : []),
    ...(unnamed > 0 ? [{ label: `and ${unnamed} with no transcript yet`, enabled: false }] : []),
  ];
}

/**
 * the menu bar item's menu: the three newest inbox rows across every project, what is working and
 * whether that keeps the mac awake, then Open Grove and Quit
 */
export function trayTemplate(v: TrayView, a: TrayActions): MenuItemConstructorOptions[] {
  const rows = v.inbox.rows.slice(0, 3).map(
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
    ...workingItems(v, a),
    { type: "separator" },
    { label: "Open Grove", click: a.showMain },
    { role: "quit" },
  ];
}
