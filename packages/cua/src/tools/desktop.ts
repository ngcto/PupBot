import type { CuaDriver } from "../driver/cli.ts";
import { CuaDriverError, readRefusal } from "../driver/cli.ts";
import { readActionResult, readObservation, readWindows } from "../driver/parse.ts";
import type { CuaActionResult, CuaApp, CuaObservation, CuaScreenshot, CuaWindow } from "../types.ts";

/**
 * The desktop half of the tool surface: observe a window, act on it, escalate.
 *
 * Everything here is a plain async function over explicit arguments. Nothing in
 * this file knows how the model calls it, what a schema looks like, or that a
 * loop exists — the loop belongs to the harness, and the tool index that
 * describes these functions belongs to whatever exposes them.
 */

/** A window, named either exactly or by the app that owns it. */
export type WindowTarget =
  | { pid: number; windowId?: number }
  | { app: string; window?: string };

export interface ObserveOptions {
  /** Ask for the image too. Off by default: the tree carries every target. */
  screenshot?: boolean;
  /** Only rows that changed since this snapshot id. */
  since?: "latest" | string;
  /** `elements` returns structured rows; `markdown` the compact text tree. */
  format?: "elements" | "markdown";
  /** Cap the rows returned, for a very large tree. */
  maxElements?: number;
  /** Narrows the tree to one element's subtree. */
  query?: string;
  signal?: AbortSignal;
}

function targetArgs(target: WindowTarget): Record<string, unknown> {
  if ("app" in target) {
    return { app: target.app, ...(target.window ? { window: target.window } : {}) };
  }
  return { pid: target.pid, ...(target.windowId !== undefined ? { window_id: target.windowId } : {}) };
}

/**
 * The rows a model can act on, most useful first: labelled controls before
 * unlabelled container text, on-screen before off-screen.
 *
 * The driver returns the tree in document order, which is right for a human
 * reading it and wrong for a budget: a window's chrome can fill the first page
 * with rows nothing can be done to. This ordering puts the candidates first and
 * leaves the rest behind it, without hiding anything.
 */
export function rankElements(elements: CuaObservation["elements"]): CuaObservation["elements"] {
  const score = (element: CuaObservation["elements"][number]): number => {
    let value = 0;
    if (element.actions?.length) value += 4;
    if (element.label) value += 2;
    if (element.enabled === false) value -= 3;
    if (element.offscreen) value -= 2;
    if (element.role === "statictext" || element.role === "text") value -= 1;
    return value;
  };
  return [...elements].sort((a, b) => score(b) - score(a));
}

export async function listWindows(
  driver: CuaDriver,
  options: { pid?: number; app?: string; signal?: AbortSignal } = {},
): Promise<CuaWindow[]> {
  const args: Record<string, unknown> = {};
  if (options.pid !== undefined) args.pid = options.pid;
  if (options.app) args.app = options.app;
  const value = await driver.require("list_windows", args, options.signal ? { signal: options.signal } : {});
  return readWindows(value);
}

export async function listApps(
  driver: CuaDriver,
  options: { signal?: AbortSignal } = {},
): Promise<CuaApp[]> {
  const value = await driver.require("list_apps", {}, options.signal ? { signal: options.signal } : {});
  const rows = Array.isArray(value.apps) ? (value.apps as Array<Record<string, unknown>>) : [];
  return rows
    .filter((row) => typeof row.pid === "number" && row.pid > 0)
    .map((row) => ({
      name: String(row.name ?? ""),
      pid: Number(row.pid),
      running: row.running === true,
      active: row.active === true,
      ...(Array.isArray(row.windows) ? { windowCount: row.windows.length } : {}),
    }));
}

/**
 * Launch an app **in the background**: the driver does not raise the window.
 *
 * Returns the windows it opened, so a caller can observe immediately instead of
 * polling. MEASURED: a cold `launch_app` can answer before the app has mapped a
 * window (`windows: []` on a fresh Thunar), which would hand every caller an
 * empty handle — so when the reply has no window, this waits for one briefly
 * rather than returning a handle to nothing.
 */
