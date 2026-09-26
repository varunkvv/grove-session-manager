import type { BrowserWindow, WebContents } from "electron";
import * as electron from "electron";
import { clampBounds, loadWindowState, MIN_SIZE, saveWindowState } from "./windowState.ts";

export interface MainWindowOptions {
  preload: string;
  stateFile: string;
  url: string;
  /**
   * a test root's window keeps the size it asks for, even past the display. a CI runner's screen is
   * narrower than a laptop's, and macOS would shrink the window to it - then the pane covers the
   * list there and sits beside it here, and the same test means two different things
   */
  fixedSize?: boolean;
}

/** --color-canvas from app.css, in both appearances. the window is painted before the page loads. */
const CANVAS = { dark: "#1F1E1D", light: "#FAF9F5" } as const;

export function canvasColor(dark: boolean): string {
  return dark ? CANVAS.dark : CANVAS.light;
}

const SAVE_DEBOUNCE_MS = 400;

export async function createMainWindow(o: MainWindowOptions): Promise<BrowserWindow> {
  const saved = await loadWindowState(o.stateFile);
  const primary = electron.screen.getPrimaryDisplay();
  const displays = [
    primary.workArea,
    ...electron.screen
      .getAllDisplays()
      .filter((d) => d.id !== primary.id)
      .map((d) => d.workArea),
  ];
  const bounds = o.fixedSize ? clampBounds(saved, []) : clampBounds(saved, displays);

  const win = new electron.BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    ...(o.fixedSize ? { enableLargerThanScreen: true } : {}),
    show: false,
    backgroundColor: canvasColor(electron.nativeTheme.shouldUseDarkColors),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      preload: o.preload,
    },
  });

  win.once("ready-to-show", () => win.show());

  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // normal bounds: a zoomed or fullscreen window must not become the size it restores to
    if (!win.isDestroyed()) saveWindowState(o.stateFile, win.getNormalBounds());
  };
  const saveSoon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("close", save);

  void win.loadURL(o.url);
  return win;
}

/** every webContents the app ever creates stays on our own pages and opens nothing */
export function lockDown(contents: WebContents, isTrusted: (url: string) => boolean): void {
  contents.on("will-navigate", (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isTrusted(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

export function denyAllPermissions(): void {
  const ses = electron.session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}
