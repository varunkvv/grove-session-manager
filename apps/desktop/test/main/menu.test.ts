import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { buildMenuTemplate, trayTemplate } from "../../src/main/menuTemplate.ts";
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

  it("every command, with its key, as app.md 3.9 lists them", () => {
    const sent: MenuCommandId[] = [];
    const commands = items(sent).filter((i) => i.click);
    expect(commands.map((i) => [i.label, i.accelerator])).toEqual([
      ["Settings…", "CmdOrCtrl+,"],
      ["New Project…", "CmdOrCtrl+N"],
      ["Open Project in VS Code", "CmdOrCtrl+O"],
      ["Edit Project…", "CmdOrCtrl+E"],
      ["Find", "CmdOrCtrl+F"],
      ["Inbox", "CmdOrCtrl+1"],
      ["Cards", "CmdOrCtrl+2"],
      ["Conclusions", "CmdOrCtrl+3"],
      ["Go to…", "CmdOrCtrl+K"],
      ["Refresh", "CmdOrCtrl+R"],
    ]);
    for (const i of commands) (i.click as () => void)();
    expect(sent).toEqual([
      "settings",
      "new-project",
      "open-project",
      "edit-project",
      "focus-search",
      "go-inbox",
      "go-cards",
      "go-conclusions",
      "palette",
      "refresh",
    ]);
  });

  it("shows cmd-K but leaves the key to the page, so the palette opens while a field has focus", () => {
    const palette = items().find((i) => i.label === "Go to…");
    expect(palette?.registerAccelerator).toBe(false);
    expect(items().filter((i) => i.registerAccelerator === false)).toHaveLength(1);
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
