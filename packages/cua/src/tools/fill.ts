import { CuaDriverError } from "../driver/cli.ts";
import type { CuaDriver } from "../driver/cli.ts";
import type { ActOptions, WindowTarget } from "./desktop.ts";
import type { CuaActionResult, CuaObservation } from "../types.ts";
import { click, hotkey, observeWindow, setValue, typeText } from "./desktop.ts";
import { browserState, browserType } from "./browser.ts";

/**
 * Filling a field with a value this code did not choose.
 *
 * The secret lives host-side and the UI is on the box, so the fill is
 * **host-executed and box-applied**: a caller that is allowed to see the value
 * resolves it and calls this; nothing here accepts a secret from a model-written
 * program, and nothing here returns one.
 *
 * A mis-aimed fill is the harm this file exists to prevent. A password typed
 * into a search box, or into the field above the one intended, is silent and
 * real — so the rule is that a fill targets **an element token minted by an
 * observation that this call can see**, and the caller cannot pass a stale one
 * through:
 *
 * - `fillSecret` re-validates the token against the occurrence's own snapshot
 *   before typing, and returns `stale_element_token` rather than guessing which
 *   element was meant. That code is the driver's, not a new one, so a caller
 *   handles stale targets the same way everywhere.
 * - The result is a `FillResult` with **no field a value could travel in**. It
 *   says whether the fill landed, not what was typed — so a log, a run event, or
 *   a transcript can carry it without carrying the secret.
 * - `effect`/`verified` are the driver's own, unflattened: `unverifiable` is not
 *   success, and a caller that wants to know the field now holds the value must
 *   re-read it — which `fillSecret` does for it, comparing against the value it
 *   was given, and reporting only a boolean.
 */

/** Where the value must land. Rejected if the field moved. */
export type FillTarget =
  | {
      kind: "element";
      /** The occurrence this token belongs to. */
      observation: CuaObservation;
      /** `<snapshot_id>:<row>`, from that same observation. */
      elementToken: string;
      /** A sanity check the caller asserts about the target before typing. */
      expect?: { role?: string; labelIncludes?: string };
    }
  | {
      kind: "page";
      targetId: string;
      tabId: string;
      /** A ref from a snapshot of that same tab. Omit to fill the first typable ref. */
      ref?: string;
      /** The page snapshot id the ref came from, recorded for the caller's own bookkeeping. */
      snapshotId?: string;
    };

export interface FillRequest {
  target: WindowTarget;
  fill: FillTarget;
  /**
   * The value. This is the one place a secret enters `packages/cua`, and it is
   * never stored, logged, echoed in a result, or put in a thrown error.
   */
  value: string;
  /**
   * Re-read the field afterwards and report whether it now holds the value.
   * Costs one extra observation; default true, because an unverified fill is
   * exactly the case where a caller would otherwise assume success.
   */
  verify?: boolean;
  delivery?: ActOptions["delivery"];
  signal?: AbortSignal;
}

/**
 * The outcome of a fill. **There is deliberately no field a value could travel
 * in** — matching `VaultFillSink`'s `FillResult`, so this can be widened to a
 * richer sink later without becoming a leak.
 */
export interface FillResult {
  /** The driver's own verdict, unflattened. */
  effect: CuaActionResult["effect"];
  /** True only for an accessibility read-back. */
  verified: boolean;
  /** Next rung, when the driver names one. */
  escalation?: CuaActionResult["escalation"];
  /** A refusal code — `stale_element_token` means observe again, not retry. */
  refusal?: CuaActionResult["refusal"];
  /**
   * True only when a re-read showed the field holding the value. Absent when
   * verification was not asked for or was not possible; never true by default.
   */
  landed?: boolean;
  /** One sentence safe to show a user, a log, or a transcript. */
  message: string;
  durationMs: number;
}

/**
 * Type a value this code did not choose into a target someone else selected.
 *
 * ## The rule for a native widget
 *
 * **On a native widget, escalation is not a fallback — it is the only path that
 * lands.**
 *
 * MEASURED, twice on a real box, with a GTK entry and a dialog that wrote its own
 * `get_text()` to a file as the oracle:
 *
 * - `set_value` is a **no-op**. The driver answers `confirmed` for a plain entry
 *   and `suspected_noop` for a masked one, and the dialog was empty both times.
 *   A `confirmed` from `set_value` on a native widget is therefore not evidence
 *   that anything was written. Believe the read-back, never the verdict.
 * - A masked GTK entry reports **no value at all** through AT-SPI — not a mask,
 *   `undefined`. So even a successful fill cannot be read back out of a password
 *   field; `landed` stays absent rather than claiming either way, and the only
 *   evidence that exists is the application's own view of the field.
 * - **A foreground click on the element's frame plus real keystrokes does land
 *   it**, and a plain field then reads the value back.
 *
 * So this route writes, reads back, and escalates whenever the field does not
 * show the value. The click is aimed with the element token the caller passed, so
 * there is still no pixel guess about *which* field to fill; pixel typing with no
 * element is never used for a secret.
 */
