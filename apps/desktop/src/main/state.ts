import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserWindow } from "electron";
import { DEFAULT_WINDOW_STATE, sanitizeWindowState, type Bounds, type WindowState } from "../shared/window-state";
import { log } from "./log";

export const WINDOW_STATE_FILE = "window-state.json";
const SAVE_DELAY_MS = 400;

export function windowStatePath(userDataDir: string): string {
  return join(userDataDir, WINDOW_STATE_FILE);
}

export function loadWindowState(file: string, displays: readonly Bounds[]): WindowState {
  try {
    return sanitizeWindowState(JSON.parse(readFileSync(file, "utf8")), displays);
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

export function saveWindowState(window: BrowserWindow, file: string): void {
  const state = {
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write beside the target and rename, so a crash mid-write never leaves a
    // truncated state file behind.
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    log("state", "could not save window state", error);
  }
}

/**
 * Persist bounds on a debounce while the user drags, and once more on close.
 * `getNormalBounds` keeps the un-maximised size, so restoring from maximised
 * comes back to the same small window.
 */
export function trackWindowState(window: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      saveWindowState(window, file);
    }, SAVE_DELAY_MS);
    timer.unref();
  };

  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    saveWindowState(window, file);
  });
}
