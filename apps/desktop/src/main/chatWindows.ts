// grove chat's windows: one per session, and one hidden spare with the page already loaded, so
// opening a session only hands the spare its id. the same renderer bundle on `#/chat`.
import type { BrowserWindow, WebContents } from "electron";
import * as electron from "electron";
import type { AppSettings, ChatShow } from "../shared/ipc.ts";
import { canvasColor } from "./window.ts";
import { loadWindowState, saveWindowState } from "./windowState.ts";

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
  /** where the size the person last gave a chat window is kept */
  stateFile?: string;
}

/** a reading column and the header around it */
const SIZE = { width: 860, height: 880 };
const MIN = { width: 520, height: 420 };
/** each window opens this far down and right of the last one, as a document window does */
const CASCADE = 26;

export class ChatWindows {
  private readonly o: ChatWindowsOptions;
  private readonly bySession = new Map<string, BrowserWindow>();
  /** by webContents id: what the page asks about is its own session, and only that */
  private readonly byContents = new Map<number, string>();
  private spare: BrowserWindow | null = null;
  private spareOn = false;
  private refilling: NodeJS.Timeout | null = null;
  private readonly ready = new WeakSet<BrowserWindow>();
  /** the size the person last left a chat window at: every new one opens at it */
  private size = SIZE;
  /** the chat window opened or looked at last: the next one cascades from it */
  private last: BrowserWindow | null = null;
  private saving: NodeJS.Timeout | null = null;

  constructor(o: ChatWindowsOptions) {
    this.o = o;
    if (o.stateFile) {
      void loadWindowState(o.stateFile).then((s) => {
        const r = s as { width?: unknown; height?: unknown } | undefined;
        if (typeof r?.width === "number" && typeof r.height === "number") {
          this.size = {
            width: Math.max(MIN.width, Math.round(r.width)),
            height: Math.max(MIN.height, Math.round(r.height)),
          };
        }
      });
    }
  }

  /**
   * the session's window, at the front. made from the spare when there is one. `show`: a file or
   * the agents, opened beside the conversation
   */
  open(sessionId: string, show?: ChatShow): void {
    const had = this.bySession.get(sessionId);
    if (had && !had.isDestroyed()) {
      if (had.isMinimized()) had.restore();
      had.show();
      had.focus();
      if (show) had.webContents.send("grove:chat:show", show);
      return;
    }
    const win = this.takeSpare() ?? this.create();
    this.place(win);
    this.bySession.set(sessionId, win);
    this.byContents.set(win.webContents.id, sessionId);
    this.o.attach(sessionId, win.webContents);
    const contentsId = win.webContents.id;
    win.on("focus", () => {
      this.last = win;
      // the session it shows now: /clear moves a window to a new one
      const id = this.byContents.get(contentsId);
      if (id) this.o.focused?.(id);
    });
    this.last = win;
    // a spare's page is up and waiting: it asks which session it is for. a new one asks on load
    win.webContents.send("grove:chat:open", {});
    if (show) win.webContents.send("grove:chat:show", show);
    if (this.ready.has(win)) win.show();
    else win.once("ready-to-show", () => win.show());
    this.refill();
  }

  /** the session a page's calls are about. undefined for the main window and the spare */
  sessionOf(contents: WebContents): string | undefined {
    return this.byContents.get(contents.id);
  }

  /** ⌘F in a chat window: it finds in its own conversation, the main window stays put */
  find(sessionId: string): void {
    const win = this.bySession.get(sessionId);
    if (win && !win.isDestroyed()) win.webContents.send("grove:chat:find", {});
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

  /** /clear made the session a new one: its window shows that one now */
  rekey(from: string, to: string): void {
    const win = this.bySession.get(from);
    if (!win || win.isDestroyed()) return;
    this.bySession.delete(from);
    this.bySession.set(to, win);
    this.byContents.set(win.webContents.id, to);
    win.webContents.send("grove:chat:open", {});
  }

  /** what the window shows moved (a new session's transcript came, the appearance changed): it reads it again */
  reload(sessionId?: string): void {
    for (const [id, win] of this.bySession) {
      if (sessionId !== undefined && id !== sessionId) continue;
      if (!win.isDestroyed()) win.webContents.send("grove:chat:open", {});
    }
  }

  /** the Appearance setting moved: every chat window draws in the new one, the spare included */
  appearance(appearance: AppSettings["appearance"]): void {
    const dark = electron.nativeTheme.shouldUseDarkColors;
    for (const win of this.bySession.values()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(canvasColor(dark));
      win.webContents.send("grove:chat:appearance", { appearance });
    }
    this.remakeSpare();
  }

  /** macOS switched between light and dark: the frames behind the pages follow */
  repaint(): void {
    const dark = electron.nativeTheme.shouldUseDarkColors;
    for (const win of this.bySession.values()) {
      if (!win.isDestroyed()) win.setBackgroundColor(canvasColor(dark));
    }
  }

  /** at the size the person left the last one, cascaded from the last one still open */
  private place(win: BrowserWindow): void {
    const [w, h] = win.getSize();
    if (w !== this.size.width || h !== this.size.height)
      win.setSize(this.size.width, this.size.height);
    const from = this.last && !this.last.isDestroyed() && this.last.isVisible() ? this.last : null;
    if (!from) {
      win.center();
      return;
    }
    const [x = 0, y = 0] = from.getPosition();
    const area = electron.screen.getDisplayMatching(from.getBounds()).workArea;
    // past the screen's edge it starts again at the top left of it
    const nx = x + CASCADE + this.size.width > area.x + area.width ? area.x : x + CASCADE;
    const ny = y + CASCADE + this.size.height > area.y + area.height ? area.y : y + CASCADE;
    win.setPosition(nx, ny);
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
      ...this.size,
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
    // the size it is left at is the next one's
    win.on("resize", () => {
      if (!this.bySession.size || !this.o.stateFile) return;
      const file = this.o.stateFile;
      if (this.saving) clearTimeout(this.saving);
      this.saving = setTimeout(() => {
        if (win.isDestroyed()) return;
        const b = win.getNormalBounds();
        this.size = { width: b.width, height: b.height };
        saveWindowState(file, b);
      }, 400);
    });
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
