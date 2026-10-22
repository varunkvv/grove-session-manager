import * as electron from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";
import { buildMenuTemplate } from "./menuTemplate.ts";

export function installMenu(o: {
  isDev: boolean;
  editorLabel: string;
  chat: boolean;
  send: (id: MenuCommandId) => void;
  textSize: (dir: -1 | 0 | 1) => void;
}): void {
  const template = buildMenuTemplate({
    appName: electron.app.name,
    editorLabel: o.editorLabel,
    isDev: o.isDev,
    isMac: process.platform === "darwin",
    chat: o.chat,
    send: o.send,
    textSize: o.textSize,
  });
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
