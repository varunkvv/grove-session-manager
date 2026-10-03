import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { buildMenuTemplate, trayTemplate } from "../../src/main/menuTemplate.ts";
import type { InboxRowView, LandingTarget, MenuCommandId } from "../../src/shared/ipc.ts";

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

describe("the tray menu", () => {
  const row = (o: Partial<InboxRowView> & Pick<InboxRowView, "id" | "kind">): InboxRowView => ({
    project: "chat",
    projectName: "Chat features",
    at: 0,
    title: "",
    summary: "",
    reviewKeys: [],
    ...o,
  });
  const ROWS: InboxRowView[] = [
    row({
      id: "asked:CHAT-4",
      kind: "asked",
      card: { id: "CHAT-4", title: "Fix the accrual rounding" },
      title: "Fix the accrual rounding",
      summary: "Round accrual to whole hours,\nor keep the half?",
    }),
    row({
      id: "stopped:s9",
      kind: "stopped",
      project: "data",
      projectName: "Data objects",
      title: "load test",
      summary: "Stopped mid-turn.",
    }),
    row({
      id: "decided:D-12",
      kind: "decided",
      card: { id: "CHAT-7", title: "x".repeat(70) },
      title: "x".repeat(70),
      summary: `Use the policy's 8h day ${"y".repeat(80)}`,
      conclusionId: "D-12",
    }),
    row({ id: "new:CHAT-8", kind: "new", title: "fourth" }),
  ];
  const menu = (rows: InboxRowView[]) => {
    const landed: LandingTarget[] = [];
    let shown = 0;
    const items = trayTemplate(
      { rows, tray: 2 },
      { land: (t) => landed.push(t), showMain: () => shown++ },
    );
    const click = (i: number) => (items[i]?.click as (() => void) | undefined)?.();
    return { items, landed, click, shown: () => shown };
  };

  it("the first three rows in the order the inbox gives, then Open Grove and Quit", () => {
    const { items } = menu(ROWS);
    expect(items.map((i) => i.label ?? i.type ?? i.role)).toEqual([
      "Asked  CHAT-4 Fix the accrual rounding",
      "Stopped  load test",
      `Decided  CHAT-7 ${"x".repeat(43)}…`,
      "separator",
      "Open Grove",
      "quit",
    ]);
    expect(items.map((i) => i.sublabel)).toEqual([
      "Chat features · Round accrual to whole hours, or keep the half?",
      "Data objects · Stopped mid-turn.",
      `Chat features · Use the policy's 8h day ${"y".repeat(39)}…`,
      undefined,
      undefined,
      undefined,
    ]);
    expect(items[2]?.label).toHaveLength(60);
    expect(items[2]?.sublabel).toHaveLength(80);
  });

  it("a card row lands on the card with the inbox behind it, a cardless one on its row", () => {
    const { click, landed, shown } = menu(ROWS);
    click(0);
    click(1);
    expect(landed).toEqual([
      { view: "card", project: "chat", cardId: "CHAT-4", back: "inbox" },
      { view: "inbox", project: "data", rowId: "stopped:s9" },
    ]);
    click(4);
    expect(shown()).toBe(1);
  });

  it("nothing in the inbox: one disabled line", () => {
    const { items } = menu([]);
    expect(items).toEqual([
      { label: "Nothing needs you", enabled: false },
      { type: "separator" },
      { label: "Open Grove", click: expect.any(Function) },
      { role: "quit" },
    ]);
  });

  it("a row with no summary is the project name alone", () => {
    const { items } = menu([row({ id: "asked:session:s1", kind: "asked", title: "session" })]);
    expect(items[0]?.sublabel).toBe("Chat features");
  });
});
