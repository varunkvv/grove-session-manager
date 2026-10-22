import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { buildMenuTemplate, type TrayView, trayTemplate } from "../../src/main/menuTemplate.ts";
import type { InboxRowView, LandingTarget, MenuCommandId } from "../../src/shared/ipc.ts";

function items(
  sent: MenuCommandId[] = [],
  chat = false,
  sized: number[] = [],
): MenuItemConstructorOptions[] {
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
      chat,
      send: (id) => sent.push(id),
      textSize: (dir) => sized.push(dir),
    }),
  );
  return out;
}

describe("the menu", () => {
  it("never binds one key twice", () => {
    for (const chat of [false, true]) {
      const keys = items([], chat).flatMap((i) => (i.accelerator ? [String(i.accelerator)] : []));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("with grove chat on, cmd-N is a new session in it and a new project is cmd-shift-N", () => {
    const sent: MenuCommandId[] = [];
    const file = items(sent, true).filter((i) => /^New /.test(String(i.label)));
    expect(file.map((i) => [i.label, i.accelerator])).toEqual([
      ["New Session", "CmdOrCtrl+N"],
      ["New Project…", "CmdOrCtrl+Shift+N"],
    ]);
    for (const i of file) (i.click as () => void)();
    expect(sent).toEqual(["new-chat", "new-project"]);
  });

  it("every command, with its key", () => {
    const sent: MenuCommandId[] = [];
    const sized: number[] = [];
    const commands = items(sent, false, sized).filter((i) => i.click);
    expect(commands.map((i) => [i.label, i.accelerator])).toEqual([
      ["Settings…", "CmdOrCtrl+,"],
      ["New Project…", "CmdOrCtrl+N"],
      ["Open Project in VS Code", "CmdOrCtrl+O"],
      ["Edit Project…", "CmdOrCtrl+E"],
      ["Archive or Unarchive Project", "CmdOrCtrl+Shift+A"],
      ["Find", "CmdOrCtrl+F"],
      ["All Sessions", "CmdOrCtrl+1"],
      ["Project Sessions", "CmdOrCtrl+2"],
      ["Usage", "CmdOrCtrl+3"],
      ["Go to…", "CmdOrCtrl+K"],
      ["Refresh", "CmdOrCtrl+R"],
      ["Actual Size", "CmdOrCtrl+0"],
      ["Make Text Bigger", "CmdOrCtrl+Plus"],
      ["Make Text Smaller", "CmdOrCtrl+-"],
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
      "go-usage",
      "palette",
      "refresh",
    ]);
    // a click on a text size item is main's: it is never sent to the page
    expect(sized).toEqual([0, 1, -1]);
  });

  it("shows cmd-K but leaves the key to the page, so the palette opens while a field has focus", () => {
    const palette = items().find((i) => i.label === "Go to…");
    expect(palette?.registerAccelerator).toBe(false);
    // and cmd-shift-A: a toggle the menu and the page both acted on would undo itself
    const archive = items().find((i) => i.label === "Archive or Unarchive Project");
    expect(archive?.registerAccelerator).toBe(false);
    // and the text size: the pages take ⌘= and ⌘+ both, which one menu key can't be
    const sizes = items().filter((i) => /Text|Actual/.test(String(i.label)));
    expect(sizes.map((i) => i.registerAccelerator)).toEqual([false, false, false]);
    expect(items().filter((i) => i.registerAccelerator === false)).toHaveLength(5);
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
        watching: [],
        watchers: 0,
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

  it("how many need you, the first three in the order the inbox gives, what is working, then Open Grove and Quit", () => {
    const { items, click, landed } = menu(ROWS);
    expect(items.map((i) => i.label ?? i.type ?? i.role)).toEqual([
      "4 need you",
      "Fix the accrual rounding",
      "load test",
      `${"x".repeat(59)}…`,
      "and 1 more",
      "separator",
      "The Mac can sleep · nothing working",
      "separator",
      "Open Grove",
      "quit",
    ]);
    // a turn that ended does not say its kind: the line above the rows covers it
    expect(items.map((i) => i.sublabel)).toEqual([
      undefined,
      "Chat features · Round accrual to whole hours, or keep the half?",
      "Stopped · Data objects · Run the load test again",
      `Needs permission · Chat features · Bash ${"y".repeat(39)}…`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(items[0]?.enabled).toBe(false);
    expect(items[3]?.label).toHaveLength(60);
    expect(items[3]?.sublabel).toHaveLength(80);
    click(4);
    expect(landed).toEqual([{ view: "inbox" }]);
  });

  it("a row lands on its session where a notification click about it does", () => {
    const { click, landed, opened, shown } = menu(ROWS);
    click(1);
    click(2);
    expect(opened).toEqual(["s4", "s9"]);
    expect(landed).toEqual([]);
    click(8);
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

  it("one that needs you: the line says needs, and there is no more to count", () => {
    const { items } = menu(ROWS.slice(0, 1));
    expect(items.slice(0, 3).map((i) => i.label ?? i.type)).toEqual([
      "1 needs you",
      "Fix the accrual rounding",
      "separator",
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

  /** sessions between turns that left something running, each with its first task */
  const watching = (n: number): TrayView["watching"] =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `p${i}`,
      title: `poll ${i}`,
      where: "Data objects",
      tasks: [
        { id: `t${i}`, kind: "command", description: "deploy watcher", since: NOW - 60_000 },
        { id: `c${i}`, kind: "schedule", description: "say hi", since: NOW - 60_000 },
      ],
    }));

  it("a session that left something running keeps it awake too: counted as watching, under the working ones", () => {
    const { items, click, opened } = menu([], {
      working: working(1),
      running: 1,
      watching: watching(1),
      watchers: 1,
      awakeSince: NOW - 75 * 60_000,
    });
    expect(items.slice(2, 6)).toEqual([
      { label: "Keeping the Mac awake · 1 working · 1 watching · for 1h 15m", enabled: false },
      { label: "job 0", sublabel: "Chat features · for 12m", click: expect.any(Function) },
      // what it left running, the first of them
      { label: "poll 0", sublabel: "Data objects · deploy watcher", click: expect.any(Function) },
      { type: "separator" },
    ]);
    click(4);
    expect(opened).toEqual(["p0"]);
  });

  it("held for a command in its first minute: the line says it holds, and names nothing yet", () => {
    const held = menu([], { awakeSince: NOW - 12 * 60_000 });
    expect(held.items[2]?.label).toBe("Keeping the Mac awake · for 12m");
  });

  it("nothing in a turn and one watching: the line does not say nothing is working", () => {
    const held = menu([], { watching: watching(1), watchers: 1, awakeSince: NOW - 3 * 60_000 });
    expect(held.items[2]?.label).toBe("Keeping the Mac awake · 1 watching · for 3m");
    const off = menu([], { keepAwake: false, watching: watching(2), watchers: 2 });
    expect(off.items.slice(2, 5).map((i) => i.label)).toEqual([
      "Keep awake is off · 2 watching",
      "poll 0",
      "poll 1",
    ]);
    // a long description is cut like every other line under a row
    const long = menu([], {
      watching: [
        {
          ...watching(1)[0]!,
          tasks: [{ id: "t", kind: "command", description: "y".repeat(90), since: 0 }],
        },
      ],
      watchers: 1,
    });
    expect(long.items[3]?.sublabel).toHaveLength(80);
  });

  it("names five across working and watching, working first, then how many more", () => {
    const { items } = menu([], {
      working: working(3),
      running: 3,
      watching: watching(4),
      // one more by its tasks than a list can name
      watchers: 5,
      awakeSince: NOW - 60_000,
    });
    expect(items.slice(2, 10).map((i) => [i.label, i.enabled])).toEqual([
      ["Keeping the Mac awake · 3 working · 5 watching · for 1m", false],
      ["job 0", undefined],
      ["job 1", undefined],
      ["job 2", undefined],
      ["poll 0", undefined],
      ["poll 1", undefined],
      ["and 2 more", undefined],
      ["and 1 with no transcript yet", false],
    ]);
  });

  it("a row with no summary is the project name alone", () => {
    const { items } = menu([row({ sessionId: "s1", kind: "turn", title: "session" })]);
    expect(items[1]?.sublabel).toBe("Chat features");
  });
});
