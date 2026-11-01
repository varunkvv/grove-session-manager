// the menu as data. no electron import, so the accelerators can be checked in a unit test.
import {
  formatDuration,
  formatRelativeTime,
  KIND_WORD,
  type LimitHeadline,
  resetWords,
} from "@grove/core";
import type { MenuItemConstructorOptions } from "electron";
import type { InboxView, LandingTarget, MenuCommandId, SessionHit } from "../shared/ipc.ts";

export interface MenuTemplateOptions {
  appName: string;
  /** VS Code or Cursor */
  editorLabel: string;
  isDev: boolean;
  isMac: boolean;
  /** grove chat is on: cmd-N is a new session in it, and a new project moves to cmd-shift-N */
  chat?: boolean;
  send: (id: MenuCommandId) => void;
  /** the Text size setting a step bigger (1), smaller (-1) or back to 100 (0): main saves it */
  textSize: (dir: -1 | 0 | 1) => void;
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
  // the keys are the pages' own, as cmd-K is, in the main window and every chat window: ⌘= and ⌘+
  // both, which one menu key can't be. a click here is main's
  const textSize = (label: string, accelerator: string, dir: -1 | 0 | 1) =>
    ({
      label,
      accelerator,
      registerAccelerator: false,
      click: () => o.textSize(dir),
    }) satisfies MenuItemConstructorOptions;
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
      ...(o.chat
        ? [
            command("New Session", "CmdOrCtrl+N", "new-chat"),
            command("New Project…", "CmdOrCtrl+Shift+N", "new-project"),
          ]
        : [command("New Project…", "CmdOrCtrl+N", "new-project")]),
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
      separator,
      // safari's words for its text-only zoom
      textSize("Actual Size", "CmdOrCtrl+0", 0),
      textSize("Make Text Bigger", "CmdOrCtrl+Plus", 1),
      textSize("Make Text Smaller", "CmdOrCtrl+-", -1),
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
  /** a session's row: wherever a click on a notification about it lands */
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
  /** the sessions between turns that left something running, in the same order: they keep it awake too */
  watching: ReadonlyArray<Pick<SessionHit, "sessionId" | "title" | "where" | "tasks">>;
  /** how many of those there are by their tasks, as `running` is to `working` */
  watchers: number;
  /** when the mac was told to stay awake. null while it may sleep */
  awakeSince: number | null;
  /** the setting */
  keepAwake: boolean;
  /**
   * how much of the account's usage limit is used, when the Usage screen shows the actual numbers
   * and there is a limit. absent or null: the menu bar says nothing of usage
   */
  limit?: LimitHeadline | null;
  now: number;
}

/** the sessions that need the person the menu names before it says how many more there are */
const TRAY_NEEDS = 3;
/** and the working ones */
const TRAY_WORKING = 5;

/** `for 12m`, to the minute: the menu is built again once a minute and no more often */
function span(since: number, now: number): string {
  const ms = Math.max(0, now - since);
  return ms < 60_000 ? "just started" : `for ${formatDuration(ms)}`;
}

