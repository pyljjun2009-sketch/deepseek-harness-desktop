import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, HarnessSnapshot, RuntimeChannel } from "../shared/contracts";

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke("desktop:get-snapshot"),
  start: () => ipcRenderer.invoke("desktop:start"),
  stop: () => ipcRenderer.invoke("desktop:stop"),
  restart: () => ipcRenderer.invoke("desktop:restart"),
  openWorkbench: () => ipcRenderer.invoke("desktop:open-workbench"),
  checkUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  installUpdate: (version: string) => ipcRenderer.invoke("desktop:install-update", version),
  setChannel: (channel: RuntimeChannel) => ipcRenderer.invoke("desktop:set-channel", channel),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("desktop:set-auto-start", enabled),
  setTokenSaving: (enabled: boolean) => ipcRenderer.invoke("desktop:set-token-saving", enabled),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  subscribeSnapshot: (listener: (snapshot: HarnessSnapshot) => void) => {
    ipcRenderer.on("desktop:snapshot", (_event, snapshot: HarnessSnapshot) => listener(snapshot));
  }
};

contextBridge.exposeInMainWorld("harnessDesktop", api);
