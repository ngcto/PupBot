import { BrowserWindow, shell, type WebContents, type WebPreferences } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, type DesktopConfig } from "../shared/config";
import { decideNavigation, decideWindowOpen } from "../shared/navigation";
import { MIN_HEIGHT, MIN_WIDTH, type WindowState } from "../shared/window-state";
import { SESSION_PARTITION } from "./session";
import { log } from "./log";

const DIST_DIR = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(DIST_DIR, "preload.cjs");
const BACKGROUND = "#0b0b0c";

/**
 * The only webPreferences the product ever runs under: isolated context, no Node
 * in the renderer, sandboxed, no `<webview>`, no content security relaxation.
 */
function productWebPreferences(isDev: boolean): WebPreferences {
  return {
    preload: PRELOAD,
    partition: SESSION_PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: true,
    devTools: isDev,
  };
}

export type MainWindowOptions = {
  readonly config: DesktopConfig;
  readonly state: WindowState;
  readonly isDev: boolean;
};

export function createMainWindow({ config, state, isDev }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: BACKGROUND,
    title: APP_NAME,
    webPreferences: productWebPreferences(isDev),
  });

  // Show only once there is something to look at, so start-up is a window with
  // the product in it rather than a white flash.
  window.once("ready-to-show", () => {
    if (state.fullscreen) window.setFullScreen(true);
    else if (state.maximized) window.maximize();
    window.show();
  });

  installUnreachableProductPage(window, config);

  void window.loadURL(config.appUrl.toString()).catch((error: unknown) => {
    log("window", `could not load ${config.appUrl.toString()}: ${String(error)}`);
  });

  return window;
}

/**
 * A product that is down (stale dev server, no network) should still produce a
 * usable window with one obvious way forward, rather than an empty white page.
 * The retry control is a plain link, so no script or extra permission is needed.
 */
function installUnreachableProductPage(window: BrowserWindow, config: DesktopConfig): void {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation replaced by another (deep link, retry).
    if (!isMainFrame || errorCode === -3) return;
    log("window", `load failed (${errorCode} ${errorDescription})`);
    void window.loadURL(unreachableProductPage(config, errorDescription, errorCode));
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function unreachableProductPage(config: DesktopConfig, description: string, code: number): string {
  const target = config.appUrl.toString();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>${APP_NAME}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        background: ${BACKGROUND}; color: #f2f2f3;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { max-width: 460px; padding: 32px; text-align: center; }
      h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
      p { margin: 0 0 8px; font-size: 15px; line-height: 1.5; color: #a4a4ac; }
      code { font-size: 13px; color: #d6d6dc; }
      a {
        display: inline-block; margin-top: 24px; padding: 10px 18px; border-radius: 10px;
        background: #1884fc; color: #fff; text-decoration: none; font-size: 14px; font-weight: 500;
      }
      a:hover { background: #0f74e4; }
    </style>
  </head>
  <body>
    <main>
      <h1>Can't reach Terabot</h1>
      <p>The app could not load <code>${escapeHtml(target)}</code>.</p>
      <p>${escapeHtml(description)} (${code}). Check the network, or that the product server is running.</p>
      <a href="${escapeHtml(target)}">Try again</a>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Navigation policy for one webContents: the product origin is the only place
 * the window may go; web links elsewhere open in the system browser; everything
 * else is blocked. Registered for every webContents the app creates (main
 * window, popups, devtools), so a child window can not escape the rules either.
 */
export function attachNavigationPolicy(contents: WebContents, options: { config: DesktopConfig; isDev: boolean }): void {
  const allowedOrigins = options.config.allowedOrigins;

  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, allowedOrigins);
    if (decision.action === "allow-child") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 1024,
          height: 768,
          minWidth: MIN_WIDTH,
          minHeight: MIN_HEIGHT,
          backgroundColor: BACKGROUND,
          autoHideMenuBar: true,
          webPreferences: productWebPreferences(options.isDev),
        },
      };
    }
    if (decision.action === "external") {
      void openExternally(decision.url);
    } else {
      log("navigation", `blocked popup (${decision.reason})`);
    }
    return { action: "deny" };
  });

  const guard = (event: Electron.Event, url: string): void => {
    const decision = decideNavigation(url, allowedOrigins);
    if (decision.action === "allow") return;
    event.preventDefault();
    if (decision.action === "external") void openExternally(decision.url);
    else log("navigation", `blocked navigation (${decision.reason}): ${url}`);
  };

  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);

  // `<webview>` is disabled in preferences; refuse attachment as well.
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log("navigation", "blocked <webview> attachment");
  });
}

/**
 * Only URLs that `decideNavigation` already classified as external reach this
 * function, so the scheme is limited to http(s), mailto and tel.
 */
async function openExternally(url: string): Promise<void> {
  try {
    await shell.openExternal(url);
  } catch (error) {
    log("navigation", `could not open ${url} in the system browser`, error);
  }
}
