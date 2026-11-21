/**
 * Window state that survives restarts, and is safe to restore on a different
 * monitor layout: a window whose title bar sits off-screen is unrecoverable, so
 * a position is only kept when enough of the window is still on a display.
 */
export type Bounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type WindowState = {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
};

export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 520;
export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1320,
  height: 860,
  maximized: false,
  fullscreen: false,
};

/** How much of the window must overlap a display for the position to be kept. */
const MIN_VISIBLE = 96;
/** The strip people grab to move a window; it must be reachable, not just the body. */
const TITLE_BAR_HEIGHT = 40;
const MIN_TITLE_BAR_VISIBLE = 24;
const MAX_DIMENSION = 10_000;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function overlapX(bounds: Bounds, display: Bounds): number {
  return Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
}

function overlapY(bounds: Bounds, display: Bounds): number {
  return Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
}

/**
 * A window whose body still clips a display but whose title bar sits above it
 * cannot be dragged back into place, so the title-bar strip is what has to be
 * reachable — not merely some part of the window.
 */
function titleBarReachable(bounds: Bounds, displays: readonly Bounds[]): boolean {
  return displays.some(
    (display) =>
      overlapX(bounds, display) >= MIN_VISIBLE && overlapY(bounds, display) >= MIN_TITLE_BAR_VISIBLE,
  );
}

/**
 * Coerce whatever was on disk (possibly hand-edited, possibly from a machine
 * with other monitors) into a state that is safe to hand to BrowserWindow.
 */
export function sanitizeWindowState(raw: unknown, displays: readonly Bounds[]): WindowState {
  const source: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const width = clamp(finite(source.width) ?? DEFAULT_WINDOW_STATE.width, MIN_WIDTH, MAX_DIMENSION);
  const height = clamp(finite(source.height) ?? DEFAULT_WINDOW_STATE.height, MIN_HEIGHT, MAX_DIMENSION);
  const maximized = source.maximized === true;
  const fullscreen = source.fullscreen === true;

  const x = finite(source.x);
  const y = finite(source.y);
  const positionable =
    x !== undefined &&
    y !== undefined &&
    titleBarReachable({ x, y, width, height: TITLE_BAR_HEIGHT }, displays);

  return positionable
    ? { x, y, width, height, maximized, fullscreen }
    : { width, height, maximized, fullscreen };
}
