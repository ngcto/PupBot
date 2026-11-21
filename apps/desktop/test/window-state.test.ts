import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_STATE, sanitizeWindowState, type Bounds } from "../src/shared/window-state.ts";

const DISPLAY: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };
const SECOND_DISPLAY: Bounds = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("sanitizeWindowState", () => {
  it("falls back to the default when there is nothing to restore", () => {
    for (const raw of [undefined, null, {}, "nonsense", 42]) {
      expect(sanitizeWindowState(raw, [DISPLAY])).toEqual(DEFAULT_WINDOW_STATE);
    }
  });

  it("restores a window that is still on a display", () => {
    expect(sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 800, maximized: false, fullscreen: false }, [DISPLAY])).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 800,
      maximized: false,
      fullscreen: false,
    });
  });

  it("restores onto a second display", () => {
    expect(sanitizeWindowState({ x: 2100, y: 100, width: 1200, height: 800 }, [DISPLAY, SECOND_DISPLAY])).toMatchObject({
      x: 2100,
      y: 100,
    });
  });

  it("drops a position that would restore off-screen", () => {
    // Same monitor was unplugged: x/y now land outside every display.
    const state = sanitizeWindowState({ x: 2600, y: 200, width: 1200, height: 800 }, [DISPLAY]);
    expect(state.x).toBeUndefined();
    expect(state.y).toBeUndefined();
    expect(state.width).toBe(1200);
    expect(state.height).toBe(800);
  });

  it("keeps a barely-visible window, drops one that is almost gone", () => {
    expect(sanitizeWindowState({ x: 1820, y: 0, width: 1200, height: 800 }, [DISPLAY]).x).toBe(1820);
    expect(sanitizeWindowState({ x: 1900, y: 0, width: 1200, height: 800 }, [DISPLAY]).x).toBeUndefined();
  });

  it("clamps a window that is too small to use", () => {
    const state = sanitizeWindowState({ width: 200, height: 100 }, [DISPLAY]);
    expect(state.width).toBe(720);
    expect(state.height).toBe(520);
  });

  it("clamps absurd dimensions and ignores non-numbers", () => {
    expect(sanitizeWindowState({ width: 1e9, height: Number.POSITIVE_INFINITY }, [DISPLAY])).toMatchObject({
      width: 10_000,
      height: DEFAULT_WINDOW_STATE.height,
    });
    expect(sanitizeWindowState({ width: "1200", height: null }, [DISPLAY])).toMatchObject({
      width: DEFAULT_WINDOW_STATE.width,
      height: DEFAULT_WINDOW_STATE.height,
    });
  });

  it("rounds fractional bounds, which can come back from a scaled display", () => {
    expect(sanitizeWindowState({ x: 10.6, y: 20.2, width: 1200.7, height: 800.4 }, [DISPLAY])).toMatchObject({
      x: 11,
      y: 20,
      width: 1201,
      height: 800,
    });
  });

  it("remembers maximised and full-screen without trusting other shapes", () => {
    expect(sanitizeWindowState({ width: 1200, height: 800, maximized: true }, [DISPLAY]).maximized).toBe(true);
    expect(sanitizeWindowState({ width: 1200, height: 800, fullscreen: true }, [DISPLAY]).fullscreen).toBe(true);
    expect(sanitizeWindowState({ width: 1200, height: 800, maximized: "yes" }, [DISPLAY]).maximized).toBe(false);
  });

  it("works with no displays reported, as during a headless start", () => {
    expect(sanitizeWindowState({ x: 10, y: 10, width: 1200, height: 800 }, [])).toEqual({
      width: 1200,
      height: 800,
      maximized: false,
      fullscreen: false,
    });
  });
});
