import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@terabot/db";
import { computerAccount, database, encryptSecret, newId } from "@terabot/db";

/**
 * Accounts the deployment provides, so a new user gets a working computer with
 * no configuration. A deployment opts in with its own key in the environment;
 * without one there is nothing managed and the pool is exactly what a user
 * connected.
 *
 * This module only makes account *rows*: which row a bot's box comes from, when
 * it is created, and when it is destroyed belong to the allocator's single
 * provisioning path. Two triggers for one box is the bug this split avoids.
 */

/** A provider the deployment can lend computers from. */
export interface ManagedProviderSpec {
  provider: ManagedProvider;
  /** Environment variable that carries the deployment's key. */
  keyEnv: "INSTABOX_API_KEY" | "AGENT37_API_KEY";
  /** Human label, shown behind Advanced only. */
  label: string;
  /** How many boxes one account's plan allows at once. */
  capacity: number;
}

export type ManagedProvider = "instabox" | "agent37";

export const MANAGED_PROVIDERS: ManagedProvider[] = ["instabox", "agent37"];

export interface ManagedAccountEnv {
  INSTABOX_API_KEY?: string | undefined;
  AGENT37_API_KEY?: string | undefined;
  INSTABOX_CAPACITY?: number | string | undefined;
  AGENT37_CAPACITY?: number | string | undefined;
}

export interface EnsureManagedAccountsResult {
  /** Providers that now have a managed account row, whether new or already there. */
  ensured: ManagedProvider[];
  /** Providers with a fresh row on this call. */
  created: ManagedProvider[];
  /** Providers the deployment has no key for, so nothing was made. */
  absent: ManagedProvider[];
}

function capacityOf(raw: number | string | undefined, fallback: number): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * Which providers this deployment lends out, in a stable order. An empty list
 * is the normal case for a self-hosted install and every caller copes with it.
 */
export function managedProviderSpecs(env: ManagedAccountEnv): ManagedProviderSpec[] {
  const specs: ManagedProviderSpec[] = [];
  if (env.INSTABOX_API_KEY) {
    specs.push({
      provider: "instabox",
      keyEnv: "INSTABOX_API_KEY",
      label: "Terabot's Instabox",
      capacity: capacityOf(env.INSTABOX_CAPACITY, 1),
    });
  }
  if (env.AGENT37_API_KEY) {
    specs.push({
      provider: "agent37",
      keyEnv: "AGENT37_API_KEY",
      label: "Terabot's Agent37",
      capacity: capacityOf(env.AGENT37_CAPACITY, 1),
    });
  }
  return specs;
}

/**
 * Make sure one managed row exists per configured provider, with the key
 * encrypted the same way a user's key is. Idempotent and safe to call on boot
 * and on every request: a row that is already there is only refreshed, so
 * rotating the environment key or changing the capacity takes effect without a
 * new row and without losing the boxes already attributed to it.
 *
 * A managed row is never promoted from, or demoted to, a user row, and a user's
 * row of the same provider is untouched — the partial uniqueness rules keep the
 * two apart.
 */
export async function ensureManagedComputerAccounts(
  env: ManagedAccountEnv,
  options: { db?: Database } = {},
): Promise<EnsureManagedAccountsResult> {
  const specs = managedProviderSpecs(env);
  const absent = MANAGED_PROVIDERS.filter((provider) => !specs.some((spec) => spec.provider === provider));
  const result: EnsureManagedAccountsResult = { ensured: [], created: [], absent };

  const db = options.db ?? database();

  for (const spec of specs) {
    const apiKey = env[spec.keyEnv];
    if (!apiKey) continue;

    // The conflict target is the managed-only partial index, so two processes
    // booting together cannot both insert a row. `xmax = 0` is Postgres' own
    // insert-versus-update marker, which is how the caller learns what happened.
    const [row] = await db
      .insert(computerAccount)
      .values({
        id: newId(),
        provider: spec.provider,
        label: spec.label,
        encryptedCredential: encryptSecret(apiKey),
        status: "active",
        capacity: spec.capacity,
        managed: true,
        ownerUserId: null,
      })
      .onConflictDoUpdate({
        target: computerAccount.provider,
        targetWhere: sql`${computerAccount.managed}`,
        set: {
          capacity: spec.capacity,
          encryptedCredential: sql`excluded.encrypted_credential`,
          // A deployment that fixed its key, or put it back after removing it,
          // should not stay drained forever. `draining` on a managed row only
          // ever means the key was absent, so an ensure that has a key again is
          // the proof it should serve bots.
          status: sql`case when ${computerAccount.status} in ('error', 'draining') then 'active'::computer_account_status else ${computerAccount.status} end`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    result.ensured.push(spec.provider);
    if (row?.inserted) result.created.push(spec.provider);
  }

  // A provider the deployment stopped lending out keeps its row: the boxes on it
  // still exist, and reconcile needs the credential to find and destroy them.
  // Draining it is what stops it serving new bots, so removing the key from the
  // environment takes effect at the next ensure instead of at the next failure
  // when the allocator discovers the key no longer works.
  if (absent.length > 0) {
    await db
      .update(computerAccount)
      .set({ status: "draining" })
      .where(
        and(
          eq(computerAccount.managed, true),
          inArray(computerAccount.provider, absent),
          eq(computerAccount.status, "active"),
        ),
      );
  }

  return result;
}
