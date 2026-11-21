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
  /**
   * A URL that proves a challenge is **rendered and in the way**: an iframe the
   * widget opened, or the page's own response field.
   */
  gate: RegExp;
  /**
   * A URL that only proves the widget **library** is loaded. A page can carry
   * `hcaptcha.com/1/api.js`, `turnstile/v0/api.js` or `recaptcha/api.js` purely
   * to call the widget from a button, and telling a model "this page is gated"
   * then stops a working page from being used.
   */
  loader: RegExp;
  confidence: CaptchaSignal["confidence"];
  soft?: boolean;
}

/**
 * Hosts and paths, matched against iframe sources and script URLs. A signature
 * first looks for its gate, and falls back to its loader pattern marked
 * advisory — so the *presence of a library* can never by itself become a gate.
 *
 * Ordered most-specific first: reCAPTCHA Enterprise serves from the same host as
 * v3, so the enterprise markers are tested before the plain v3 one.
 */
/**
 * A host pattern anchored to the URL's authority.
 *
 * CodeQL flagged this file hard and it is right: `hcaptcha.com/captcha` tested
 * against a whole page haystack also matches
 * `https://evil.example/?next=hcaptcha.com/captcha`, and `hcaptcha.com` matches
 * `https://hcaptcha.com.attacker.example/`. Either one reports a clean page as a
 * challenge, which is the worst failure this module has.
 *
 * Matching `//` + optional subdomains + the exact host keeps the name on the
 * authority. Patterns that are already anchored to a rendered attribute
 * (`class="cf-turnstile"`) do not go through this.
 */
function url(host: string, rest: string): RegExp {
  return new RegExp(`^(?:[a-z0-9-]+\\.)*${host}[/?#]${rest}`, "i");
}

