/**
 * The shapes a Cua Driver call comes back in, normalised.
 *
 * The driver's own contract is the source of truth here, and one rule from it
 * shapes every type in this file: **a delivered event is not an applied
 * change.** A click that returned is not a click that landed, so the result of
 * every action says how far it got, and what rung to climb if it did not.
 */

/** Why a call did not complete, in the driver's own vocabulary. */
export type CuaRefusalCode =
  /** The element token came from a snapshot that a newer read replaced. */
  | "stale_element_token"
  /** A token that is not `<snapshot_id>:<row>` at all. */
  | "invalid_element_token"
  /** Nothing free-focus can reach: the toolkit only accepts real global input. */
  | "background_unavailable"
  /** `pid` owns several top-level windows; name one. */
  | "ambiguous_window_target"
  | "window_target_not_found"
  /** Window-relative pixels need a screenshot read of that window first. */
  | "screenshot_context_missing"
  /** The browser is not attached to the tools yet; call `browser_prepare`. */
  | "browser_requires_setup"
  /** An existing profile needs a grant the host has not given. */
  | "browser_consent_required"
  | "browser_consent_revoked"
  /** The page snapshot or binding is older than the page. */
  | "browser_ref_stale"
  | "browser_binding_stale"
  /** Trusted input would raise the browser window; ask for `dom_event` instead. */
  | "browser_input_trust_unavailable"
  /** No typed route to this surface at all (Safari, Firefox, WebKitGTK, …). */
  | "browser_route_unavailable"
  | "browser_wrong_target_refused"
  | "browser_endpoint_owner_mismatch"
  /** Session lifecycle: another transport holds the label, or it was ended. */
  | "session_owned_by_other_transport"
  | "session_ended"
  /** The run script / steps batch broke its own rules. */
  | "invalid_batch"
  | "capture_not_found"
  | "capture_expired"
  /** The driver itself could not run: no daemon, no desktop, no Cua Driver. */
  | "driver_unavailable"
  | "driver_timeout"
  /** Something the driver reported that this build does not know yet. */
  | string;

/** The ladder, in the order the driver ranks it. */
export type EscalationRung = "element" | "px" | "page" | "foreground";

export interface CuaEscalation {
  /** The next rung to try, in driver terms (`px`, `foreground`, `page`). */
  recommended: "px" | "foreground" | "page";
  reason: string;
}

/**
 * How far an action got.
 *
 * - `confirmed` — read back through accessibility; the change happened.
 * - `unverifiable` — the event was delivered but the driver cannot prove the
 *   app applied it. Electron, Catalyst, and web content echo writes they did
 *   not apply, so this is a real state, not a formality.
 * - `suspected_noop` — delivered, and nothing observable moved.
 * - `partial` — some of the batch applied.
 * - `refused` — nothing was sent.
 */
export type CuaEffect = "confirmed" | "unverifiable" | "suspected_noop" | "partial" | "refused";

/** A PNG the driver captured, base64 as it came back. */
export interface CuaScreenshot {
  data: string;
  mime: string;
  width?: number;
  height?: number;
}

export interface CuaEvidence {
  kind: string;
  detail: string;
}

/** What every action returns. */
export interface CuaActionResult {
  /** True only when the driver read the change back through accessibility. */
  verified: boolean;
  effect: CuaEffect;
  /** Present when the driver knows a rung that could work instead. */
  escalation?: CuaEscalation;
  /** The delivery route that actually ran (`x11_pixel`, `cgevent_fg`, …). */
  path?: string;
  /** Human-readable account of what was sent and what changed. */
  summary?: string;
  delivery?: { mode?: string };
  evidence?: CuaEvidence[];
  /** Refusals carry a code and a hint; `stale_element_token` means observe again. */
  refusal?: { code: CuaRefusalCode; message: string; hint?: string };
  /**
   * Set when the driver says the whole thing did not happen. Callers must not
   * report success on a refused action, whatever the model wants to say.
   */
  ok: boolean;
  /** Milliseconds the call took on the box. */
  durationMs: number;
  /**
   * The raw driver payload, kept for the transcript and for debugging. Safe to
   * persist: it contains coordinates and labels, never credentials.
   */
  raw: Record<string, unknown>;
}

/** One actionable row of an accessibility tree. */
export interface CuaElement {
  /** `<snapshot_id>:<row>` — only valid until the next read of that window. */
  token: string;
  role: string;
  label?: string;
  value?: string | number | boolean | null;
  enabled?: boolean;
  selected?: boolean;
  /** What the toolkit says can be done to it (`click`, `activate`, `edit`, …). */
  actions?: string[];
  /** Window-local screenshot pixels. */
  frame?: { x: number; y: number; w: number; h: number };
  /** True when the element is outside the visible area. */
  offscreen?: boolean;
  description?: string;
}

