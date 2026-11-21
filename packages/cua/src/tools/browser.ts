import type { CuaDriver } from "../driver/cli.ts";
import { CuaDriverError, readRefusal } from "../driver/cli.ts";
import { readActionResult, readPageState } from "../driver/parse.ts";
import { detectCaptcha, describeDetection } from "../captcha/detect.ts";
import type { CaptchaDetection, CuaActionResult, CuaBrowserTarget, CuaPageState } from "../types.ts";

/**
 * Browser use, through the driver's own CDP tools — not a second Playwright.
 *
 * The driver binds browser capability to an **exact native window** and then
 * acts over CDP: it reaches an occluded tab without moving the real cursor or
 * taking focus, and it refuses rather than guessing which window it is talking
 * to. That is the whole reason to route page work through it: our bots run on a
 * box whose desktop a person may be watching, so "act on the page without
 * stealing the screen" is a requirement, not a nicety.
 *
 * Mutation always starts from a bound window. Two routes get there:
 *
 * - `prepareBrowser` with an **isolated, driver-owned profile**: a separate
 *   Chromium process the driver owns, per bot, with its own cookie jar. This is
 *   the default, because a bot's sessions must be its own and must persist.
 * - `prepareBrowser` against an **existing profile**: only when the task needs
 *   the sign-in already in that profile, and only where the host grants it.
 *
 * Everything below is a plain function over explicit arguments; no schema and
 * no loop lives here.
 */

export interface BrowserWindowRef {
  pid: number;
  windowId: number;
}

/**
 * Bind the browser tools to a window, launching an isolated driver-owned
 * Chromium when there is nothing bound yet.
 *
 * `profile` is the session-persistence lever: `isolated_named` keeps cookies and
 * logins across runs under a name, so a sign-in done once is not challenged
 * again — which is the cheapest way past most real friction. `isolated_new`
 * throws the profile away at the end of the session.
 */
