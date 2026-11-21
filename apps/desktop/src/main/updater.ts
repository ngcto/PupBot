import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { APP_NAME, ENV, type DesktopConfig } from "../shared/config";
import { resolveUpdateSource } from "../shared/updates";
import { log } from "./log";

const { autoUpdater } = electronUpdater;

const STARTUP_DELAY_MS = 12_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export type UpdaterController = {
  /** Check now. `manual` is true when the user asked, so failures may be shown. */
  check(manual: boolean): Promise<void>;
  dispose(): void;
};

/**
 * Updates are opt-in. A packaged build with `TERABOT_UPDATE_FEED_URL` can check
 * when `TERABOT_AUTO_UPDATE=1`; without either, nothing runs over the network
 * and the Help menu can still check on request. Auto-update is off by default on
 * purpose: a feed URL is a piece of production infrastructure and a silent
 * download is a surprise.
 */
export function startUpdater(options: { config: DesktopConfig; parentWindow: () => BrowserWindow | undefined }): UpdaterController {
  const { config } = options;
  let timer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let manualCheck = false;

  // A packaged build reads the feed electron-builder embedded at build time; a
  // runtime TERABOT_UPDATE_FEED_URL overrides it.
  const source = resolveUpdateSource({
    runtimeFeedUrl: config.updateFeedUrl,
    isPackaged: app.isPackaged,
    bundledFeedPath: process.resourcesPath ? join(process.resourcesPath, "app-update.yml") : undefined,
    fileExists: existsSync,
  });
  const feedConfigured = source.kind !== "none";
  if (source.kind === "runtime") autoUpdater.setFeedURL({ provider: "generic", url: source.feedUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  const showMessage = (message: string, detail: string): void => {
    const parent = options.parentWindow();
    void dialog.showMessageBox({ ...(parent ? { parent } : {}), type: "info", buttons: ["OK"], message, detail });
  };

  autoUpdater.on("error", (error) => {
    log("updater", `update check failed: ${error.message}`);
    if (manualCheck) {
      manualCheck = false;
      showMessage("Could not check for updates", error.message);
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (!manualCheck) return;
    manualCheck = false;
    showMessage(`${APP_NAME} is up to date`, `Version ${app.getVersion()} is the newest build on the feed.`);
  });

  autoUpdater.on("update-available", (info) => {
    log("updater", `update ${info.version} available; downloading`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    const parent = options.parentWindow();
    void dialog
      .showMessageBox({
        ...(parent ? { parent } : {}),
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `${APP_NAME} ${info.version} is ready`,
        detail: "Restart to finish installing the update.",
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  const check = async (manual: boolean): Promise<void> => {
    if (!app.isPackaged) {
      if (manual) showMessage("Updates are disabled in development", "Package the app to check the update feed.");
      return;
    }
    if (!feedConfigured) {
      if (manual) {
        showMessage(
          "No update feed configured",
          `Build with ${ENV.updateFeedUrl} so the app carries a feed, or set it at launch to point this copy somewhere else.`,
        );
      }
      return;
    }
    manualCheck = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      log("updater", "check failed", error);
      if (manual) {
        manualCheck = false;
        showMessage("Could not check for updates", error instanceof Error ? error.message : String(error));
      }
    }
  };

  if (config.autoUpdate && feedConfigured && app.isPackaged) {
    timer = setTimeout(() => {
      void check(false);
      interval = setInterval(() => void check(false), CHECK_INTERVAL_MS);
      interval.unref();
    }, STARTUP_DELAY_MS);
    timer.unref();
  }

  return {
    check,
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      timer = undefined;
      interval = undefined;
    },
  };
}
