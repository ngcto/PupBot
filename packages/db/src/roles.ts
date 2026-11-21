import { serverEnv } from "@terabot/config";
import { eq, inArray, notInArray } from "drizzle-orm";
import { database } from "./client.ts";
import { user } from "./schema.ts";

/**
 * Who is the Owner.
 *
 * A self-hosted deployment needs exactly one account that can configure
 * everything and never pays. Email is the identifier the operator already has,
 * so `OWNER_EMAILS` (comma separated) is the source of truth: the server
 * promotes the accounts that match and demotes any Owner that no longer does.
 * Nothing in a request can grant the role — a signup always lands as `member`.
 */
export function ownerEmails(): string[] {
  const raw = serverEnv().OWNER_EMAILS;
  if (!raw) return [];
  return [...new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )];
}

export interface OwnerSyncResult {
  granted: number;
  revoked: number;
  /** True when `OWNER_EMAILS` is empty: nobody is promoted and nobody is demoted. */
  disabled: boolean;
}

/**
 * Reconciles the `owner` role against `OWNER_EMAILS`.
 *
 * Idempotent, so it is safe to run on boot and on each request path that reads
 * a role. An empty `OWNER_EMAILS` does nothing at all, including not revoking:
 * a deployment that never configured an Owner keeps whatever it had, instead of
 * silently stripping access from its only administrator.
 */
export async function syncOwnerRoles(): Promise<OwnerSyncResult> {
  const emails = ownerEmails();
  if (emails.length === 0) return { granted: 0, revoked: 0, disabled: true };

  const db = database();
  const granted = await db
    .update(user)
    .set({ role: "owner", updatedAt: new Date() })
    .where(inArray(user.email, emails))
    .returning({ id: user.id });

  const revoked = await db
    .update(user)
    .set({ role: "member", updatedAt: new Date() })
    .where(notInArray(user.email, emails))
    .returning({ id: user.id });

  return { granted: granted.length, revoked: revoked.length, disabled: false };
}

/**
 * The role of one account.
 *
 * Read-through, not read-only: an account whose email `OWNER_EMAILS` names is
 * corrected here and persisted. Boot-time reconciliation cannot cover a signup
 * that happens afterwards — on a fresh deployment the operator creates their
 * account after the migration and the worker have already run — so the moment
 * the role is asked for is the moment it is made true. With `OWNER_EMAILS`
 * unset this is a plain read.
 */
export async function roleOf(userId: string): Promise<"owner" | "member" | null> {
  const db = database();
  const rows = await db
    .select({ role: user.role, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const found = rows[0];
  if (!found) return null;

  const listed = ownerEmails();
  if (listed.length === 0) return found.role;

  const shouldBeOwner = listed.includes(found.email.toLowerCase());
  const wants: "owner" | "member" = shouldBeOwner ? "owner" : "member";
  if (found.role === wants) return found.role;

  await db.update(user).set({ role: wants, updatedAt: new Date() }).where(eq(user.id, userId));
  return wants;
}

let bootSync: Promise<OwnerSyncResult> | undefined;

/**
 * Runs the reconciliation once per process and remembers the result. Boot callers
 * use this so a request never waits on it twice.
 */
export function syncOwnerRolesOnce(): Promise<OwnerSyncResult> {
  bootSync ??= syncOwnerRoles().catch((error: unknown) => {
    bootSync = undefined;
    throw error;
  });
  return bootSync;
}
