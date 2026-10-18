// grove chat's windows: one per session, and one hidden spare with the page already loaded, so
// opening a session only hands the spare its id. the same renderer bundle on `#/chat`.
import type { BrowserWindow, WebContents } from "electron";
import * as electron from "electron";
import { canvasColor } from "./window.ts";

export interface ChatWindowsOptions {
  preload: string;
  /** the page, with the appearance on it. `#/chat` is added here */
  url: () => string;
  /** a window took a session, or let it go: the host pushes to it, or stops */
  attach: (sessionId: string, contents: WebContents) => void;
  detach: (sessionId: string, contents: WebContents) => void;
  /** a chat window came to the front: the person is looking at that session */
  focused?: (sessionId: string) => void;
  /** a test root's window keeps the size it asks for, as the main window does */
  fixedSize?: boolean;
}

/** a reading column and the header around it */
const SIZE = { width: 860, height: 880 };
const MIN = { width: 520, height: 420 };

export class ChatWindows {
  private readonly o: ChatWindowsOptions;
  private readonly bySession = new Map<string, BrowserWindow>();
  /** by webContents id: what the page asks about is its own session, and only that */
  private readonly byContents = new Map<number, string>();
  private spare: BrowserWindow | null = null;
  private spareOn = false;
  private refilling: NodeJS.Timeout | null = null;
  private readonly ready = new WeakSet<BrowserWindow>();

  constructor(o: ChatWindowsOptions) {
    this.o = o;
  }

  /** the session's window, at the front. made from the spare when there is one */
  open(sessionId: string): void {
    const had = this.bySession.get(sessionId);
    if (had && !had.isDestroyed()) {
      if (had.isMinimized()) had.restore();
      had.show();
      had.focus();
      return;
    }
    const win = this.takeSpare() ?? this.create();
    this.bySession.set(sessionId, win);
    this.byContents.set(win.webContents.id, sessionId);
    this.o.attach(sessionId, win.webContents);
    win.on("focus", () => this.o.focused?.(sessionId));
    // a spare's page is up and waiting: it asks which session it is for. a new one asks on load
    win.webContents.send("grove:chat:open", {});
    if (this.ready.has(win)) win.show();
    else win.once("ready-to-show", () => win.show());
    this.refill();
  }

  /** the session a page's calls are about. undefined for the main window and the spare */
  sessionOf(contents: WebContents): string | undefined {
    return this.byContents.get(contents.id);
  }

  /** the session of the chat window that has the keyboard */
  focusedSession(): string | undefined {
    const win = electron.BrowserWindow.getFocusedWindow();
    return win ? this.byContents.get(win.webContents.id) : undefined;
  }

  has(sessionId: string): boolean {
    const win = this.bySession.get(sessionId);
    return !!win && !win.isDestroyed();
  }

  close(sessionId: string): void {
    this.bySession.get(sessionId)?.close();
  }

  /** the spare exists only while grove chat is on: with it off, no window is added anywhere */
  setSpare(on: boolean): void {
    this.spareOn = on;
    if (on) {
      this.refill();
      return;
    }
    if (this.refilling) clearTimeout(this.refilling);
    this.refilling = null;
    this.spare?.destroy();
    this.spare = null;
  }

  /** the appearance moved: a spare made for the old one is made again */
  remakeSpare(): void {
    this.spare?.destroy();
    this.spare = null;
    this.refill();
  }

  /** quitting: a spare made now would be a window the quit has to wait for */
  dispose(): void {
    this.setSpare(false);
  }

  private refill(): void {
    if (!this.spareOn || this.spare || this.refilling) return;
    // after the window that is opening has its turn
    this.refilling = setTimeout(() => {
      this.refilling = null;
      if (this.spareOn && !this.spare) this.spare = this.create();
    }, 500);
  }

  private takeSpare(): BrowserWindow | null {
    const spare = this.spare;
    this.spare = null;
    return spare && !spare.isDestroyed() ? spare : null;
  }

  private create(): BrowserWindow {
    const win = new electron.BrowserWindow({
      ...SIZE,
      minWidth: MIN.width,
      minHeight: MIN.height,
      ...(this.o.fixedSize ? { enableLargerThanScreen: true } : {}),
      show: false,
      backgroundColor: canvasColor(electron.nativeTheme.shouldUseDarkColors),
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 14 },
      // the same lockdown as the main window
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        preload: this.o.preload,
      },
    });
    win.once("ready-to-show", () => this.ready.add(win));
    // kept: once the window is closed its webContents can no longer be asked for
    const contents = win.webContents;
    const id = contents.id;
    win.on("closed", () => {
      const sessionId = this.byContents.get(id);
      this.byContents.delete(id);
      if (sessionId === undefined) return;
      this.bySession.delete(sessionId);
      this.o.detach(sessionId, contents);
    });
    void win.loadURL(`${this.o.url()}#/chat`);
    return win;
  }
}