export async function launchApp(
  driver: CuaDriver,
  input: { app: string; urls?: string[]; forceNewInstance?: boolean; waitMs?: number },
  options: { signal?: AbortSignal } = {},
): Promise<{ pid: number; windows: CuaWindow[]; started: boolean }> {
  const value = await driver.require(
    "launch_app",
    {
      name: input.app,
      ...(input.urls?.length ? { urls: input.urls } : {}),
      ...(input.forceNewInstance ? { creates_new_application_instance: true } : {}),
    },
    options.signal ? { signal: options.signal } : {},
  );
  const pid = typeof value.pid === "number" ? value.pid : 0;
  let windows = readWindows(value);

  // MEASURED: `urls` makes the driver dispatch through `xdg-open` on Linux and
  // answer with `pid: null, windows: []` — the app is opening, but the reply
  // names no process. And a cold launch can answer before the app maps a
  // window. Either way an empty result must not become an empty handle, so wait
  // for the windows the caller actually needs.
  if (windows.length === 0) {
    const deadline = Date.now() + (input.waitMs ?? 8000);
    while (windows.length === 0 && Date.now() < deadline) {
      await sleep(250, options.signal);
      windows = await listWindows(driver, {
        ...(pid > 0 ? { pid } : { app: input.app }),
        ...(options.signal ? { signal: options.signal } : {}),
      }).catch(() => []);
    }
  }

  return { pid: pid || (windows[0]?.pid ?? 0), windows, started: value.running === true || windows.length > 0 };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Observe one window: the accessibility tree **and** the screenshot in one call,
 * which is what the driver's contract is built around.
 *
 * Text comes back whether or not the image does, so the default is tree-only and
 * a caller asks for pixels when the tree is insufficient — that is where the
 * budget is protected, since an image is a few thousand tokens and a tree is a
 * few hundred.
 */
export async function observeWindow(
  driver: CuaDriver,
  target: WindowTarget,
  options: ObserveOptions = {},
): Promise<CuaObservation> {
  const started = Date.now();
  const value = await driver.require(
    "get_window_state",
    {
      ...targetArgs(target),
      tree_format: options.format === "markdown" ? "markdown" : "elements",
      include_screenshot: options.screenshot === true,
      ...(options.since ? { since: options.since } : {}),
      ...(options.maxElements ? { max_elements: options.maxElements } : {}),
      ...(options.query ? { query: options.query } : {}),
    },
    options.signal ? { signal: options.signal } : {},
  );
  const observation = readObservation(value, {
    kind: "window",
    ...("pid" in target ? { pid: target.pid } : {}),
    ...("pid" in target && target.windowId !== undefined ? { windowId: target.windowId } : {}),
    durationMs: Date.now() - started,
    screenshot: options.screenshot === true,
  });
  // `degraded` is not an error: it means the walk found nothing actionable, so
  // the caller must act on pixels from the screenshot in this same response.
  return { ...observation, elements: rankElements(observation.elements) };
}

/** Observe the whole primary display. Desktop-scope pixels come from here. */
export async function observeDesktop(
  driver: CuaDriver,
  options: { screenshot?: boolean; signal?: AbortSignal } = {},
): Promise<CuaObservation> {
  const started = Date.now();
  const value = await driver.require(
    "get_desktop_state",
    { ...(options.screenshot === false ? {} : {}) },
    options.signal ? { signal: options.signal } : {},
  );
  return readObservation(value, { kind: "desktop", durationMs: Date.now() - started, screenshot: true });
}

/** How to name the thing an action applies to. */
export type ActionPosition =
  | { elementToken: string }
  | { x: number; y: number };

export interface ActOptions {
  /**
   * `background` never raises the window. `foreground` briefly fronts it, acts,
   * and restores the previous app — the last rung, only after a background
   * attempt said it did not land.
   */
  delivery?: "background" | "foreground";
  signal?: AbortSignal;
}

function positionArgs(position: ActionPosition): Record<string, unknown> {
  if ("elementToken" in position) return { element_token: position.elementToken };
  return { x: position.x, y: position.y };
}

async function act(
  driver: CuaDriver,
  tool: string,
  args: Record<string, unknown>,
  options: ActOptions,
): Promise<CuaActionResult> {
  const started = Date.now();
  const reply = await driver.call(
    tool,
    { ...args, ...(options.delivery ? { delivery_mode: options.delivery } : {}) },
    options.signal ? { signal: options.signal } : {},
  );
  if (!reply.ok) {
    return {
      ok: false,
      verified: false,
      effect: "refused",
      refusal: { code: reply.code, message: reply.message },
      durationMs: Date.now() - started,
      raw: {},
    };
  }
  return readActionResult(reply.value, Date.now() - started);
}

/** Click an exact target: an element token (verify-able) or window pixels. */
export async function click(
  driver: CuaDriver,
  target: WindowTarget,
  position: ActionPosition,
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(driver, "click", { ...targetArgs(target), ...positionArgs(position) }, options);
}

export async function doubleClick(
  driver: CuaDriver,
  target: WindowTarget,
  position: ActionPosition,
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(driver, "double_click", { ...targetArgs(target), ...positionArgs(position) }, options);
}

export async function rightClick(
  driver: CuaDriver,
  target: WindowTarget,
  position: ActionPosition,
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(driver, "right_click", { ...targetArgs(target), ...positionArgs(position) }, options);
}

/**
 * Type into a field.
 *
 * With an element token the driver writes through accessibility; without one it
 * types into the window's focused element. Pixel delivery clicks first to give
 * the renderer focus, which is the only way into a Chromium or Electron input.
 */
export async function typeText(
  driver: CuaDriver,
  target: WindowTarget,
  input: {
    text: string;
    elementToken?: string;
    x?: number;
    y?: number;
    /** Replace the field's contents instead of inserting at the caret. */
    replace?: boolean;
  },
  options: ActOptions = {},
): Promise<CuaActionResult> {
  const args: Record<string, unknown> = {
    ...targetArgs(target),
    text: input.text,
    ...(input.elementToken ? { element_token: input.elementToken } : {}),
    ...(input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {}),
    ...(input.replace ? { replace: true } : {}),
  };
  return act(driver, "type_text", args, options);
}

/** One key. Names are the driver's: `Return`, `Escape`, `Page_Down`, `F5`, … */
export async function pressKey(
  driver: CuaDriver,
  target: WindowTarget,
  key: string,
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(driver, "press_key", { ...targetArgs(target), key }, options);
}

/** A chord, as an array of keys held together: `["ctrl", "shift", "t"]`. */
export async function hotkey(
  driver: CuaDriver,
  target: WindowTarget,
  keys: string[],
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(driver, "hotkey", { ...targetArgs(target), keys }, options);
}

/**
 * Scroll. With an element or a point the driver sends a real wheel event there,
 * which is the only way to move a nested `overflow:auto` region; without one it
 * pages the focused scroller.
 */
export async function scroll(
  driver: CuaDriver,
  target: WindowTarget,
  input: {
    direction: "up" | "down" | "left" | "right";
    elementToken?: string;
    x?: number;
    y?: number;
    amount?: number;
    by?: "line" | "page";
  },
  options: ActOptions = {},
): Promise<CuaActionResult> {
  const args: Record<string, unknown> = {
    ...targetArgs(target),
    direction: input.direction,
    ...(input.elementToken ? { element_token: input.elementToken } : {}),
    ...(input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.by ? { by: input.by } : {}),
  };
  return act(driver, "scroll", args, options);
}

/** Set an element's value directly, which needs no focus and no keystrokes. */
export async function setValue(
  driver: CuaDriver,
  target: WindowTarget,
  input: { elementToken: string; value: string },
  options: ActOptions = {},
): Promise<CuaActionResult> {
  return act(
    driver,
    "set_value",
    { ...targetArgs(target), element_token: input.elementToken, value: input.value },
    options,
  );
}

/** A screenshot of one window, or of the display when no window is named. */
export async function screenshot(
  driver: CuaDriver,
  target?: WindowTarget,
  options: { signal?: AbortSignal } = {},
): Promise<CuaScreenshot> {
  if (!target) {
    const value = await driver.require("get_desktop_state", {}, options.signal ? { signal: options.signal } : {});
    const image = readObservation(value, { kind: "desktop", durationMs: 0, screenshot: true }).screenshot;
    if (!image) throw new CuaDriverError("capture_failed", "the driver returned no image for the desktop");
    return image;
  }
  const value = await driver.require(
    "get_window_state",
    { ...targetArgs(target), include_screenshot: true, tree_format: "elements", max_elements: 1 },
    options.signal ? { signal: options.signal } : {},
  );
  const image = readObservation(value, { kind: "window", durationMs: 0, screenshot: true }).screenshot;
  if (!image) throw new CuaDriverError("capture_failed", "the driver returned no image for the window");
  return image;
}

/**
 * Run several actions in one round trip, and observe the result in the same
 * response.
 *
 * This is the cost lever: a batch is one model step instead of N, and the
 * end-of-batch read is what proves the batch landed. It also carries the
 * driver's own `expect` checks, so "type, click, wait for Thanks" is one call
 * that fails loudly instead of three calls that each look fine.
 */
export interface StepExpectation {
  role?: string;
  name?: string;
  text?: string;
  gone?: boolean;
  value?: string;
  valueContains?: string;
  enabled?: boolean;
  selected?: boolean;
  timeoutMs?: number;
}

export interface BatchStep {
  tool: "click" | "double_click" | "right_click" | "set_value" | "type_text" | "press_key" | "hotkey" | "scroll" | "drag" | "move_cursor";
  args: Record<string, unknown>;
  /** Checked before the action; a check that does not hold fails the step. */
  waitFor?: StepExpectation;
  /** Checked after the action. */
  expect?: StepExpectation[];
}

export interface BatchResult {
  ok: boolean;
  /** Index of the step that failed, when one did. */
  failedStep?: number;
  /** Which phase failed: `wait_for`, `find`, `action` or `expect`. */
  failedPhase?: string;
  /** The driver's own sentence for the first failed step. */
  failure?: string;
  steps: Array<{ ok: boolean; error?: string; code?: string; phase?: string }>;
  /** One bounded observation taken after the last executed step. */
  observed?: CuaObservation & { diffSummary?: string };
  durationMs: number;
  raw: Record<string, unknown>;
}

function wireExpectation(expectation: StepExpectation): Record<string, unknown> {
  return {
    ...(expectation.role ? { role: expectation.role } : {}),
    ...(expectation.name ? { name: expectation.name } : {}),
    ...(expectation.text ? { text: expectation.text } : {}),
    ...(expectation.gone !== undefined ? { gone: expectation.gone } : {}),
    ...(expectation.value !== undefined ? { value: expectation.value } : {}),
    ...(expectation.valueContains !== undefined ? { value_contains: expectation.valueContains } : {}),
    ...(expectation.enabled !== undefined ? { enabled: expectation.enabled } : {}),
    ...(expectation.selected !== undefined ? { selected: expectation.selected } : {}),
    ...(expectation.timeoutMs !== undefined ? { timeout_ms: expectation.timeoutMs } : {}),
  };
}

export async function runSteps(
  driver: CuaDriver,
  input: {
    target?: WindowTarget;
    steps: BatchStep[];
    /** Observe after the last step, in this same call. */
    observe?: { screenshot?: boolean; since?: "latest" | null; maxElements?: number } | false;
    /**
     * Retry a step refused for background input once, in the foreground. Off by
     * default: raising the window is a visible act, so a caller opts in.
     */
    foregroundFallback?: boolean;
    delayMs?: number;
  },
  options: { signal?: AbortSignal } = {},
): Promise<BatchResult> {
  const started = Date.now();
  const args: Record<string, unknown> = {
    ...(input.target ? targetArgs(input.target) : {}),
    steps: input.steps.map((step) => ({
      [step.tool]: step.args,
      ...(step.waitFor ? { wait_for: wireExpectation(step.waitFor) } : {}),
      ...(step.expect?.length ? { expect: step.expect.map(wireExpectation) } : {}),
    })),
    ...(input.foregroundFallback ? { foreground_fallback: true } : {}),
    ...(input.delayMs !== undefined ? { delay_ms: input.delayMs } : {}),
    ...(input.observe === false
      ? {}
      : {
          observe: {
            include_screenshot: input.observe?.screenshot === true,
            since: input.observe?.since === null ? null : (input.observe?.since ?? "latest"),
            ...(input.observe?.maxElements ? { max_elements: input.observe.maxElements } : {}),
          },
        }),
  };

  const reply = await driver.call("run_steps", args, options.signal ? { signal: options.signal } : {});
  const durationMs = Date.now() - started;
  if (!reply.ok) {
    return {
      ok: false,
      steps: [],
      failure: reply.message,
      durationMs,
      raw: { code: reply.code },
    };
  }

  const value = reply.value;
  const refusal = readRefusal(value);
  // MEASURED shape: `{ok, executed, failed_step, total, steps[], observation}`,
  // where `observation` is `{ok, tool, summary, state}` and `state` is a
  // `get_window_state` payload. A failed step carries `message`, `phase` and a
  // refusal `code`; there is no top-level `detail` to fall back on.
  const rawSteps = Array.isArray(value.steps) ? (value.steps as Array<Record<string, unknown>>) : [];
  const steps = rawSteps.map((step) => ({
    ok: step.ok === true,
    ...(typeof step.message === "string" ? { error: step.message } : {}),
    ...(typeof step.code === "string" ? { code: step.code } : {}),
    ...(typeof step.phase === "string" ? { phase: step.phase } : {}),
  }));
  const failed = steps.find((step) => !step.ok);
  const observation = value.observation as Record<string, unknown> | undefined;
  const state = observation?.state as Record<string, unknown> | undefined;
  const observed =
    input.observe !== false && state
      ? readObservation(state, {
          kind: "window",
          durationMs,
          screenshot: input.observe?.screenshot === true,
        })
      : undefined;

  return {
    ok: value.ok === true && !refusal,
    ...(typeof value.failed_step === "number" ? { failedStep: value.failed_step } : {}),
    ...(failed?.phase ? { failedPhase: failed.phase } : {}),
    ...(refusal
      ? { failure: refusal.message }
      : failed?.error
        ? { failure: failed.error }
        : {}),
    steps,
    ...(observed
      ? {
          observed: {
            ...observed,
            elements: rankElements(observed.elements),
            ...(typeof observation?.summary === "string" ? { diffSummary: observation.summary } : {}),
          },
        }
      : {}),
    durationMs,
    raw: value,
  };
}
