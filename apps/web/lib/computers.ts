import { isStubProviderEnabled, serverEnv } from "@pupbot/config";
import { computerAccount, database, encryptSecret, newId } from "@pupbot/db";

/**
 * The pool has to have at least one account. In development that is the fake
 * provider (no key, no spend); with INSTABOX_API_KEY in the environment and no
 * account yet, the key becomes an Instabox account. In production an account is
 * normally managed as data, and this does nothing.
 */
export async function ensureComputerPool(): Promise<void> {
  const db = database();
  const existing = await db.select({ id: computerAccount.id }).from(computerAccount).limit(1);
  if (existing.length > 0) return;

  const env = serverEnv();

  if (env.INSTABOX_API_KEY) {
    await db.insert(computerAccount).values({
      id: newId(),
      provider: "instabox",
      label: "Instabox (environment key)",
      encryptedCredential: encryptSecret(env.INSTABOX_API_KEY),
      status: "active",
      capacity: env.INSTABOX_CAPACITY,
    });
    return;
  }

  if (isStubProviderEnabled()) {
    await db.insert(computerAccount).values({
      id: newId(),
      provider: "fake",
      label: "Local fake pool",
      encryptedCredential: encryptSecret("fake"),
      status: "active",
      capacity: 5,
    });
  }
}