/** The observation: a tree, a snapshot id, and optionally an image. */
export interface CuaObservation {
  kind: "window" | "desktop";
  pid?: number;
  windowId?: number;
  title?: string | null;
  appName?: string | null;
  snapshotId: string;
  /** The accessibility rows, in tree order. */
  elements: CuaElement[];
  /**
   * The compact text form of the tree, which is what the model should read
   * first: it costs a fraction of a screenshot and carries every target.
   */
  outline: string;
  /** True when the walk found no actionable elements (bridge down, canvas app). */
  degraded: boolean;
  degradedReason?: string;
  truncated: boolean;
  /** Only present when the caller asked for the image; base64 PNG. */
  screenshot?: { data: string; mime: string; width?: number; height?: number };
  /** Rows that a newer read of this window replaced. */
  invalidatedSnapshotIds?: string[];
  durationMs: number;
}

/** One open top-level window on the box. */
export interface CuaWindow {
  pid: number;
  windowId: number;
  appName: string | null;
  title: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  isOnScreen: boolean;
  /** Highest z-index is the frontmost window; null when stacking is unknown. */
  zIndex: number | null;
}

export interface CuaApp {
  name: string;
  pid: number;
  running: boolean;
  active: boolean;
  windowCount?: number;
}

/** A bound browser tab, and what the driver thinks of it. */
export interface CuaBrowserTarget {
  targetId: string;
  tabId: string;
  /** `exact` is required before anything may mutate the page. */
  bindingQuality: "exact" | "approx" | string;
  url: string | null;
  title: string | null;
  tabs: Array<{ tabId: string; url: string | null; title: string | null; active: boolean | null }>;
}

/** One row of a rendered page, as the driver's `semantic_v2` snapshot reports it. */
export interface CuaPageRef {
  ref: string;
  role: string;
  name: string | null;
  value: string | null;
  /** Which interactions this node accepts: `click`, `type`, `upload`, `pointer`. */
  actions: string[];
  visibility?: string;
  frame?: string;
}

export interface CuaPageState {
  url: string | null;
  title: string | null;
  /** The semantic outline: what a model reads instead of the HTML. */
  outline: string;
  /** Interactive refs, valid until the next snapshot or navigation. */
  refs: CuaPageRef[];
  /** Read-only content rows, including text that only rendered markup produces. */
  content: CuaPageRef[];
  snapshotId: string;
  truncated: boolean;
  /** Opaque cursor for the next segment of a long page. */
  continuation?: string;
  /** Only when the caller asked for it: base64 PNG of the tab viewport. */
  screenshot?: CuaScreenshot;
  durationMs: number;
}

/*
 * CAPTCHA surface. Detection is a property of a page, so it is reported as
 * state — "this page is gated by a reCAPTCHA" — and never as a tool failure.
 */

export type CaptchaKind =
  | "recaptcha_v2_checkbox"
  | "recaptcha_v2_invisible"
  | "recaptcha_v3"
  | "recaptcha_enterprise"
  | "hcaptcha"
  | "turnstile"
  | "cloudflare_interstitial"
  | "aws_waf"
  | "arkose"
  | "unknown_challenge";

export interface CaptchaSignal {
  kind: CaptchaKind;
  /** How sure the detector is: a sitekey is strong, an iframe title is not. */
  confidence: "high" | "medium" | "low";
  /** The public site key, when the page exposes it. This is not a secret. */
  siteKey?: string;
  /** The iframe or widget source, for the solver's `pageurl`/`type` arguments. */
  source?: string;
  /** Human-readable evidence: which selector or title matched. */
  evidence: string;
  /**
   * True when the challenge is a soft heuristic that a slower, more human
   * cadence may clear, rather than a hard gate that always needs a token.
   */
  soft?: boolean;
  /**
   * True when this is a hint rather than a gate: a widget library is loaded, or
   * a title looks like a holding page, but nothing on the page is actually
   * blocking. Advisory signals never make `gated` true on their own.
   */
  advisory?: boolean;
}

export interface CaptchaDetection {
  gated: boolean;
  /**
   * Every challenge marker found, most confident first. An **advisory** signal
   * (a loaded widget script with no challenge furniture, or a page title that
   * merely looks like a holding page) appears here with
   * `advisory: true` and does not by itself make the page gated.
   */
  signals: CaptchaSignal[];
  /** The signal the caller should act on, if any. */
  primary?: CaptchaSignal;
  /** Whether a token from a solver can be injected for this kind. */
  solvable: boolean;
}
