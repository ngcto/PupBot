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

/**
 * A challenge host, and what its presence implies.
 *
 * `host` is compared against a **parsed hostname**, never against a URL string.
 * That is both the security property and the correctness one: a query string
 * can carry any host name at all (`?next=https://hcaptcha.com/captcha`), and a
 * label can merely contain one (`hcaptcha.com.attacker.example`). Neither is the
 * host, and neither may report a challenge.
 */
interface Signature {
  kind: CaptchaKind;
  /** The suffix a frame's hostname must land on, matched label by label. */
  host: string;
  /** Path segments that prove a challenge is **rendered and in the way**. */
  gate: (path: string) => boolean;
  /** Path segments that only prove the widget **library** is loaded. */
  loader: (path: string) => boolean;
  confidence: CaptchaSignal["confidence"];
  soft?: boolean;
}

/** Does `path` contain these segments, consecutively, starting at `from`? */
function has(path: string, segments: string[], from = 0): boolean {
  return path.includes(`/${segments.join("/")}`, from);
}

/** Does `path` contain any of these segments at all? */
function hasAny(path: string, segments: string[]): boolean {
  return segments.some((segment) => path.includes(`/${segment}`));
}

/**
 * Hosts and paths, matched against iframe sources and script URLs. A signature
 * first looks for its gate, and falls back to its loader pattern marked
 * advisory — so the *presence of a library* can never by itself become a gate.
 *
 * Ordered most-specific first: reCAPTCHA Enterprise serves from the same host as
 * v3, so the enterprise markers are tested before the plain v3 one.
 */
const SIGNATURES: Signature[] = [
  {
    kind: "recaptcha_enterprise",
    host: "google.com",
    gate: (path) => hasAny(path, ["anchor", "bframe"]) && path.includes("/recaptcha/") && path.includes("enterprise"),
    loader: (path) => path.includes("/recaptcha/") && path.includes("enterprise") && path.includes(".js"),
    confidence: "high",
  },
  {
    kind: "recaptcha_v2_checkbox",
    host: "google.com",
    // The v2 widget's own frames are the anchor/b-frame pair; a bare `api.js` is
    // the generic or v3 loader and must not be read as a checkbox.
    gate: (path) => hasAny(path, ["anchor", "bframe"]) && path.includes("/recaptcha/"),
    loader: (path) => hasAny(path, ["anchor", "bframe"]) && path.includes("/recaptcha/"),
    confidence: "high",
  },
  {
    kind: "recaptcha_v2_invisible",
    host: "google.com",
    gate: (path) => hasAny(path, ["anchor", "bframe"]) && path.includes("/recaptcha/"),
    loader: (path) => hasAny(path, ["anchor", "bframe"]) && path.includes("/recaptcha/"),
    confidence: "medium",
  },
  {
    kind: "recaptcha_v3",
    host: "google.com",
    // v3 renders no widget: it is a score returned by `execute`. The only honest
    // signal is the loader together with the page's own response field.
    gate: () => false,
    loader: (path) => path.includes("/recaptcha/") && path.endsWith("api.js"),
    confidence: "medium",
  },
  {
    kind: "hcaptcha",
    host: "hcaptcha.com",
    gate: (path) => has(path, ["captcha"]),
    loader: (path) => path.includes("/1/api.js") || has(path, ["checksiteconfig"]),
    confidence: "high",
  },
  {
    kind: "turnstile",
    host: "cloudflare.com",
    // The frames the widget opens: `/turnstile/v0/bframe`, and the `a/` variant.
    // A bare `api.js` is the loader and must not read as one.
    gate: (path) => path.includes("/turnstile/") && !path.endsWith(".js"),
    loader: (path) => path.includes("/turnstile/") && path.endsWith("api.js"),
    confidence: "high",
  },
  {
    kind: "arkose",
    host: "arkoselabs.com",
    gate: (path) => path.includes("/fc/") && hasAny(path, ["api", "gc"]),
    loader: () => true,
    confidence: "high",
  },
  {
    kind: "aws_waf",
    host: "awswaf.com",
    gate: (path) => has(path, ["captcha"]),
    loader: () => true,
    confidence: "high",
  },
];




/**
 * Widgets whose presence in **markup** is a rendered challenge, by kind.
 *
 * These are attributes a page writes when it embeds a widget, so they are not a
 * host match at all: `<div class="g-recaptcha">` and `<div class="cf-turnstile">`
 * each mean the widget is on the page, whatever iframes exist yet.
 */
