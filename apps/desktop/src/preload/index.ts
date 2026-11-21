import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { BRIDGE_KEY, IPC_CHANNELS, type DesktopBridge, type DesktopInfo } from "../shared/ipc";

/**
 * The entire surface the product page gets from the shell: who it is running in,
 * and a deep link stream. No filesystem, no shell, no ipcRenderer passthrough.
 */
const bridge: DesktopBridge = {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.info) as Promise<DesktopInfo | null>,
  onDeepLink: (listener: (url: string) => void) => {
    const handler = (_event: IpcRendererEvent, url: string): void => listener(url);
    ipcRenderer.on(IPC_CHANNELS.deepLink, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLink, handler);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
