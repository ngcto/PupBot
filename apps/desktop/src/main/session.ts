import { session, type Session } from "electron";
import type { DesktopConfig } from "../shared/config";
import { decidePermission } from "../shared/permissions";
import { log } from "./log";

/**
 * Every window shares one persistent partition, so the product's cookie session
 * is the same across windows and across restarts (Electron writes it to
 * `<userData>/Partitions/terabot`). There is deliberately no in-memory session
 * and no way to load the product outside this partition.
 */
export const SESSION_PARTITION = "persist:terabot";

export function productSession(): Session {
  return session.fromPartition(SESSION_PARTITION);
}

/**
 * Permissions are denied unless the requesting origin is the product origin and
 * the permission is explicitly allow-listed in `TERABOT_PERMISSIONS`.
 */
export function installPermissionPolicy(target: Session, config: DesktopConfig): void {
  const evaluate = (permission: string, requestingUrl: string | undefined) =>
    decidePermission({
      permission,
      requestingUrl,
      allowedOrigins: config.allowedOrigins,
      allowedPermissions: config.allowedPermissions,
    });

  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const outcome = evaluate(permission, details.requestingUrl ?? contents?.getURL());
    if (!outcome.granted && outcome.reason !== "not-allowlisted") {
      log("permission", `denied ${permission} (${outcome.reason})`);
    }
    callback(outcome.granted);
  });

  target.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return evaluate(permission, requestingOrigin).granted;
  });

  // Screen sharing stays off in v1: a denied request is better than a picker
  // nobody asked for.
  target.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
}
