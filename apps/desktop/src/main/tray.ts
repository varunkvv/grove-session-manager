// the menu bar item: the grove mark, the count of what waits on the person, and a native menu
// built from the inbox (menuTemplate.ts's trayTemplate).
import type { MenuItemConstructorOptions, NativeImage, Tray } from "electron";
import * as electron from "electron";
import type { InboxView } from "../shared/ipc.ts";
import { type TrayActions, trayTemplate } from "./menuTemplate.ts";

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

/** on every inbox recompute. returns the menu it built, which a test root reads with no tray at all */
export function updateTray(
  tray: Tray | null,
  inbox: InboxView,
  a: TrayActions,
): MenuItemConstructorOptions[] {
  const template = trayTemplate(inbox, a);
  if (tray && !tray.isDestroyed()) {
    tray.setTitle(inbox.tray > 0 ? String(inbox.tray) : "");
    tray.setToolTip(inbox.tray > 0 ? `Grove, ${inbox.tray} waiting on you` : "Grove");
    tray.setContextMenu(electron.Menu.buildFromTemplate(template));
  }
  return template;
}