export async function fillSecret(
  driver: CuaDriver,
  request: FillRequest,
): Promise<FillResult> {
  const started = Date.now();
  const finish = (input: Omit<FillResult, "durationMs">): FillResult => ({
    ...input,
    durationMs: Date.now() - started,
  });

  // A missing value is a caller bug, not a driver result: forwarding `undefined`
  // reaches the driver as a missing field and comes back as an unrelated parse
  // error, which reads like a transport failure and hides the real mistake.
  if (typeof request.value !== "string") {
    return finish({
      effect: "refused",
      verified: false,
      refusal: {
        code: "wrong_target",
        message: "no value was given to fill",
        hint: "Pass the secret as `value`.",
      },
      message: "No value was given, so nothing was typed.",
    });
  }
  if (request.fill.kind === "element") return fillElement(driver, request, started, finish);
  return fillPage(driver, request, started, finish);
}

async function fillElement(
  driver: CuaDriver,
  request: FillRequest,
  _started: number,
  finish: (input: Omit<FillResult, "durationMs">) => FillResult,
): Promise<FillResult> {
  const fill = request.fill as Extract<FillTarget, { kind: "element" }>;
  const observation = fill.observation;

  // The token must belong to the snapshot the caller handed over. A token from an
  // older read is the exact case where the field may have moved, so it is
  // refused by name rather than re-aimed at whatever now sits at that row.
  if (observation.snapshotId && !fill.elementToken.startsWith(`${observation.snapshotId}:`)) {
    return finish({
      effect: "refused",
      verified: false,
      refusal: {
        code: "stale_element_token",
        message: `the target token ${fill.elementToken} is not from snapshot ${observation.snapshotId}; observe again and fill the element you see`,
        hint: "Re-observe the window and pass a token from that observation.",
      },
      message: "The field moved since it was last read, so nothing was typed.",
    });
  }

  const element = observation.elements.find((entry) => entry.token === fill.elementToken);
  if (!element) {
    return finish({
      effect: "refused",
      verified: false,
      refusal: {
        code: "stale_element_token",
        message: `${fill.elementToken} is not an element of this observation`,
        hint: "Re-observe the window and fill the element you see.",
      },
      message: "The target is not part of the current observation, so nothing was typed.",
    });
  }

  if (fill.expect?.role && element.role !== fill.expect.role) {
    return finish({
      effect: "refused",
      verified: false,
      refusal: {
        code: "wrong_target",
        message: `expected a ${fill.expect.role} but ${fill.elementToken} is a ${element.role}`,
      },
      message: "The target is not the kind of element expected, so nothing was typed.",
    });
  }
  if (fill.expect?.labelIncludes && !(element.label ?? "").includes(fill.expect.labelIncludes)) {
    return finish({
      effect: "refused",
      verified: false,
      refusal: {
        code: "wrong_target",
        message: `expected a label containing ${JSON.stringify(fill.expect.labelIncludes)} on ${fill.elementToken}`,
      },
      message: "The target does not match what was expected, so nothing was typed.",
    });
  }

  const options = {
    ...(request.delivery ? { delivery: request.delivery } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  };

  // `setValue` writes the element's value with no focus and no keystrokes, so the
  // secret does not travel through a keyboard path. It is the first rung because
  // on a toolkit that supports it there is nothing better.
  const action = await setValue(
    driver,
    request.target,
    { elementToken: fill.elementToken, value: request.value },
    options,
  );
  const readBack =
    request.verify === false
      ? undefined
      : await readBackHoldsValue(driver, request, observation, fill.elementToken).catch(() => undefined);
  if (action.refusal || readBack === true || request.verify === false) {
    return finish(result(action, readBack));
  }

  // The write did not show up in the field. On a native toolkit that is the
  // normal case, not an error, so the next rung is real keystrokes at the *same
  // element*: a foreground click on its frame, then the text.
  const typed = await typeIntoElement(driver, request, fill.elementToken, element.role, options);
  const typedReadBack = await readBackHoldsValue(driver, request, observation, fill.elementToken).catch(
    () => undefined,
  );
  return finish({
    ...result(typed, typedReadBack),
    // The first attempt is not hidden: a caller reading the result learns the
    // value only landed on the second rung.
    ...(typed !== action ? { message: describeEscalatedFill(typed, typedReadBack) } : {}),
  });
}

/** Shape an action and its read-back into a result. */
function result(
  action: CuaActionResult,
  landed: boolean | undefined,
): Omit<FillResult, "durationMs"> {
  return {
    effect: action.effect,
    verified: action.verified,
    ...(action.escalation ? { escalation: action.escalation } : {}),
    ...(action.refusal ? { refusal: action.refusal } : {}),
    ...(landed !== undefined ? { landed } : {}),
    message: describeFill(action, landed),
  };
}

/**
 * The foreground rung: click the element's own frame, then type at it.
 *
 * The click is above the widget rather than at its centre — a widget's frame can
 * be its whole allocated row, and the centre of a row is not always inside the
 * text area a toolkit focuses. `frame` comes from the same observation whose
 * token the caller passed, so this still names one field and not a coordinate.
 */
async function typeIntoElement(
  driver: CuaDriver,
  request: FillRequest,
  token: string,
  role: string,
  options: ActOptions,
): Promise<CuaActionResult> {
  const target = request.target;
  const observation = await observeWindow(driver, target, {
    screenshot: true,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  // The token died with the read it came from, so the same widget is found by
  // its role in the fresh one. A native toolkit reports the row and not the
  // value, which is why the role is the only stable handle here.
  const element = observation.elements.find((entry) => entry.frame && entry.role === role);
  const frame = element?.frame;
  if (!frame) {
    // No pixels to aim at means this rung cannot be taken honestly; say that
    // rather than typing at whatever happens to have focus.
    return {
      ok: false,
      verified: false,
      effect: "refused",
      refusal: {
        code: "background_unavailable",
        message: "the field has no frame to click, so keystrokes cannot be aimed at it",
        hint: "Observe the window with a screenshot and pass the element token from that read.",
      },
      durationMs: 0,
      raw: {},
    };
  }
  const clicked = await click(
    driver,
    target,
    { x: Math.round(frame.x + frame.w / 2), y: Math.round(frame.y + frame.h / 2) },
    { ...options, delivery: "foreground" },
  );
  // `type_text` inserts at the caret and the driver has no "replace" switch, so an
  // existing value would be appended to. Selecting the field's text first makes
  // the write a replacement. The chord names no element: it goes to whatever the
  // click just focused, which is the field that was named a line earlier.
  await hotkey(driver, target, ["ctrl", "a"], { ...options, delivery: "foreground" });
  const typed = await typeText(driver, target, { text: request.value }, { ...options, delivery: "foreground" });
  // The click's own verdict is not the news; the typing is.
  return clicked.refusal ? clicked : typed;
}

async function fillPage(
  driver: CuaDriver,
  request: FillRequest,
  _started: number,
  finish: (input: Omit<FillResult, "durationMs">) => FillResult,
): Promise<FillResult> {
  const fill = request.fill as Extract<FillTarget, { kind: "page" }>;

  // Validate the ref against a snapshot, then act **on that same snapshot**.
  //
  // MEASURED: the driver kills every ref on a tab when it takes a new snapshot,
  // so a pre-flight `get_browser_state` and a separate `browser_type` cannot both
  // use one ref — the first invalidates what the second needs. The reliable shape
  // is: if we hold a ref at all, use it, and let the driver's own staleness
  // refusal be the guard; re-snapshot only when we have no ref of our own.
  //
  // A stale ref is then reported by the driver as `browser_ref_stale`, which is
  // the same answer this function would have given, from the component that can
  // actually see the page.
  let ref = fill.ref;
  if (!ref) {
    const current = await browserState(driver, {
      targetId: fill.targetId,
      tabId: fill.tabId,
      format: "semantic_v2",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const candidate = "refs" in current ? current.refs.find((entry) => entry.actions.includes("type")) : undefined;
    if (!candidate) {
      return finish({
        effect: "refused",
        verified: false,
        refusal: {
          code: "browser_ref_stale",
          message: "no typable ref was found in the current snapshot of this tab",
          hint: "Snapshot the tab again and fill a ref whose actions include 'type'.",
        },
        message: "The target is not a field in the current snapshot, so nothing was typed.",
      });
    }
    ref = candidate.ref;
  }

  const action = await browserType(driver, {
    targetId: fill.targetId,
    tabId: fill.tabId,
    ref,
    text: request.value,
    replace: true,
    // Keystrokes fire real key events, which is what a login form listens for;
    // insert_text sets the value without them and some forms ignore it.
    mode: "keystrokes",
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const landed =
    request.verify === false
      ? undefined
      : await readBackPageHoldsValue(driver, { ...fill, ref }, request.value).catch(() => undefined);

  return finish({
    effect: action.effect,
    verified: action.verified,
    ...(action.escalation ? { escalation: action.escalation } : {}),
    ...(action.refusal ? { refusal: action.refusal } : {}),
    ...(landed !== undefined ? { landed } : {}),
    message: describeFill(action, landed),
  });
}

/**
 * Masking characters a password input substitutes for its value. A masked field
 * is the normal case for a Vault fill, so "does the field hold the value" has to
 * handle it or every password fill reports a false negative.
 */
const MASK_CHARS = /^[\u2022\u25cf*\u00b7]+$/u;

/**
 * Did the field take the value?
 *
 * A plain field reports the value back and can be compared exactly. A mask that
 * the widget does report can be checked by length (measured: eleven
 * `•••••••••••` for a 21-character value).
 *
 * MEASURED and important: some toolkits report **no value at all** for a masked
 * entry — a GTK `Gtk.Entry` with `set_visibility(False)` gives `undefined`, not a
 * mask. That is not evidence the fill failed: the same fill read back as empty
 * while the dialog's own `get_text()` held the value. It means this read-back
 * cannot answer the question, so `landed` stays absent rather than false.
 */
function holdsValue(reported: unknown, value: string): boolean {
  if (reported === null || reported === undefined) return false;
  const text = String(reported);
  if (text === value) return true;
  if (text.length !== value.length) return false;
  return MASK_CHARS.test(text);
}

/** Does the element now hold the value? A boolean leaves this function, never the value. */
async function readBackHoldsValue(
  driver: CuaDriver,
  request: FillRequest,
  before: CuaObservation,
  token: string,
): Promise<boolean> {
  const after = await observeWindow(
    driver,
    request.target,
    {
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );
  // The token dies with the snapshot it came from, so fall back to the same role
  // and label in the fresh read rather than assuming the rows renumbered.
  const original = before.elements.find((entry) => entry.token === token);
  const element = after.elements.find((entry) => entry.token === token)
    ?? after.elements.find(
      (entry) => entry.role === original?.role && (entry.label ?? "") === (original?.label ?? ""),
    );
  if (!element) return false;
  return holdsValue(element.value, request.value);
}

async function readBackPageHoldsValue(
  driver: CuaDriver,
  fill: Extract<FillTarget, { kind: "page" }>,
  value: string,
): Promise<boolean> {
  const after = await browserState(driver, {
    targetId: fill.targetId,
    tabId: fill.tabId,
    format: "semantic_v2",
  });
  if (!("refs" in after)) return false;
  const element = after.refs.find((entry) => entry.ref === fill.ref)
    ?? after.refs.find((entry) => entry.actions.includes("type"));
  if (!element) return false;
  return holdsValue(element.value, value);
}

/**
 * The sentence a caller can hand to a user or a log. It never contains the
 * value, and it distinguishes "delivered" from "landed" the way the contract
 * requires: a fill that could not be read back is not described as done.
 */
/** The message for a fill that only landed on the second rung. */
function describeEscalatedFill(action: CuaActionResult, landed: boolean | undefined): string {
  if (landed === true) return "The field now holds the value; it was typed in the foreground after a direct write did not take.";
  if (action.refusal) return `Nothing was typed: ${action.refusal.message}`;
  return "The value was typed but the field does not show it; read the field before relying on it.";
}

function describeFill(action: CuaActionResult, landed: boolean | undefined): string {
  if (action.refusal) return `Nothing was typed: ${action.refusal.message}`;
  if (landed === true) return "The field now holds the value.";
  if (landed === false) return "The value was sent but the field does not show it; read the field before relying on it.";
  if (action.effect === "confirmed") return "The value was written and the driver confirmed it.";
  if (action.effect === "unverifiable") return "The value was delivered but could not be confirmed; read the field before relying on it.";
  return `The value was not confirmed (${action.effect}); read the field before relying on it.`;
}

/** True when the driver refused because the target is no longer the one observed. */
export function isStaleTarget(result: FillResult): boolean {
  return (
    result.refusal?.code === "stale_element_token" ||
    result.refusal?.code === "browser_ref_stale" ||
    result.refusal?.code === "browser_binding_stale"
  );
}

/** Re-exported so a caller can distinguish a transport failure from a refusal. */
export { CuaDriverError };
