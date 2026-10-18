import * as electron from "electron";
import type { MenuCommandId } from "../shared/ipc.ts";
import { buildMenuTemplate } from "./menuTemplate.ts";

export function installMenu(o: {
  isDev: boolean;
  editorLabel: string;
  chat: boolean;
  send: (id: MenuCommandId) => void;
}): void {
  const template = buildMenuTemplate({
    appName: electron.app.name,
    editorLabel: o.editorLabel,
    isDev: o.isDev,
    isMac: process.platform === "darwin",
    chat: o.chat,
    send: o.send,
  });
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
