// the whole bridge. sandboxed, so this must stay one bundled file that only requires electron.
// ipcRenderer itself never crosses into the page: the page gets named methods and nothing else.
import { contextBridge, ipcRenderer } from "electron";
import { INVOKE_CHANNELS, PUSH_CHANNELS } from "../shared/ipc.ts";

const pushChannels: ReadonlySet<string> = new Set(PUSH_CHANNELS);

const bridge: Record<string, unknown> = {};
for (const name of INVOKE_CHANNELS) {
  bridge[name] = (...args: unknown[]) => ipcRenderer.invoke(`grove:${name}`, ...args);
}

bridge.on = (channel: unknown, listener: unknown): (() => void) => {
  if (typeof channel !== "string" || !pushChannels.has(channel)) {
    throw new Error(`not a push channel: ${String(channel)}`);
  }
  if (typeof listener !== "function") throw new Error("listener must be a function");
  // the event object carries the sender. the page only ever sees the payload.
  const wrapped = (_event: unknown, payload: unknown) => listener(payload);
  ipcRenderer.on(`grove:${channel}`, wrapped);
  return () => {
    ipcRenderer.removeListener(`grove:${channel}`, wrapped);
  };
};

contextBridge.exposeInMainWorld("grove", bridge);
