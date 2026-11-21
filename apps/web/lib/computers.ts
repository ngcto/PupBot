import { isStubProviderEnabled, serverEnv } from "@terabot/config";
import { ensureManagedComputerAccounts } from "@terabot/computers";
import { computerAccount, database, encryptSecret, newId } from "@terabot/db";
import { and, eq } from "drizzle-orm";

/**
 * The pool a bot's computer comes from.
 *
 * A deployment that sets `INSTABOX_API_KEY` lends out its own computers: this
 * makes the account row for that key, encrypted the same way a user's key is, so
 * a new user with no plan and no configuration still gets a working computer.
 * Without a key the deployment lends nothing.
 *
 * Development additionally gets the in-memory fake so the app runs with no key
 * and no spend. In production nothing is created implicitly: a missing key means
 * no managed capacity, and the product says so plainly instead of provisioning.
 *
 * This only ensures *rows*. Which bot gets which box, and when, belongs to the
 * allocator's single provisioning path.
 */
export async function ensureComputerPool(): Promise<void> {
  const env = serverEnv();
  await ensureManagedComputerAccounts({
    INSTABOX_API_KEY: env.INSTABOX_API_KEY,
    AGENT37_API_KEY: env.AGENT37_API_KEY,
    INSTABOX_CAPACITY: env.INSTABOX_CAPACITY,
    AGENT37_CAPACITY: env.AGENT37_CAPACITY,
  });

  if (isStubProviderEnabled()) await ensureFakeAccount();
}

/**
 * The stub provider lives in one process' memory, so it is a development
 * convenience rather than a computer source. It is never managed: a deployment
 * did not provide it, and a user did not configure it.
 */
async function ensureFakeAccount(): Promise<void> {
  const db = database();
  const existing = await db
    .select({ id: computerAccount.id })
    .from(computerAccount)
    .where(and(eq(computerAccount.provider, "fake"), eq(computerAccount.status, "active")))
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(computerAccount).values({
    id: newId(),
    provider: "fake",
    label: "Local fake pool",
    encryptedCredential: encryptSecret("fake"),
    status: "active",
    capacity: 5,
    managed: false,
  });
}
