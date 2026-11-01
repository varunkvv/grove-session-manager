// the menu bar item: the grove mark (trayMark.ts), the count of what waits on the person and, when
// the Usage screen shows the actual numbers, the share of the usage limit used, and a native menu
// built from the inbox and what is working (menuTemplate.ts's trayTemplate).
import type { MenuItemConstructorOptions, NativeImage, Tray } from "electron";
import * as electron from "electron";
import {
  type TrayActions,
  type TrayView,
  trayTemplate,
  trayTitle,
  trayTooltip,
} from "./menuTemplate.ts";
import { MARK_SIZE, markAlpha } from "./trayMark.ts";

/**
 * drawn in memory, so there is no asset to package. black and a template image: macOS tints it,
 * and keeps the alpha that sets the two trees behind back
 */
export function trayImage(): NativeImage {
  // BGRA: black, so only the alpha is written
  const buf = Buffer.alloc(MARK_SIZE * MARK_SIZE * 4);
  for (const [i, a] of markAlpha().entries()) buf[i * 4 + 3] = a;
  const image = electron.nativeImage.createFromBitmap(buf, {
    width: MARK_SIZE,
    height: MARK_SIZE,
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
    tray.setTitle(trayTitle(view));
    tray.setToolTip(trayTooltip(view));
    tray.setContextMenu(electron.Menu.buildFromTemplate(template));
  }
  return template;
}
