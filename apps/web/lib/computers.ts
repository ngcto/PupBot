import { isStubProviderEnabled, serverEnv } from "@terabot/config";
import { computerAccount, database, encryptSecret, newId } from "@terabot/db";
import { and, eq } from "drizzle-orm";

/**
 * The pool has to have at least one account. In development that is the fake
 * provider (no key, no spend); with INSTABOX_API_KEY in the environment and no
 * account yet, the key becomes an Instabox account. In production an account is
 * normally managed as data, and this does nothing.
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
    .where(and(eq(computerAccount.provider, provider), eq(computerAccount.status, "active")))
    .limit(1);
  if (existing.length > 0) return;

  if (apiKey) {
    await db.insert(computerAccount).values({
      id: newId(),
      provider: "instabox",
      label: "Instabox (environment key)",
      encryptedCredential: encryptSecret(apiKey),
      status: "active",
      capacity: serverEnv().INSTABOX_CAPACITY,
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
  });
}
