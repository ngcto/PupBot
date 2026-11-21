import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { resolve } from "node:path";
import { APP_NAME, DEEP_LINK_PROTOCOL, ENV, resolveDesktopConfig, type DesktopConfig } from "../shared/config";
import { resolveDeepLink } from "../shared/deeplink";
import { IPC_CHANNELS, type DesktopInfo } from "../shared/ipc";
import { isAppOrigin } from "../shared/navigation";
import { attachNavigationPolicy, createMainWindow } from "./window";
import { installPermissionPolicy, productSession } from "./session";
import { loadWindowState, trackWindowState, windowStatePath } from "./state";
import { installApplicationMenu } from "./menu";
import { startUpdater, type UpdaterController } from "./updater";
import { log } from "./log";

const isDev = !app.isPackaged;

let config: DesktopConfig | undefined;
let mainWindow: BrowserWindow | undefined;
let updater: UpdaterController | undefined;
const pendingDeepLinks: string[] = [];

app.setName(APP_NAME);

process.on("unhandledRejection", (reason) => {
  log("main", "unhandled rejection", reason);
});

// Single instance: a second launch focuses the window that already exists (and
// forwards any deep link it was launched with) instead of opening a second shell
// with its own session and its own window state writes.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  app.on("second-instance", (_event, argv) => {
    focusMainWindow();
    for (const link of deepLinksFromArgv(argv)) deliverDeepLink(link);
  });

  // macOS hands deep links over as events, before or after the app is ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  // Every webContents — the product window, a same-origin popup, devtools — gets
  // the navigation policy as it is created, so none of them can leave the origin.
  app.on("web-contents-created", (_event, contents) => {
    if (!config) return;
    attachNavigationPolicy(contents, { config, isDev });
  });

  const startupLinks = deepLinksFromArgv(process.argv);
  pendingDeepLinks.push(...startupLinks);

  app
    .whenReady()
    .then(onReady)
    .catch((error: unknown) => {
      dialog.showErrorBox(`${APP_NAME} could not start`, error instanceof Error ? error.message : String(error));
      app.exit(1);
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    updater?.dispose();
  });
}

function onReady(): void {
  try {
    config = resolveDesktopConfig(process.env);
  } catch (error) {
    dialog.showErrorBox(`${APP_NAME} cannot start`, error instanceof Error ? error.message : String(error));
    app.exit(1);
    return;
  }

  installPermissionPolicy(productSession(), config);
  installIpc(config);
  registerProtocolClient(config);
  installAboutPanel(config);

  installApplicationMenu(
    {
      openInBrowser: () =>
        void shell
          .openExternal(config?.appUrl.toString() ?? "")
          .catch((error: unknown) => log("menu", "could not open the browser", error)),
      checkForUpdates: () => void updater?.check(true),
      showAbout: () => app.showAboutPanel(),
    },
    { isMac: process.platform === "darwin", isDev },
  );

  updater = startUpdater({ config, parentWindow: () => mainWindow });
  openMainWindow();

  for (const link of pendingDeepLinks.splice(0)) deliverDeepLink(link);
}

function openMainWindow(): BrowserWindow | undefined {
  if (!config) return undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  const stateFile = windowStatePath(app.getPath("userData"));
  const state = loadWindowState(
    stateFile,
    screen.getAllDisplays().map((display) => display.workArea),
  );

  const window = createMainWindow({ config, state, isDev });
  trackWindowState(window, stateFile);
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  mainWindow = window;
  return window;
}

function focusMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/**
 * `terabot://auth/...` comes back here. The link is validated and rewritten onto
 * the product origin, then loaded in the same persistent session, so whatever
 * the product does with the callback (better-auth's `/api/auth/callback/...`
 * included) sets the cookie in the shell rather than in the system browser.
 */
function deliverDeepLink(raw: string): void {
  if (!config) {
    pendingDeepLinks.push(raw);
    return;
  }

  const result = resolveDeepLink(raw, config.appUrl);
  if (!result.ok) {
    log("deeplink", `ignored ${DEEP_LINK_PROTOCOL}:// link (${result.reason})`);
    return;
  }

  const window = openMainWindow();
  if (!window) return;

  const target = result.link.target.toString();
  log("deeplink", `handling ${result.link.kind} link`);
  focusMainWindow();

  // Delivered after the mapped page has loaded, so a product that renders its
  // own callback screen receives it; the navigation itself is what completes a
  // cookie handshake on a product route.
  window.webContents.once("did-finish-load", () => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.deepLink, target);
  });

  void window.loadURL(target).catch((error: unknown) => log("deeplink", `could not load ${target}`, error));
}

function deepLinksFromArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => typeof arg === "string" && arg.startsWith(`${DEEP_LINK_PROTOCOL}:`));
}

function registerProtocolClient(resolved: DesktopConfig): void {
  const wanted = app.isPackaged || resolved.registerProtocol;
  if (!wanted) {
    log("protocol", `${DEEP_LINK_PROTOCOL}:// not registered (set ${ENV.registerProtocol}=1 to test it in development)`);
    return;
  }

  // During development Electron's own binary is the handler, so the protocol
  // needs the project path as an argument. Packaged builds register themselves.
  const registered =
    process.defaultApp && process.argv[1] !== undefined
      ? app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [resolve(process.argv[1])])
      : app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);

  log("protocol", registered ? `${DEEP_LINK_PROTOCOL}:// registered` : `${DEEP_LINK_PROTOCOL}:// registration refused`);
}

function installAboutPanel(resolved: DesktopConfig): void {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron ?? "unknown"}`,
    copyright: `Terabot — ${resolved.appUrl.toString()}`,
  });
}

function installIpc(resolved: DesktopConfig): void {
  ipcMain.handle(IPC_CHANNELS.info, (event): DesktopInfo | null => {
    // Only the product page may ask; a foreign frame gets nothing.
    if (!isAppOrigin(event.senderFrame?.url, resolved.allowedOrigins)) return null;
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? "unknown",
      chromeVersion: process.versions.chrome ?? "unknown",
      platform: process.platform,
      appUrl: resolved.appUrl.toString(),
      autoUpdate: resolved.autoUpdate,
    };
  });
}
