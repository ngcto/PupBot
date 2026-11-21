import { isStubProviderEnabled, serverEnv } from "@terabot/config";
import { computerAccount, database, encryptSecret, newId } from "@terabot/db";
import { and, eq } from "drizzle-orm";

/**
 * The deployment's managed pool: a computer account built from an environment key,
 * which every workspace may draw on.
 *
 * A managed account has no `workspace_id` and `managed = true`, which is what
 * takes it out of the one-per-provider rule — it is the deployment's row, not a
 * workspace's. In development the pool is the fake provider (no key, no spend);
 * with `INSTABOX_API_KEY` set it is Instabox. In production accounts are normally
 * data, and this does nothing.
 *
 * The lookup is per provider, not "is any row there": a seeded or abandoned
 * account of another kind must not stop the real pool from being created, and
 * must not be handed to the allocator as if it could run boxes.
 */
export async function ensureComputerPool(): Promise<void> {
  const apiKey = serverEnv().INSTABOX_API_KEY;
  const provider = apiKey ? "instabox" : "fake";
  if (provider === "fake" && !isStubProviderEnabled()) return;

  const db = database();
  const existing = await db
    .select({ id: computerAccount.id })
    .from(computerAccount)
    .where(
      and(
        eq(computerAccount.provider, provider),
        eq(computerAccount.status, "active"),
        eq(computerAccount.managed, true),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  if (apiKey) {
    await db.insert(computerAccount).values({
      id: newId(),
      provider: "instabox",
      label: "Instabox (deployment key)",
      encryptedCredential: encryptSecret(apiKey),
      status: "active",
      capacity: serverEnv().INSTABOX_CAPACITY,
      managed: true,
    });
    return;
  }

  await db.insert(computerAccount).values({
    id: newId(),
    provider: "fake",
    label: "Local fake pool",
    encryptedCredential: encryptSecret("fake"),
    status: "active",
    capacity: 5,
    managed: true,
  });
}
