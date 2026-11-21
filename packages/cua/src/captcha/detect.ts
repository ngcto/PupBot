import type { CaptchaDetection, CaptchaKind, CaptchaSignal } from "../types.ts";

/**
 * Is this page gated by a challenge, and by which one?
 *
 * This is a **pure function over what the page already exposes** — the frame
 * URLs, the widget sources, the DOM attributes and the visible text — so it
 * costs no round trip of its own and cannot itself trip a bot heuristic. The
 * page tools hand it what they read; nothing here talks to a driver.
 *
 * The design rule the product needs: a challenge is **state, not failure**. A
 * model that is told "this page is gated by reCAPTCHA v2" can choose a path. A
 * model that is told "click failed" flails.
 *
 * Scope, stated once and plainly: this exists so a bot can operate services its
 * **owner already has an account on** without being stopped at the door. It is
 * not for mass account creation, and it is not for defeating a site's controls
 * where you have no account.
 */

/** A challenge host, and what its presence implies. */
interface Signature {
  kind: CaptchaKind;
  pattern: RegExp;
  confidence: CaptchaSignal["confidence"];
  /** The key this kind of widget publishes in its URL or a data attribute. */
  siteKeyFrom?: "url" | "attribute" | "callback";
  soft?: boolean;
  /**
   * True for a signature that only proves the *library* is loaded, not that a
   * challenge is in the way. A page can carry reCAPTCHA's `api.js` purely to
   * call `grecaptcha.execute` on a login button that is not currently showing a
   * gate, and telling a model "this page is gated" then is worse than saying
   * nothing: it stops a working page from being used.
   */
  loaderOnly?: boolean;
}

/**
 * Hosts and paths, matched against iframe sources and script URLs. Ordered
 * most-specific first: reCAPTCHA Enterprise serves from the same host as v3, so
 * the enterprise markers are tested before the plain v3 one.
 */
const SIGNATURES: Signature[] = [
  {
    kind: "recaptcha_enterprise",
    pattern: /recaptcha\/(?:enterprise|api2\/enterprise)\.js/i,
    confidence: "high",
    siteKeyFrom: "url",
  },
  {
    kind: "recaptcha_v2_checkbox",
    pattern: /google\.com\/recaptcha\/(?:api2\/)?anchor|recaptcha\/api2\/anchor/i,
    confidence: "high",
    siteKeyFrom: "url",
  },
  {
    kind: "recaptcha_v2_invisible",
    pattern: /google\.com\/recaptcha\/api2\/bframe|size=invisible/i,
    confidence: "medium",
    siteKeyFrom: "url",
  },
  {
    kind: "recaptcha_v3",
    pattern: /google\.com\/recaptcha\/api\.js|recaptcha\/api\.js|grecaptcha\.execute/i,
    confidence: "medium",
    siteKeyFrom: "url",
    // A loaded script is the whole of this signature. It becomes a gate only
    // when the page also shows challenge furniture — see `blockingEvidence`.
    loaderOnly: true,
  },
  {
    kind: "hcaptcha",
    pattern: /hcaptcha\.com\/(?:1\/api\.js|checksiteconfig)|newassets\.hcaptcha\.com/i,
    confidence: "high",
    siteKeyFrom: "attribute",
  },
  {
    kind: "turnstile",
    pattern: /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js|cf-turnstile/i,
    confidence: "high",
    siteKeyFrom: "attribute",
  },
  {
    kind: "arkose",
    pattern: /arkoselabs\.com|funcaptcha/i,
    confidence: "high",
    siteKeyFrom: "attribute",
  },
  {
    kind: "aws_waf",
    pattern: /captcha\.awswaf\.com|awswaf/i,
    confidence: "high",
  },
];

/**
 * Markers that a challenge is actually *in the way*: a rendered frame, a
 * response field, or the holding page itself. Absent all of these, a loaded
 * widget script is an advisory signal and not a gate.
 */
