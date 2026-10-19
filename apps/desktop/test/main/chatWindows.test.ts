// the chat windows' focus order: what ⌘K's Windows lists, and so what ⌘K Enter flips to
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  let next = 1;
  class FakeWindow {
    private readonly handlers = new Map<string, Array<() => void>>();
    private destroyed = false;
    readonly webContents = { id: next++, send: () => {} };
    on(event: string, fn: () => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    once(event: string, fn: () => void) {
      return this.on(event, fn);
    }
    emit(event: string) {
      for (const fn of this.handlers.get(event) ?? []) fn();
    }
    focus() {
      this.emit("focus");
    }
    close() {
      this.destroyed = true;
      this.emit("closed");
    }
    loadURL() {
      return Promise.resolve();
    }
    isDestroyed = () => this.destroyed;
    isMinimized = () => false;
    isVisible = () => true;
    show() {}
    restore() {}
    center() {}
    destroy() {}
    getSize = () => [860, 880];
    setSize() {}
    getPosition = () => [0, 0];
    setPosition() {}
    getBounds = () => ({ x: 0, y: 0, width: 860, height: 880 });
  }
  return {
    BrowserWindow: FakeWindow,
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 4000, height: 4000 } }) },
  };
});

const { ChatWindows } = await import("../../src/main/chatWindows.ts");

function windows() {
  const all = new ChatWindows({
    preload: "",
    url: () => "app://grove/",
    palette: () => "grove",
    attach: () => {},
    detach: () => {},
  });
  // the one each session was given, to focus and close as the person would
  const of = (id: string) =>
    (all as unknown as { bySession: Map<string, { focus(): void; close(): void }> }).bySession.get(
      id,
    );
  return { all, of };
}

describe("chat windows' order", () => {
  it("is the one opened or looked at last first", () => {
    const { all, of } = windows();
    all.open("a");
    all.open("b");
    all.open("c");
    expect(all.windows()).toEqual(["c", "b", "a"]);
    of("a")?.focus();
    expect(all.windows()).toEqual(["a", "c", "b"]);
    // open on one that is open already brings it forward, as a click in ⌘K does
    all.open("b");
    expect(all.windows()).toEqual(["b", "a", "c"]);
  });

  it("drops a window once it is closed, and /clear keeps its place", () => {
    const { all, of } = windows();
    all.open("a");
    all.open("b");
    of("b")?.close();
    expect(all.windows()).toEqual(["a"]);
    all.open("c");
    all.rekey("a", "a2");
    expect(all.windows()).toEqual(["c", "a2"]);
  });
});
