import { contextBridge, ipcRenderer } from "electron";
import {
  CONNECT_CHANNEL,
  type ConnectionResult,
  type YakjevDesktopBridge,
} from "../shared/connection";

if (
  window.location.protocol === "yakjev:" &&
  window.location.hostname === "desktop"
) {
  const bridge: YakjevDesktopBridge = Object.freeze({
    connect: (origin: string): Promise<ConnectionResult> =>
      ipcRenderer.invoke(CONNECT_CHANNEL, origin),
  });

  contextBridge.exposeInMainWorld("yakjevDesktop", bridge);
}