export async function prepareBrowser(
  driver: CuaDriver,
  input: {
    window?: BrowserWindowRef;
    /** Named profile to keep, or a throwaway one. */
    profile?: { mode: "isolated_new" | "isolated_named"; name?: string };
    /** Attach to a signed-in profile instead. Needs a host grant; off by default. */
    existingProfile?: boolean;
    /** Launch a browser when none is running. */
    allowLaunch?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ prepared: boolean; pid?: number; action?: string; message?: string; sideEffects?: Record<string, boolean> }> {
  const args: Record<string, unknown> = {
    ...(input.window ? { pid: input.window.pid, window_id: input.window.windowId } : {}),
    ...(input.allowLaunch !== false ? { allow_launch: true } : {}),
    ...(input.existingProfile
      ? { strategy: { kind: "existing_profile" } }
      : {
          profile: {
            mode: input.profile?.mode ?? "isolated_named",
            ...(input.profile?.name ? { name: input.profile.name } : {}),
          },
        }),
  };
  const reply = await driver.call("browser_prepare", args, input.signal ? { signal: input.signal } : {});
  if (!reply.ok) throw new CuaDriverError(reply.code, reply.message);
  const refusal = readRefusal(reply.value);
  if (refusal) throw new CuaDriverError(refusal.code, refusal.message);

  const value = reply.value;
  return {
    prepared: value.prepared === true || value.status === "ok",
    ...(typeof value.prepared_pid === "number" ? { pid: value.prepared_pid } : {}),
    ...(typeof value.action === "string" ? { action: value.action } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(value.side_effects && typeof value.side_effects === "object"
      ? { sideEffects: value.side_effects as Record<string, boolean> }
      : {}),
  };
}

/**
 * Bind (mode 1) or snapshot (mode 2) a browser.
 *
 * Binding returns the opaque `targetId` and the active `tabId`; both die when
 * the session ends, so a caller keeps them for the length of a task and not
 * longer. A snapshot returns refs, which die on the next snapshot or navigation.
 */
export async function browserState(
  driver: CuaDriver,
  input:
    | { window: BrowserWindowRef; signal?: AbortSignal }
    | {
        targetId: string;
        tabId: string;
        /** `semantic_v2` is the only format that returns typed refs. */
        format?: "semantic_v2" | "dom_refs_v1";
        query?: string;
        /** Read one subtree of an element a previous snapshot returned. */
        scopeRef?: string;
        continuation?: string;
        screenshot?: boolean;
        signal?: AbortSignal;
      },
): Promise<CuaBrowserTarget | CuaPageState> {
  const isBind = "window" in input;
  const args: Record<string, unknown> = isBind
    ? { pid: input.window.pid, window_id: input.window.windowId }
    : {
        target_id: input.targetId,
        tab_id: input.tabId,
        snapshot_format: input.format ?? "semantic_v2",
        ...(input.query ? { query: input.query } : {}),
        ...(input.scopeRef ? { scope_ref: input.scopeRef } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
        ...(input.screenshot ? { include_screenshot: true } : {}),
      };

  const started = Date.now();
  const reply = await driver.call("get_browser_state", args, input.signal ? { signal: input.signal } : {});
  if (!reply.ok) throw new CuaDriverError(reply.code, reply.message);

  const refusal = readRefusal(reply.value);
  if (refusal) {
    // Both of these mean "call browser_prepare", and the driver says so. A
    // caller that surfaces the code can recover without knowing the vocabulary.
    throw new CuaDriverError(refusal.code, refusal.message);
  }

  if (isBind) {
    const value = reply.value;
    const tabs = Array.isArray(value.tabs) ? (value.tabs as Array<Record<string, unknown>>) : [];
    const active = tabs.find((tab) => tab.active === true) ?? tabs[0];
    if (typeof value.target_id !== "string" || !active) {
      throw new CuaDriverError("browser_binding_stale", "the driver returned no target or tab for this window");
    }
    return {
      targetId: value.target_id,
      tabId: String(active.tab_id ?? ""),
      bindingQuality: String(value.binding_quality ?? "approx"),
      url: typeof active.url === "string" ? active.url : null,
      title: typeof active.title === "string" ? active.title : null,
      tabs: tabs.map((tab) => ({
        tabId: String(tab.tab_id ?? ""),
        url: typeof tab.url === "string" ? tab.url : null,
        title: typeof tab.title === "string" ? tab.title : null,
        active: typeof tab.active === "boolean" ? tab.active : null,
      })),
    };
  }

  return readPageState(reply.value, Date.now() - started);
}

/** Navigate one tab. Every ref on the tab is invalid afterwards. */
export async function browserNavigate(
  driver: CuaDriver,
  input: { targetId: string; tabId: string; url: string; signal?: AbortSignal },
): Promise<{ url: string | null }> {
  const reply = await driver.call(
    "browser_navigate",
    { target_id: input.targetId, tab_id: input.tabId, url: input.url },
    input.signal ? { signal: input.signal } : {},
  );
  if (!reply.ok) throw new CuaDriverError(reply.code, reply.message);
  const refusal = readRefusal(reply.value);
  if (refusal) throw new CuaDriverError(refusal.code, refusal.message);
  return { url: typeof reply.value.url === "string" ? reply.value.url : null };
}

async function pageAct(
  driver: CuaDriver,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CuaActionResult> {
  const started = Date.now();
  const reply = await driver.call(tool, args, signal ? { signal } : {});
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

/**
 * Click a page element by ref, or a viewport point.
 *
 * `inputRoute` matters on Linux: trusted CDP input raises the browser there and
 * refuses with `browser_input_trust_unavailable`. `dom_event` stays in the
 * background and reports `unverifiable` — which is honest, not a failure, and
 * the caller confirms with a fresh snapshot.
 */
export async function browserClick(
  driver: CuaDriver,
  input: {
    targetId: string;
    tabId: string;
    ref?: string;
    x?: number;
    y?: number;
    inputRoute?: "trusted" | "dom_event";
    signal?: AbortSignal;
  },
): Promise<CuaActionResult> {
  return pageAct(
    driver,
    "browser_click",
    {
      target_id: input.targetId,
      tab_id: input.tabId,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {}),
      ...(input.inputRoute ? { input_route: input.inputRoute } : {}),
    },
    input.signal,
  );
}

/** Type into a page element by ref. `keystrokes` fires real key events. */
export async function browserType(
  driver: CuaDriver,
  input: {
    targetId: string;
    tabId: string;
    text: string;
    ref?: string;
    replace?: boolean;
    mode?: "insert_text" | "keystrokes";
    signal?: AbortSignal;
  },
): Promise<CuaActionResult> {
  return pageAct(
    driver,
    "browser_type",
    {
      target_id: input.targetId,
      tab_id: input.tabId,
      text: input.text,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.replace ? { replace: true } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    },
    input.signal,
  );
}

/** Pick one option of a native `<select>` without opening its popup. */
export async function browserSelect(
  driver: CuaDriver,
  input: { targetId: string; tabId: string; ref: string; value: string; signal?: AbortSignal },
): Promise<CuaActionResult> {
  return pageAct(
    driver,
    "browser_select",
    { target_id: input.targetId, tab_id: input.tabId, ref: input.ref, value: input.value },
    input.signal,
  );
}

/** Hover, right-click, double-click, scroll or drag inside a bound tab. */
export async function browserPointer(
  driver: CuaDriver,
  input: {
    targetId: string;
    tabId: string;
    action: "hover" | "right_click" | "double_click" | "scroll" | "drag";
    ref?: string;
    x?: number;
    y?: number;
    destinationRef?: string;
    direction?: "up" | "down" | "left" | "right";
    amount?: number;
    signal?: AbortSignal;
  },
): Promise<CuaActionResult> {
  return pageAct(
    driver,
    "browser_pointer",
    {
      target_id: input.targetId,
      tab_id: input.tabId,
      action: input.action,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {}),
      ...(input.destinationRef ? { destination_ref: input.destinationRef } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
    },
    input.signal,
  );
}

/** Inspect or resolve a page-owned `alert`, `confirm`, `prompt` or `beforeunload`. */
export async function browserDialog(
  driver: CuaDriver,
  input: {
    targetId: string;
    tabId: string;
    action: "inspect" | "accept" | "dismiss";
    dialogId?: string;
    promptText?: string;
    signal?: AbortSignal;
  },
): Promise<CuaActionResult> {
  return pageAct(
    driver,
    "browser_dialog",
    {
      target_id: input.targetId,
      tab_id: input.tabId,
      action: input.action,
      ...(input.dialogId ? { dialog_id: input.dialogId } : {}),
      ...(input.promptText !== undefined ? { prompt_text: input.promptText } : {}),
    },
    input.signal,
  );
}

/**
 * A page snapshot with the challenge state attached.
 *
 * Detection rides on the snapshot the caller was going to take anyway — the
 * frame list and the visible text are already in it — so knowing the page is
 * gated costs nothing extra. The detection is returned as state and never as a
 * throw: the model has to be able to say "this needs a human" instead of
 * retrying clicks on a widget that will never answer.
 */
export async function readPage(
  driver: CuaDriver,
  input: {
    targetId: string;
    tabId: string;
    query?: string;
    scopeRef?: string;
    continuation?: string;
    screenshot?: boolean;
    signal?: AbortSignal;
  },
): Promise<CuaPageState & { captcha: CaptchaDetection; captchaDescription: string }> {
  const state = (await browserState(driver, { ...input, format: "semantic_v2" })) as CuaPageState;

  const frameUrls = [
    ...state.refs.map((ref) => ref.frame ?? ""),
    ...state.content.map((ref) => ref.frame ?? ""),
  ].filter((url) => url.length > 0);

  const captcha = detectCaptcha({
    frameUrls,
    text: [state.outline, ...state.content.map((entry) => entry.value ?? entry.name ?? "")].join("\n"),
    title: state.title,
    // The refs carry the widget hrefs when the driver exposes them as nodes.
    html: state.refs.map((ref) => `${ref.role} ${ref.name ?? ""} ${ref.value ?? ""}f`).join("\n"),
  });

  return { ...state, captcha, captchaDescription: describeDetection(captcha) };
}

/**
 * Close the driver's session, which ends a driver-owned browser and its
 * throwaway profile. A `isolated_named` profile keeps its files.
 */
export async function endBrowserSession(driver: CuaDriver, options: { signal?: AbortSignal } = {}): Promise<void> {
  await driver.call("end_session", {}, options.signal ? { signal: options.signal } : {});
}
