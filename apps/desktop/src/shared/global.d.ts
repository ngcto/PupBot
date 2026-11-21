import type { DesktopBridge } from "./ipc";

declare global {
  interface Window {
    /** Present only when the page runs inside the Terabot desktop shell. */
    readonly terabotDesktop?: DesktopBridge;
  }
}

export {};
