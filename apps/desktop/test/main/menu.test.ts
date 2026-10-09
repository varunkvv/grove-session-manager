import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { buildMenuTemplate, type TrayView, trayTemplate } from "../../src/main/menuTemplate.ts";
import type { InboxRowView, LandingTarget, MenuCommandId } from "../../src/shared/ipc.ts";

function items(sent: MenuCommandId[] = []): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  const walk = (list: MenuItemConstructorOptions[]) => {
    for (const item of list) {
      out.push(item);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(
    buildMenuTemplate({
      appName: "Grove",
      editorLabel: "VS Code",
      isDev: false,
      isMac: true,
      send: (id) => sent.push(id),
    }),
  );
  return out;
}

describe("the menu", () => {
  it("never binds one key twice", () => {
    const keys = items().flatMap((i) => (i.accelerator ? [String(i.accelerator)] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every command, with its key", () => {
    const sent: MenuCommandId[] = [];
    const commands = items(sent).filter((i) => i.click);
    expect(commands.map((i) => [i.label, i.accelerator])).toEqual([
      ["Settings…", "CmdOrCtrl+,"],
      ["New Project…", "CmdOrCtrl+N"],
      ["Open Project in VS Code", "CmdOrCtrl+O"],
      ["Edit Project…", "CmdOrCtrl+E"],
      ["Archive or Unarchive Project", "CmdOrCtrl+Shift+A"],
      ["Find", "CmdOrCtrl+F"],
      ["All Sessions", "CmdOrCtrl+1"],
      ["Project Sessions", "CmdOrCtrl+2"],
      ["Go to…", "CmdOrCtrl+K"],
      ["Refresh", "CmdOrCtrl+R"],
    ]);
    for (const i of commands) (i.click as () => void)();
    expect(sent).toEqual([
      "settings",
      "new-project",
      "open-project",
      "edit-project",
      "archive-project",
      "focus-search",
      "go-inbox",
      "go-sessions",
      "palette",
      "refresh",
    ]);
  });

  it("shows cmd-K but leaves the key to the page, so the palette opens while a field has focus", () => {
    const palette = items().find((i) => i.label === "Go to…");
    expect(palette?.registerAccelerator).toBe(false);
    // and cmd-shift-A: a toggle the menu and the page both acted on would undo itself
    const archive = items().find((i) => i.label === "Archive or Unarchive Project");
    expect(archive?.registerAccelerator).toBe(false);
    expect(items().filter((i) => i.registerAccelerator === false)).toHaveLength(2);
  });
});

describe("the tray menu", () => {
  const row = (
    o: Partial<InboxRowView> & Pick<InboxRowView, "sessionId" | "kind">,
  ): InboxRowView => ({
    key: `/claude/projects/${o.sessionId}.jsonl`,
    project: "chat",
    where: "Chat features",
    runtime: "vscode",
    open: {},
    at: 0,
    title: "",
    summary: "",
    reviewKeys: [],
    ...o,
  });
  const ROWS: InboxRowView[] = [
    row({
      sessionId: "s4",
      kind: "turn",
      title: "Fix the accrual rounding",
      summary: "Round accrual to whole hours,\nor keep the half?",
    }),
    row({
      sessionId: "s9",
      kind: "stopped",
      project: "data",
      where: "Data objects",
      title: "load test",
      summary: "Run the load test again",
    }),
    row({
      sessionId: "s7",
      kind: "permission",
      title: "x".repeat(70),
      summary: `Bash ${"y".repeat(80)}`,
    }),
    row({ sessionId: "s8", kind: "failed", title: "fourth" }),
  ];
  const NOW = 10 * 3_600_000;
  const menu = (rows: InboxRowView[], view: Partial<TrayView> = {}) => {
    const landed: LandingTarget[] = [];
    const opened: string[] = [];
    let shown = 0;
    const items = trayTemplate(
      {
        inbox: { rows },
        working: [],
        running: 0,
        awakeSince: null,
        keepAwake: true,
        now: NOW,
        ...view,
      },
      { land: (t) => landed.push(t), open: (id) => opened.push(id), showMain: () => shown++ },
    );
    const click = (i: number) => (items[i]?.click as (() => void) | undefined)?.();
    return { items, landed, opened, click, shown: () => shown };
  };
  const working = (n: number): TrayView["working"] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `w${i}`,
      title: `job ${i}`,
      where: "Chat features",
      since: NOW - (i + 1) * 12 * 60_000,
    }));

  it("the first three rows in the order the inbox gives, what is working, then Open Grove and Quit", () => {
    const { items } = menu(ROWS);
    expect(items.map((i) => i.label ?? i.type ?? i.role)).toEqual([
      "Your turn  Fix the accrual rounding",
      "Stopped  load test",
      `Needs permission  ${"x".repeat(41)}…`,
      "separator",
      "The Mac can sleep · nothing working",
      "separator",
      "Open Grove",
      "quit",
    ]);
    expect(items.map((i) => i.sublabel)).toEqual([
      "Chat features · Round accrual to whole hours, or keep the half?",
      "Data objects · Run the load test again",
      `Chat features · Bash ${"y".repeat(58)}…`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(items[2]?.label).toHaveLength(60);
    expect(items[2]?.sublabel).toHaveLength(80);
  });

  it("a row lands on its session in the inbox", () => {
    const { click, landed, shown } = menu(ROWS);
    click(0);
    click(1);
    expect(landed).toEqual([
      { view: "inbox", session: "s4" },
      { view: "inbox", session: "s9" },
    ]);
    click(6);
    expect(shown()).toBe(1);
  });

  it("nothing in the inbox: one disabled line", () => {
    const { items } = menu([]);
    expect(items).toEqual([
      { label: "Nothing needs you", enabled: false },
      { type: "separator" },
      { label: "The Mac can sleep · nothing working", enabled: false },
      { type: "separator" },
      { label: "Open Grove", click: expect.any(Function) },
      { role: "quit" },
    ]);
  });

  it("kept awake: for how long, and the working sessions that keep it so", () => {
    const { items, click, opened } = menu([], {
      working: working(2),
      running: 2,
      awakeSince: NOW - 75 * 60_000,
    });
    expect(items.slice(2, 5)).toEqual([
      { label: "Keeping the Mac awake · 2 working · for 1h 15m", enabled: false },
      { label: "job 0", sublabel: "Chat features · for 12m", click: expect.any(Function) },
      { label: "job 1", sublabel: "Chat features · for 24m", click: expect.any(Function) },
    ]);
    expect(items[5]).toEqual({ type: "separator" });
    click(3);
    expect(opened).toEqual(["w0"]);
  });

  it("a turn under a minute old has just started", () => {
    const { items } = menu([], {
      working: [{ sessionId: "w", title: "job", where: "Chat features", since: NOW - 20_000 }],
      running: 1,
      awakeSince: NOW - 20_000,
    });
    expect(items.slice(2, 4).map((i) => i.sublabel ?? i.label)).toEqual([
      "Keeping the Mac awake · 1 working · just started",
      "Chat features · just started",
    ]);
  });

  it("switched off in settings: it says so, and still lists what is working", () => {
    const off = menu([], { keepAwake: false });
    expect(off.items[2]?.label).toBe("Keep awake is off · nothing working");
    const { items } = menu([], { keepAwake: false, working: working(1), running: 1 });
    expect(items.slice(2, 4).map((i) => i.label)).toEqual([
      "Keep awake is off · 1 working",
      "job 0",
    ]);
  });

  it("names five working sessions, then says how many more and how many it cannot name", () => {
    const { items, click, landed } = menu([], {
      working: working(7),
      // one more by its status than a list can name
      running: 8,
      awakeSince: NOW - 60_000,
    });
    expect(items.slice(2, 10).map((i) => [i.label, i.enabled])).toEqual([
      ["Keeping the Mac awake · 8 working · for 1m", false],
      ["job 0", undefined],
      ["job 1", undefined],
      ["job 2", undefined],
      ["job 3", undefined],
      ["job 4", undefined],
      ["and 2 more", undefined],
      ["and 1 with no transcript yet", false],
    ]);
    click(8);
    expect(landed).toEqual([{ view: "inbox" }]);
  });

  it("a row with no summary is the project name alone", () => {
    const { items } = menu([row({ sessionId: "s1", kind: "turn", title: "session" })]);
    expect(items[0]?.sublabel).toBe("Chat features");
  });
});
