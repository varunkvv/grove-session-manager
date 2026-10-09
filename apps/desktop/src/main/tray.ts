// the menu bar item: the grove mark, the count of what waits on the person, and a native menu
// built from the inbox and what is working (menuTemplate.ts's trayTemplate).
import type { MenuItemConstructorOptions, NativeImage, Tray } from "electron";
import * as electron from "electron";
import { type TrayActions, type TrayView, trayTemplate } from "./menuTemplate.ts";

/** the 16pt mark doubled: three discs of radius 6 in a 32px square */
const DISCS = [
  [9.2, 12],
  [22.8, 12],
  [16, 22.8],
] as const;

/** drawn in memory, so there is no asset to package. black and a template image: macOS tints it */
export function trayImage(): NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 4x4 samples per pixel, so the edges are smooth
      let hits = 0;
      for (let s = 0; s < 16; s++) {
        const px = x + ((s % 4) + 0.5) / 4;
        const py = y + (Math.floor(s / 4) + 0.5) / 4;
        if (DISCS.some(([cx, cy]) => (px - cx) ** 2 + (py - cy) ** 2 <= 36)) hits++;
      }
      // BGRA: black, so only the alpha is written
      buf[(y * size + x) * 4 + 3] = Math.round((hits / 16) * 255);
    }
  }
  const image = electron.nativeImage.createFromBitmap(buf, {
    width: size,
    height: size,
    scaleFactor: 2,
  });
  image.setTemplateImage(true);
  return image;
}

export function createTray(): Tray {
  const tray = new electron.Tray(trayImage());
  tray.setToolTip("Grove");
  return tray;
}

/**
 * whenever the inbox or what is working moved, and once a minute while something works. returns
 * the menu it built, which a test root reads with no tray at all
 */
export function updateTray(
  tray: Tray | null,
  view: TrayView,
  a: TrayActions,
): MenuItemConstructorOptions[] {
  const template = trayTemplate(view, a);
  if (tray && !tray.isDestroyed()) {
    const n = view.inbox.rows.length;
    tray.setTitle(n > 0 ? String(n) : "");
    tray.setToolTip(n > 0 ? `Grove, ${n} waiting on you` : "Grove");
    tray.setContextMenu(electron.Menu.buildFromTemplate(template));
  }
  return template;
}