const MARKUP_GATES: Partial<Record<CaptchaKind, RegExp>> = {
  turnstile: /class=["'][^"']*cf-turnstile/i,
  recaptcha_v2_checkbox: /class=["'][^"']*g-recaptcha/i,
  hcaptcha: /id=["']h-captcha-response["']/i,
};

/**
 * Markers that a challenge is actually *in the way*: a response field or the
 * widget's own embedding attribute. Frame presence is decided by the parsed host
 * and path below, so no host name is ever matched as text.
 */
const BLOCKING_MARKERS = [
  /id=["']g-recaptcha-response["']/i,
  /id=["']h-captcha-response["']/i,
  /name=["']cf-turnstile-response["']/i,
  /class=["'][^"']*(?:g-recaptcha|cf-turnstile)/i,
];

/**
 * Does `host` belong to `domain` — itself, or a subdomain of it?
 *
 * Label by label, which is the only comparison that means "this host". A string
 * `endsWith` would accept `notexample.com` for `example.com`, and `includes`
 * would accept `example.com.attacker.example`; neither is that host.
 */
function isUnder(host: string, domain: string): boolean {
  if (!host) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

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
  const signals: CaptchaSignal[] = [];
  /** Markup and visible text. Hosts never reach this. */
  const content = [page.html ?? "", page.text ?? "", page.title ?? ""].join("\n");
  /** Something on this page proves a challenge is rendered, not just loaded. */
  const blocking = BLOCKING_MARKERS.some((marker) => marker.test(content));

  /**
   * Every frame, parsed once into a host name and a path.
   *
   * Nothing downstream sees the raw URL, so a query string or a path segment can
   * never stand in for a host. `host` answers "" for a source that does not
   * parse, which simply matches no signature.
   */
  const frames = urls.map((source) => {
    try {
      const parsed = new URL(source);
      return { source, host: parsed.hostname.toLowerCase(), path: parsed.pathname.toLowerCase() };
    } catch {
      return { source, host: "", path: "" };
    }
  });

  for (const signature of SIGNATURES) {
    // A host is the signature's own, or a subdomain of it — decided label by
    // label, so `hcaptcha.com.attacker.example` is not a subdomain of
    // `hcaptcha.com` and `evil.example/hcaptcha.com` is not either.
    const frame = frames.find(
      (entry) => isUnder(entry.host, signature.host) && (signature.gate(entry.path) || signature.loader(entry.path)),
    );
    // A rendered widget also announces itself in markup, where its own host may
    // appear in no frame at all.
    const markupGate = MARKUP_GATES[signature.kind]?.test(content) ?? false;
    if (!frame && !markupGate) continue;

    const isGate = frame ? signature.gate(frame.path) : false;
    const loaderOnly = frame !== undefined && !isGate;
    // A loader with no challenge furniture anywhere on the page is advisory. A
    // loader with furniture is a real gate (the widget is rendered, the loader
    // just happened to be what matched first).
    const advisory = !markupGate && loaderOnly && !blocking;
    const source = frame?.source ?? signature.host;
    const siteKey = siteKeyFromUrl(source);
    signals.push({
      kind: signature.kind,
      confidence: advisory ? "low" : signature.confidence,
      ...(siteKey ? { siteKey } : {}),
      source,
      evidence: advisory
        ? `only the ${signature.kind} library is loaded; nothing on the page shows a challenge`
        : `found a ${signature.kind} challenge on ${frame?.host ?? "this page"}`,
      ...(advisory ? { advisory: true } : {}),
    });
  }

  const cloudflareMarker = CLOUDFLARE_MARKERS.find((marker) => marker.test(content));
  if (cloudflareMarker) {
    const marker = cloudflareMarker;
    signals.push({
      kind: "cloudflare_interstitial",
      confidence: "high",
      evidence: `matched ${marker?.source ?? "a Cloudflare challenge marker"}`,
      soft: true,
    });
  }

  // The site key from a data attribute is the one the widget actually uses, so
  // it wins over anything scraped out of a frame URL.
  const attributeKey = /data-sitekey=["']([A-Za-z0-9_-]{10,})["']/i.exec(page.html ?? "")?.[1];
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
    // A whole path *segment* that says "challenge" or "captcha", not a
    // substring: `hcaptcha.com.attacker.example/assets/widget.js` is someone
    // else's site whose name merely contains the word, while
    // `verify.example.com/challenge/main` is a challenge frame.
    const frameChallenge = frames.find((entry) =>
      entry.path.split("/").some((segment) => /^(?:captcha|challenge)/i.test(segment)),
    );
    if (frameChallenge) {
      signals.push({
        kind: "unknown_challenge",
        confidence: "medium",
        evidence: `a frame on ${frameChallenge.host || "an unnamed host"} looks like a challenge`,
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

  // A rendered challenge outranks a loaded library, whatever their nominal
  // confidence: an advisory hit must never become the primary when a real one
  // is present.
  const order = { high: 0, medium: 1, low: 2 } as const;
  signals.sort((a, b) => {
    if (a.advisory !== b.advisory) return a.advisory ? 1 : -1;
    return order[a.confidence] - order[b.confidence];
  });

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