const SIGNATURES: Signature[] = [
  {
    kind: "recaptcha_enterprise",
    gate: url("google\\.com", String.raw`recaptcha\/(?:enterprise|api2\/enterprise)\/(?:anchor|bframe)`),
    loader: url("google\\.com", String.raw`recaptcha\/(?:enterprise|api2\/enterprise)\.js`),
    confidence: "high",
  },
  {
    kind: "recaptcha_v2_checkbox",
    gate: url("google\\.com", String.raw`recaptcha\/(?:api2\/)?anchor`),
    // The v2 widget's own loader is the anchor/b-frame pair; a bare `api.js` is
    // the generic or v3 loader and must not be read as a checkbox.
    loader: url("google\\.com", String.raw`recaptcha\/(?:api2\/)?anchor`),
    confidence: "high",
  },
  {
    kind: "recaptcha_v2_invisible",
    gate: /size=invisible.*bframe|bframe.*size=invisible/i,
    loader: /size=invisible/i,
    confidence: "medium",
  },
  {
    kind: "recaptcha_v3",
    // v3 renders no widget: it is a score returned by `execute`. The only
    // honest signal is the call together with the page's response field.
    gate: /grecaptcha\.(?:execute|ready)\(/i,
    loader: url("google\\.com", String.raw`recaptcha\/api\.js`),
    confidence: "medium",
  },
  {
    kind: "hcaptcha",
    gate: url("hcaptcha\\.com", String.raw`captcha`),
    loader: url("hcaptcha\\.com", String.raw`(?:1\/api\.js|checksiteconfig)`),
    confidence: "high",
  },
  {
    kind: "turnstile",
    gate: new RegExp(
      `${url("cloudflare\\.com", String.raw`turnstile\/v\d+\/(?:bframe|a\/)`).source}` +
        String.raw`|class=["'][^"']*cf-turnstile`,
      "i",
    ),
    loader: new RegExp(
      `${url("cloudflare\\.com", String.raw`turnstile\/v\d+\/api\.js`).source}` +
        String.raw`|cf-turnstile`,
      "i",
    ),
    confidence: "high",
  },
  {
    kind: "arkose",
    gate: new RegExp(
      `${url("arkoselabs\\.com", String.raw`fc\/(?:api|gc)\/`).source}` +
        String.raw`|//(?:[a-z0-9-]+\.)*funcaptcha\.(?:com|net)/`,
      "i",
    ),
    loader: new RegExp(
      `${url("arkoselabs\\.com", String.raw``).source}` +
        String.raw`|//(?:[a-z0-9-]+\.)*funcaptcha\.(?:com|net)/`,
      "i",
    ),
    confidence: "high",
  },
  {
    kind: "aws_waf",
    gate: url("awswaf\\.com", String.raw`captcha`),
    loader: /awswaf/i,
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
  /\/recaptcha\/(?:enterprise|api2\/enterprise)\/(?:anchor|bframe)/i,
  /challenges\.cloudflare\.com\/turnstile\/v\d+\/(?:bframe|a\/)/i,
  /newassets\.hcaptcha\.com\/captcha|hcaptcha\.com\/captcha/i,
  /id=["']g-recaptcha-response["']/i,
  /class=["'][^"']*g-recaptcha/i,
  /id=["']h-captcha-response["']/i,
  /name=["']cf-turnstile-response["']/i,
];

/** The path segments of a URL; empty when it does not parse. */
function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `host/path` for a URL, with the query and fragment dropped.
 *
 * The path is what names the widget (`/recaptcha/api2/anchor`); the query is
 * where any string at all can be planted, so it never takes part in matching.
 * The site key is read from the whole URL separately.
 */
function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/**
 * The URL a match sits in, when it landed in the address section.
 *
 * A match on markup (`class="cf-turnstile"`) belongs to no URL, and answers
 * `undefined`; a match on an address answers that frame's original URL, so the
 * caller still sees the query string the site key lives in.
 */
function enclosingUrl(table: Array<{ start: number; url: string }>, index: number): string | undefined {
  let found: string | undefined;
  for (const entry of table) {
    if (entry.start > index) break;
    found = entry.url;
  }
  return found;
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
  // Frame URLs are reduced to their authority before anything matches on them.
  // A path or a query string can carry any text, including another site's host
  // name, so a pattern that reads the raw URL is a pattern an attacker picks the
  // answer to. Hosts come from the parser; everything else is markup and text.
  // One line per URL, and a table back to the original so a match can still
  // hand back the whole URL (the public site key lives in its query string).
  const addresses = urls.map(hostAndPath);
  const urlAt: Array<{ start: number; url: string }> = [];
  let offset = 0;
  for (const [index, address] of addresses.entries()) {
    urlAt.push({ start: offset, url: urls[index]! });
    offset += address.length + 1;
  }
  const haystack = [addresses.join("\n"), page.html ?? "", page.text ?? "", page.title ?? ""].join("\n");
  const signals: CaptchaSignal[] = [];
  /** Something on this page proves a challenge is rendered, not just loaded. */
  const blocking = BLOCKING_MARKERS.some((marker) => marker.test(haystack));

  for (const signature of SIGNATURES) {
    // A gate first: that is a rendered challenge or a response field.
    const gateMatch = signature.gate.exec(haystack);
    const loaderMatch = gateMatch ? null : signature.loader.exec(haystack);
    if (!gateMatch && !loaderMatch) continue;

    const match = gateMatch ?? loaderMatch!;
    // Keep the *whole* URL the match sits in: a regex match can end before the
    // query string, which is where the public site key lives.
    const source = enclosingUrl(urlAt, match.index) ?? match[0];
    const loaderOnly = gateMatch === null;
    // A loader with no challenge furniture anywhere on the page is advisory. A
    // loader with furniture is a real gate (the widget is rendered, the loader
    // just happened to be what matched first).
    const advisory = loaderOnly && !blocking;
    signals.push({
      kind: signature.kind,
      confidence: advisory ? "low" : signature.confidence,
      ...(siteKeyFromUrl(source) ? { siteKey: siteKeyFromUrl(source) } : {}),
      source,
      evidence: advisory
        ? `only the ${signature.kind} library is loaded; nothing on the page shows a challenge`
        : `matched ${match[0]}`,
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
    // A whole path *segment* that says "challenge" or "captcha", not a
    // substring: `hcaptcha.com.attacker.example/assets/widget.js` is someone
    // else's site whose name merely contains the word, while
    // `verify.example.com/challenge/main` is a challenge frame.
    const frameChallenge = urls.find((candidate) =>
      pathSegments(candidate).some((segment) => /^(?:captcha|challenge)/i.test(segment)),
    );
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
