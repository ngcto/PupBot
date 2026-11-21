import { Menu, type MenuItemConstructorOptions } from "electron";
import { APP_NAME } from "../shared/config";

export type MenuActions = {
  readonly openInBrowser: () => void;
  readonly checkForUpdates: () => void;
  readonly showAbout: () => void;
};

export type MenuOptions = {
  readonly isMac: boolean;
  readonly isDev: boolean;
};

/**
 * A native menu using the platform's standard roles, so every shortcut people
 * expect (⌘C, ⌘Z, ⌘R, ⌘+/-/0, ⌘W, ⌘Q, ⌥⌘I …) comes from Electron rather than
 * from the product page. The keys documented in the README are this table.
 */
export function buildMenuTemplate(actions: MenuActions, options: MenuOptions): MenuItemConstructorOptions[] {
  const { isMac, isDev } = options;

  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "Open in Browser", accelerator: "CmdOrCtrl+Shift+O", click: actions.openInBrowser },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" as const }] : []),
      { role: "delete" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      ...(isDev ? [{ role: "toggleDevTools" as const }] : []),
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }]),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "Help",
    role: "help",
    submenu: [
      { label: "Open in Browser", click: actions.openInBrowser },
      { label: "Check for Updates…", click: actions.checkForUpdates },
      { type: "separator" },
      { label: `About ${APP_NAME}`, click: actions.showAbout },
    ],
  };

  return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

export function installApplicationMenu(actions: MenuActions, options: MenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(actions, options)));
}
