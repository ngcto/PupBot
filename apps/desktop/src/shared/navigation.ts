/**
 * Navigation policy: the window is for the product, nothing else.
 *
 * - same-origin http(s) → allowed inside the shell
 * - other http(s), mailto: and tel: → handed to the system browser / mail client
 * - everything else (file:, javascript:, data:, custom schemes) → blocked
 *
 * Pure functions so the policy is testable without launching Electron, and so a
 * reviewer can read the whole rule set in one screen.
 */
const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const HANDOFF_PROTOCOLS = new Set(["mailto:", "tel:"]);
const MAX_URL_LENGTH = 4096;

export type BlockReason =
  | "invalid-url"
  | "unsupported-scheme"
  | "credentials-in-url";

export type NavigationDecision =
  | { readonly action: "allow" }
  | { readonly action: "external"; readonly url: string }
  | { readonly action: "block"; readonly reason: BlockReason };

export type WindowOpenDecision =
  | { readonly action: "allow-child" }
  | { readonly action: "external"; readonly url: string }
  | { readonly action: "block"; readonly reason: BlockReason };

export function parseUrl(raw: string): URL | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function isAppOrigin(raw: string | undefined, allowedOrigins: readonly string[]): boolean {
  const url = raw ? parseUrl(raw) : undefined;
  return url !== undefined && allowedOrigins.includes(url.origin);
}

/**
 * What to do with a navigation the renderer asked for.
 */
export function decideNavigation(raw: string, allowedOrigins: readonly string[]): NavigationDecision {
  const url = parseUrl(raw);
  if (!url) return { action: "block", reason: "invalid-url" };

  if (WEB_PROTOCOLS.has(url.protocol)) {
    if (url.username || url.password) return { action: "block", reason: "credentials-in-url" };
    if (allowedOrigins.includes(url.origin)) return { action: "allow" };
    return { action: "external", url: url.toString() };
  }

  if (HANDOFF_PROTOCOLS.has(url.protocol)) return { action: "external", url: url.toString() };

  return { action: "block", reason: "unsupported-scheme" };
}

/**
 * `window.open` / target=_blank. Same-origin popups stay in the shell (a child
 * window with the same hardened preferences); everything else is denied and, if
 * it is a web or handoff URL, opened by the system.
 */
export function decideWindowOpen(raw: string, allowedOrigins: readonly string[]): WindowOpenDecision {
  const decision = decideNavigation(raw, allowedOrigins);
  if (decision.action === "allow") return { action: "allow-child" };
  return decision;
}