/** one line, cut with an ellipsis */
function line(s: string, max: number): string {
  const flat = s.replace(/\s*[\r\n\t]\s*/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * whether the mac is being kept awake and for how long, then the sessions that keep it so: the
 * ones working, then the ones watching, which left a command or a wake-up running. the line is
 * always there, so the menu answers it with nothing running too
 */
function workingItems(v: TrayView, a: TrayActions): MenuItemConstructorOptions[] {
  const counts = [
    v.running > 0 && `${v.running} working`,
    v.watchers > 0 && `${v.watchers} watching`,
  ]
    .filter(Boolean)
    .join(" · ");
  // held with neither: a command a turn just left, in its first minute. nothing to name yet
  const head =
    v.awakeSince !== null
      ? ["Keeping the Mac awake", counts, span(v.awakeSince, v.now)].filter(Boolean).join(" · ")
      : `${v.keepAwake ? "The Mac can sleep" : "Keep awake is off"} · ${counts || "nothing working"}`;
  // a working one says how long its turn has run, a watching one what it left running
  const rows = [
    ...v.working.map((s) => ({
      s,
      under: s.since === undefined ? s.where : `${s.where} · ${span(s.since, v.now)}`,
    })),
    ...v.watching.map((s) => ({
      s,
      under: [s.where, s.tasks?.[0]?.description].filter(Boolean).join(" · "),
    })),
  ];
  const more = rows.length - TRAY_WORKING;
  // counted by its status, and no transcript of it read yet: there is no title to give it
  const unnamed = v.running + v.watchers - rows.length;
  return [
    { label: head, enabled: false },
    ...rows.slice(0, TRAY_WORKING).map(
      ({ s, under }): MenuItemConstructorOptions => ({
        label: line(s.title, 60),
        sublabel: line(under, 80),
        click: () => a.open(s.sessionId),
      }),
    ),
    ...(more > 0 ? [{ label: `and ${more} more`, click: () => a.land({ view: "inbox" }) }] : []),
    ...(unnamed > 0 ? [{ label: `and ${unnamed} with no transcript yet`, enabled: false }] : []),
  ];
}

/** rounded down, as Claude Code's /usage says it: 99.6 is not yet 100 */
const percentOf = (l: LimitHeadline): string => `${Math.floor(l.percent)}%`;

/** `21% of your $2,000 limit used`, and a plan window's next start after `sep` */
function limitWords(l: LimitHeadline, now: number, sep: string): string {
  const used = `${percentOf(l)} of your ${l.label.charAt(0).toLowerCase()}${l.label.slice(1)} used`;
  return l.resetsAt === null ? used : `${used}${sep}${resetWords(l.resetsAt, now)}`;
}

/**
 * beside the mark: how many need the person, then the share of the usage limit. `2  21%`, `21%`,
 * `2`. a number fetched more than a day ago is left out: the menu and the tooltip still say it
 */
export function trayTitle(v: TrayView): string {
  const n = v.inbox.rows.length;
  return [n > 0 ? String(n) : "", v.limit && !v.limit.stale ? percentOf(v.limit) : ""]
    .filter(Boolean)
    .join("  ");
}

/** the same in words, with the time to a plan window's reset and how old the number is */
export function trayTooltip(v: TrayView): string {
  const n = v.inbox.rows.length;
  return [
    "Grove",
    n > 0 && `${n} waiting on you`,
    v.limit && limitWords(v.limit, v.now, ", "),
    v.limit && `updated ${formatRelativeTime(v.limit.fetchedAt, v.now)}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * the menu bar item's menu: how many sessions need the person and the three newest of them across
 * every project, what is working or watching and whether that keeps the mac awake, how much of the
 * usage limit is used when the menu bar shows it, then Open Grove and Quit
 */
export function trayTemplate(
  v: TrayView,
  a: TrayActions,
  limitIcon?: MenuItemConstructorOptions["icon"],
): MenuItemConstructorOptions[] {
  const n = v.inbox.rows.length;
  const more = n - TRAY_NEEDS;
  const rows = v.inbox.rows.slice(0, TRAY_NEEDS).map(
    (r): MenuItemConstructorOptions => ({
      label: line(r.title, 60),
      // most rows are a turn that ended, and the line above says they need you: only the other
      // kinds say theirs, so the same two words do not head every row
      sublabel: line(
        [r.kind === "turn" ? "" : KIND_WORD[r.kind], r.where, r.summary]
          .filter(Boolean)
          .join(" · "),
        80,
      ),
      // where a notification about it lands: its chat window with grove chat on, else its row
      click: () => a.open(r.sessionId),
    }),
  );
  return [
    {
      label: n === 0 ? "Nothing needs you" : n === 1 ? "1 needs you" : `${n} need you`,
      enabled: false,
    },
    ...rows,
    ...(more > 0 ? [{ label: `and ${more} more`, click: () => a.land({ view: "inbox" }) }] : []),
    { type: "separator" },
    ...workingItems(v, a),
    { type: "separator" },
    // the usage limit, and how old the number is: claude code fetched it, maybe hours ago
    ...(v.limit
      ? ([
          {
            label: limitWords(v.limit, v.now, " · "),
            sublabel: `Updated ${formatRelativeTime(v.limit.fetchedAt, v.now)}`,
            // enabled, or macOS dims the bar: the click opens grove, where the Usage screen is
            icon: limitIcon ?? undefined,
            click: a.showMain,
          },
          { type: "separator" },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    { label: "Open Grove", click: a.showMain },
    { role: "quit" },
  ];
}
