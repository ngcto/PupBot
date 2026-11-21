/**
 * Deep links. The shell registers `terabot://` so a sign-in that happens in the
 * system browser can hand control back to the app.
 *
 * Mapping rule, deliberately narrow: `terabot://<segment>/<rest>?<query>` becomes
 * `<TERABOT_APP_URL>/<segment>/<rest>?<query>` on the product origin. The first
 * segment is a path segment, not a host — the shell never navigates off-origin
 * because of a link, so `terabot://api/auth/callback/github?code=…` resolves to
 * `${APP_URL}/api/auth/callback/github?code=…`, a route the product already
 * serves through better-auth, which then sets the session cookie inside the
 * shell's persistent partition.
 */
import { DEEP_LINK_PROTOCOL } from "./config";

export const MAX_DEEP_LINK_LENGTH = 2048;

export type DeepLinkRejection =
  | "empty"
  | "too-long"
  | "not-our-protocol"
  | "opaque"
  | "unsafe-segment"
  | "foreign-origin";

export type DeepLink = {
  /** Product URL to load in the shell. Always on the app origin. */
  readonly target: URL;
  /** `auth` for sign-in returns, `path` for everything else (open a bot, a chat). */
  readonly kind: "auth" | "path";
};

export type DeepLinkResult =
  | { readonly ok: true; readonly link: DeepLink }
  | { readonly ok: false; readonly reason: DeepLinkRejection };

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function resolveDeepLink(raw: string, appUrl: URL): DeepLinkResult {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_DEEP_LINK_LENGTH) return { ok: false, reason: "too-long" };

  let link: URL;
  try {
    link = new URL(value);
  } catch {
    return { ok: false, reason: "not-our-protocol" };
  }

  if (link.protocol !== `${DEEP_LINK_PROTOCOL}:`) return { ok: false, reason: "not-our-protocol" };
  // `terabot:auth/callback` (no `//`) has no host: the OS hands us that form on
  // some platforms, and it is ambiguous, so we do not guess.
  if (!link.hostname) return { ok: false, reason: "opaque" };
  if (link.username || link.password || link.port) return { ok: false, reason: "unsafe-segment" };

  const segment = link.hostname.toLowerCase();
  if (!SEGMENT.test(segment)) return { ok: false, reason: "unsafe-segment" };

  const basePath = appUrl.pathname.replace(/\/+$/, "");
  const target = new URL(`${appUrl.origin}${basePath}/${segment}${link.pathname}`);
  target.search = link.search;
  target.hash = link.hash;

  if (target.origin !== appUrl.origin) return { ok: false, reason: "foreign-origin" };

  return { ok: true, link: { target, kind: segment === "auth" ? "auth" : "path" } };
}
