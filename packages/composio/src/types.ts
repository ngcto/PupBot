/**
 * The shapes our product thinks in. Nothing here mirrors a Composio response
 * field for field: the wire lives in `wire.ts`, and `map.ts` is the only place
 * that knows both.
 */

/** How an app can be connected, decided from the toolkit's advertised schemes. */
export type AppSupport =
  /** Composio holds the OAuth app; the user only approves access. */
  | "managed"
  /** The user pastes their own API key, bearer token or basic credentials on Composio's hosted page. */
  | "user-key"
  /** This beta cannot connect it: it needs an OAuth client registered for the toolkit, or provider review. */
  | "needs-setup";

export interface ToolkitSummary {
  slug: string;
  name: string;
  description: string;
  logoUrl: string;
  appUrl: string | null;
  categories: string[];
  /** Schemes the toolkit accepts, upper case as Composio writes them (OAUTH2, API_KEY, ...). */
  authSchemes: string[];
  /** Schemes Composio will run with its own app credentials. */
  managedAuthSchemes: string[];
  toolsCount: number;
  support: AppSupport;
}

export interface ToolkitPage {
  items: ToolkitSummary[];
  nextCursor: string | null;
}

export interface AuthConfig {
  id: string;
  toolkit: string;
  scheme: string;
  managed: boolean;
  /** True when this config was created for the user's own key rather than Composio's app. */
  userSupplied: boolean;
}

export type ConnectionState = "pending" | "active" | "failed" | "expired" | "revoked" | "inactive" | "unknown";

export interface Connection {
  id: string;
  toolkit: string;
  authConfigId: string;
  alias: string | null;
  /** What Composio reports right now, unanswered (`INITIALIZING`, `ACTIVE`, ...). */
  rawStatus: string;
  state: ConnectionState;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConnectionLink {
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string;
}

/**
 * Schemas a hosted connect page can collect from the user itself. Exported so the
 * client picks a custom-auth scheme out of exactly the set `supportFor` tests: a
 * toolkit that is `user-key` for its API key must not be asked for OAuth client
 * credentials it does not have.
 */
export const USER_SUPPLIED_SCHEMES = ["API_KEY", "BEARER_TOKEN", "BASIC"];

/**
 * Which connect flow a toolkit gets. Composio-managed OAuth is the beta path:
 * their app registration stands in for ours. A toolkit with no managed app but
 * a key-based scheme still connects — the hosted page collects the user's own
 * key, so we never hold it.
 */
export function supportFor(toolkit: Pick<ToolkitSummary, "authSchemes" | "managedAuthSchemes">): AppSupport {
  if (toolkit.managedAuthSchemes.some((scheme) => scheme === "OAUTH2" || scheme === "OAUTH1")) return "managed";
  if (toolkit.authSchemes.some((scheme) => USER_SUPPLIED_SCHEMES.includes(scheme))) return "user-key";
  return "needs-setup";
}

/**
 * Composio reports the lifecycle in upper case and keeps a second copy inside
 * `state.val.status`; anything new maps to `unknown` rather than being treated
 * as active, so a status we do not understand never reads as connected.
 */
export function connectionStateFrom(rawStatus: string): ConnectionState {
  switch (rawStatus.toUpperCase()) {
    case "INITIALIZING":
    case "INITIATED":
      return "pending";
    case "ACTIVE":
      return "active";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "REVOKED":
      return "revoked";
    case "INACTIVE":
      return "inactive";
    default:
      return "unknown";
  }
}
