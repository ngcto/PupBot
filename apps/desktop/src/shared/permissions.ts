/**
 * Permission policy. Deny by default, twice:
 *
 * 1. only the product origin may ask at all (an embedded third-party frame or an
 *    off-origin page never gets a prompt)
 * 2. the permission itself must be named in `TERABOT_PERMISSIONS`
 *
 * The allow-list is deliberately empty unless an operator opts in, so a fresh
 * install can not quietly use the camera, microphone, screen or geolocation.
 */
export type PermissionOutcome =
  | { readonly granted: true; readonly reason: "allowlisted" }
  | {
      readonly granted: false;
      readonly reason: "unknown-origin" | "foreign-origin" | "not-allowlisted";
    };

export type PermissionRequest = {
  readonly permission: string;
  readonly requestingUrl: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly allowedPermissions: readonly string[];
};

/** `undefined` for malformed URLs and for opaque origins such as `file://`. */
export function originOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const origin = new URL(raw).origin;
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function decidePermission(request: PermissionRequest): PermissionOutcome {
  const origin = originOf(request.requestingUrl);
  if (!origin) return { granted: false, reason: "unknown-origin" };
  if (!request.allowedOrigins.includes(origin)) return { granted: false, reason: "foreign-origin" };
  if (!request.allowedPermissions.includes(request.permission)) {
    return { granted: false, reason: "not-allowlisted" };
  }
  return { granted: true, reason: "allowlisted" };
}
