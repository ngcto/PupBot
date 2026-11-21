import { sql } from "drizzle-orm";
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
  keyEnv: "INSTABOX_API_KEY";
  /** Human label, shown behind Advanced only. */
  label: string;
  /** How many boxes one account's plan allows at once. */
  capacity: number;
}

export type ManagedProvider = "instabox";

export const MANAGED_PROVIDERS: ManagedProvider[] = ["instabox"];

export interface ManagedAccountEnv {
  INSTABOX_API_KEY?: string | undefined;
  INSTABOX_CAPACITY?: number | string | undefined;
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
  const result: EnsureManagedAccountsResult = {
    ensured: [],
    created: [],
    absent: MANAGED_PROVIDERS.filter((provider) => !specs.some((spec) => spec.provider === provider)),
  };
  if (specs.length === 0) return result;

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
          // A deployment that fixed its key should not stay drained forever.
          status: sql`case when ${computerAccount.status} = 'error' then 'active'::computer_account_status else ${computerAccount.status} end`,        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    result.ensured.push(spec.provider);
    if (row?.inserted) result.created.push(spec.provider);
  }

  return result;
}
