/**
 * The one contract between main, preload and the product page. The preload
 * exposes exactly this object as `window.terabotDesktop` and nothing else.
 */
export const BRIDGE_KEY = "terabotDesktop";

export const IPC_CHANNELS = {
  info: "terabot:desktop:info",
  deepLink: "terabot:desktop:deep-link",
} as const;

export type DesktopInfo = {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly platform: string;
  readonly appUrl: string;
  readonly autoUpdate: boolean;
};

export type DesktopBridge = {
  readonly platform: string;
  /** Version and environment of the shell, for an in-product About panel. */
  getInfo(): Promise<DesktopInfo | null>;
  /**
   * Product URL resolved from a `terabot://` deep link. Returns an unsubscribe
   * function. The shell also navigates to that URL, so a page that does nothing
   * with the event still completes the handshake.
   */
  onDeepLink(listener: (url: string) => void): () => void;
};