const BLOCKING_MARKERS = [
  /\/recaptcha\/api2\/(?:anchor|bframe)/i,
  /\/recaptcha\/enterprise/i,
  /challenges\.cloudflare\.com\/turnstile\/v\d+\/bframe/i,
  /newassets\.hcaptcha\.com\/c\/enterprise|hcaptcha\.com\/captcha/i,
  /id=["']g-recaptcha-response["']/i,
  /class=["'][^"']*g-recaptcha/i,
  /id=["']h-captcha-response["']/i,
  /name=["']cf-turnstile-response["']/i,
];

/**
 * Markers of a Cloudflare interstitial specifically: the JS challenge and the
 * "checking your browser" holding page. These are the ones a slower, more human
 * cadence sometimes clears on its own, so they are marked soft.
 */
const CLOUDFLARE_MARKERS = [
  /cf-browser-verification/i,
  /__cf_chl_/,
  /cdn-cgi\/challenge-platform/i,
  /Just a moment\.\.\./i,
  /Checking your browser before accessing/i,
  /Verify you are human/i,
];

/** Titles that mean "you are on a holding page", for the generic fallback. */
const INTERSTITIAL_TITLES = [
  /just a moment/i,
  /attention required/i,
  /access denied/i,
  /security check/i,
  /are you a (?:robot|human)/i,
  /please wait/i,
  /verify(?:ing)? you/i,
];

/** A public site key. Never a secret: it ships in the page's own HTML. */
export function siteKeyFromUrl(url: string): string | undefined {
  // `.../anchor?ar=1&k=6Lc...&co=...` and `k=`, `sitekey=`, `site_key=`.
  const match = /[?&](?:k|sitekey|site_key)=([A-Za-z0-9_-]{10,})/.exec(url);
  return match?.[1];
}

export interface PageSignals {
  /** Every frame URL the page has, as the page tools report them. */
  frameUrls?: string[];
  /** Visible text, for the soft-heuristic and interstitial checks. */
  text?: string;
  title?: string | null;
  /** Raw HTML, when the caller has it; the data attributes live here. */
  html?: string;
}

/**
 * Detect. Returns every signal it found, ordered by confidence, plus the one the
 * caller should act on.
 *
 * A page can carry more than one marker (reCAPTCHA's own script is present on
 * pages that merely *might* challenge), so `signals` is a list and `gated` is
 * true only when at least one of them is a real challenge — a bare `api.js`
 * script on its own is a *medium* signal, and the caller decides whether to
 * slow down or treat the page as clean.
 */
export function detectCaptcha(page: PageSignals): CaptchaDetection {
  const urls = page.frameUrls ?? [];
  const haystack = [urls.join(" "), page.html ?? "", page.text ?? "", page.title ?? ""].join("\n");
  const signals: CaptchaSignal[] = [];
  /** Something on this page proves a challenge is rendered, not just loaded. */
  const blocking = urls.some((url) => BLOCKING_MARKERS.some((marker) => marker.test(url)))
    || BLOCKING_MARKERS.some((marker) => marker.test(haystack));

  for (const signature of SIGNATURES) {
    const match = signature.pattern.exec(haystack);
    if (!match) continue;
    const source = urls.find((url) => signature.pattern.test(url)) ?? match[0];
    // A loader-only signature is not a gate by itself: a page that merely calls
    // `grecaptcha.execute` from a login button has a widget library loaded and
    // nothing in the way.
    const advisory = signature.loaderOnly === true && !blocking;
    signals.push({
      kind: signature.kind,
      confidence: advisory ? "low" : signature.confidence,
      ...(siteKeyFromUrl(source) ? { siteKey: siteKeyFromUrl(source) } : {}),
      source,
      evidence: `matched ${signature.pattern.source} in a frame or script URL`,
      ...(advisory ? { advisory: true } : {}),
    });
  }

  if (CLOUDFLARE_MARKERS.some((marker) => marker.test(haystack))) {
    const marker = CLOUDFLARE_MARKERS.find((entry) => entry.test(haystack));
    signals.push({
      kind: "cloudflare_interstitial",
      confidence: "high",
      evidence: `matched ${marker?.source ?? "a Cloudflare challenge marker"}`,
      soft: true,
    });
  }

  // The site key from a data attribute is the one the widget actually uses, so
  // it wins over anything scraped out of a frame URL.
  const attributeKey =
    /data-sitekey=["']([A-Za-z0-9_-]{10,})["']/i.exec(page.html ?? "")?.[1] ??
    /data-sitekey=["']([A-Za-z0-9_-]{10,})["']/i.exec(haystack)?.[1];
  if (attributeKey) {
    for (const signal of signals) {
      if (signal.kind === "hcaptcha" || signal.kind === "turnstile" || signal.kind === "recaptcha_v2_checkbox") {
        signal.siteKey = attributeKey;
      }
    }
  }

  if (signals.length === 0) {
    // Generic fallback: a page that says it is a challenge without naming one.
    // The title alone is only a hint — a clean page can be titled "Please wait"
    // while it loads — so it is advisory unless a challenge frame backs it up.
    const title = page.title ?? "";
    const titleMatch = INTERSTITIAL_TITLES.find((pattern) => pattern.test(title));
    const frameChallenge = urls.find((url) => /captcha|challenge/i.test(url));
    if (frameChallenge) {
      signals.push({
        kind: "unknown_challenge",
        confidence: "medium",
        evidence: `a frame URL looks like a challenge: ${frameChallenge}`,
      });
    } else if (titleMatch) {
      signals.push({
        kind: "unknown_challenge",
        confidence: "low",
        evidence: `page title matched ${titleMatch.source}, with nothing on the page to confirm it`,
        advisory: true,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  signals.sort((a, b) => order[a.confidence] - order[b.confidence]);

  // A page is gated only by a signal that is not merely advisory.
  const gating = signals.filter((signal) => signal.advisory !== true);
  const primary = gating[0];

  return {
    gated: gating.length > 0,
    signals,
    ...(primary ? { primary } : {}),
    // A token is only useful for a widget that takes one. An interstitial has no
    // sitekey to solve, so it is not solvable by injection.
    solvable:
      primary !== undefined &&
      primary.siteKey !== undefined &&
      primary.kind !== "cloudflare_interstitial" &&
      primary.kind !== "aws_waf" &&
      primary.kind !== "unknown_challenge",
  };
}

/** A one-line statement a model can act on without reading the signals array. */
export function describeDetection(detection: CaptchaDetection): string {
  if (!detection.gated) {
    const advisory = detection.signals.find((signal) => signal.advisory);
    if (advisory) {
      return `This page is not gated by a challenge; it loads a ${advisory.kind} widget but nothing is blocking. Continue normally.`;
    }
    return "This page is not gated by a challenge.";
  }
  const primary = detection.primary;
  if (!primary) return "This page is gated by a challenge.";
  const where = primary.siteKey ? ` (site key ${primary.siteKey})` : "";
  const soft = primary.soft ? " It is a soft heuristic, so a slower retry sometimes clears it." : "";
  const solve = detection.solvable
    ? " A configured solver can return a token to inject."
    : " No token can be injected for this kind; use another path.";
  return `This page is gated by ${primary.kind}${where}.${soft}${solve}`;
}
