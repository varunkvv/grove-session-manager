import * as electron from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";
import { buildMenuTemplate } from "./menuTemplate.ts";

export function installMenu(o: { isDev: boolean; send: (id: MenuCommandId) => void }): void {
  const template = buildMenuTemplate({
    appName: electron.app.name,
    isDev: o.isDev,
    isMac: process.platform === "darwin",
    send: o.send,
  });
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
