/**
 * All desktop configuration is resolved from the environment once, at startup,
 * and validated there. The rules live in `src/shared/` so they can be unit
 * tested without an Electron runtime.
 */
export const APP_NAME = "Terabot";
export const DEFAULT_APP_URL = "http://localhost:3000";
export const DEEP_LINK_PROTOCOL = "terabot";

export const ENV = {
  appUrl: "TERABOT_APP_URL",
  allowedOrigins: "TERABOT_ALLOWED_ORIGINS",
  permissions: "TERABOT_PERMISSIONS",
  autoUpdate: "TERABOT_AUTO_UPDATE",
  updateFeedUrl: "TERABOT_UPDATE_FEED_URL",
  registerProtocol: "TERABOT_REGISTER_PROTOCOL",
} as const;

export type DesktopConfig = {
  /** Absolute http(s) URL of the hosted product this binary wraps. */
  readonly appUrl: URL;
  /** Origins the window may navigate to. The app origin always leads. */
  readonly allowedOrigins: readonly string[];
  /** Renderer permissions granted to the app origin. Empty means deny everything. */
  readonly allowedPermissions: readonly string[];
  /** Whether the shell checks the update feed on its own. Off unless asked for. */
  readonly autoUpdate: boolean;
  /** Generic-provider update feed, e.g. `https://updates.terabot.ai/desktop`. */
  readonly updateFeedUrl: string | undefined;
  /** Whether `terabot://` is registered with the OS. Always on when packaged. */
  readonly registerProtocol: boolean;
};

export type DesktopEnv = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readBoolean(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}

function readList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Absolute http(s) URL with no credentials and no fragment. */
export function parseHttpUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, got "${raw}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL, got "${raw}".`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not carry credentials in the URL.`);
  }
  url.hash = "";
  return url;
}

/**
 * The product URL: `TERABOT_APP_URL`, defaulting to the local dev server so the
 * same binary works against localhost, staging and production.
 */
export function parseAppUrl(raw: string | undefined): URL {
  const value = raw?.trim() || DEFAULT_APP_URL;
  return parseHttpUrl(value, ENV.appUrl);
}

/**
 * Navigation is limited to the product origin. `TERABOT_ALLOWED_ORIGINS` exists
 * only for a product that genuinely serves itself from a second origin (a split
 * front end); every other origin is treated as external and opens in the system
 * browser.
 */
export function parseAllowedOrigins(raw: string | undefined, appUrl: URL): string[] {
  const origins = [appUrl.origin];
  for (const entry of readList(raw)) {
    const origin = parseHttpUrl(entry, ENV.allowedOrigins).origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Electron permission names (`notifications`, `media`, `clipboard-sanitized-write`,
 * …). Deny-by-default: an empty list means every request is refused.
 */
export function parsePermissions(raw: string | undefined): string[] {
  const permissions: string[] = [];
  for (const entry of readList(raw)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(entry)) {
      throw new Error(`${ENV.permissions} entries must look like Electron permission names, got "${entry}".`);
    }
    if (!permissions.includes(entry)) permissions.push(entry);
  }
  return permissions;
}

export function resolveDesktopConfig(env: DesktopEnv = process.env): DesktopConfig {
  const appUrl = parseAppUrl(env[ENV.appUrl]);
  const feed = env[ENV.updateFeedUrl]?.trim();

  return {
    appUrl,
    allowedOrigins: parseAllowedOrigins(env[ENV.allowedOrigins], appUrl),
    allowedPermissions: parsePermissions(env[ENV.permissions]),
    autoUpdate: readBoolean(env[ENV.autoUpdate]),
    updateFeedUrl: feed ? parseHttpUrl(feed, ENV.updateFeedUrl).toString() : undefined,
    registerProtocol: readBoolean(env[ENV.registerProtocol]),
  };
}
