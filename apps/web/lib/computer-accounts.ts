import { computerAccount, database, encryptSecret, newId } from "@terabot/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { ComputerAccountView, ProviderAvailability } from "./types.ts";

/** Providers the product can put a bot on, named for a person. */
export const PROVIDER_LABELS: Record<string, string> = {
  instabox: "Instabox",
  boat: "Boat",
  fake: "Stub (development only)",
};

/**
 * The accounts this user may see: the deployment's managed rows, plus the ones
 * they connected themselves. Another user's row is never in the list — it is
 * their key and their capacity.
 */
export async function listComputerAccounts(userId: string): Promise<ComputerAccountView[]> {
  const db = database();
  const rows = await db
    .select({
      id: computerAccount.id,
      provider: computerAccount.provider,
      label: computerAccount.label,
      status: computerAccount.status,
      capacity: computerAccount.capacity,
      managed: computerAccount.managed,
      lastError: computerAccount.lastError,
      parkedUntil: computerAccount.parkedUntil,
      hasKey: sql<boolean>`length(${computerAccount.encryptedCredential}) > 0`,
      // Counted server-side: a box can be attributed to an account the user
      // does not otherwise know about, and the count is what tells them why a
      // connect button is unavailable.
      used: sql<number>`(
        select count(*) from "computer"
        where "computer"."account_id" = ${computerAccount.id}
          and "computer"."status" <> 'deleted'
      )`,
    })
    .from(computerAccount)
    .where(
      // Managed rows for everyone, user rows only for their owner, plus rows
      // with no recorded owner (an operator's environment key or a seed).
      sql`(${computerAccount.managed} or ${computerAccount.ownerUserId} = ${userId} or ${computerAccount.ownerUserId} is null)`,
    )
    .orderBy(sql`${computerAccount.managed} desc`, computerAccount.createdAt);

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    status: row.status,
    capacity: row.capacity,
    used: Number(row.used),
    managed: row.managed,
    hasKey: row.hasKey,
    lastError: row.lastError,
    parkedUntil: row.parkedUntil ? row.parkedUntil.toISOString() : null,
  }));
}

/**
 * One entry per provider the product supports, with the two facts the UI needs
 * to avoid offering a control that cannot work.
 */
export async function providerAvailability(userId: string): Promise<ProviderAvailability[]> {
  const accounts = await listComputerAccounts(userId);
  return ["instabox", "boat"].map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider] ?? provider,
    managed: accounts.some((account) => account.provider === provider && account.managed),
    // One account per provider per user. A user with their own row cannot add
    // another; they can still connect a different provider.
    canConnect: !accounts.some((account) => account.provider === provider && !account.managed),
  }));
}

export interface ConnectAccountInput {
  provider: string;
  /** Pasted by the user and encrypted immediately; never echoed back. */
  apiKey: string;
  label?: string;
}

/**
 * Connect the user's own key for a provider. Their key then outranks the
 * deployment's managed account for their own bots.
 */
export async function connectComputerAccount(userId: string, input: ConnectAccountInput): Promise<{ id: string }> {
  const provider = input.provider.trim();
  if (!Object.hasOwn(PROVIDER_LABELS, provider) || provider === "fake") {
    throw new Error("that is not a computer provider");
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("a provider key is required");

  const db = database();
  const id = newId();
  const inserted = await db
    .insert(computerAccount)
    .values({
      id,
      provider,
      label: (input.label ?? "").trim().slice(0, 60) || `My ${PROVIDER_LABELS[provider]}`,
      encryptedCredential: encryptSecret(apiKey),
      status: "active",
      // The plan's own limit is the provider's business; the allocator parks an
      // account the provider refuses, so starting at one box is honest.
      capacity: 1,
      managed: false,
      ownerUserId: userId,
    })
    // The partial unique index on (owner_user_id, provider) is what enforces one
    // account per provider; report it as a sentence rather than a constraint name.
    .onConflictDoNothing({
      target: [computerAccount.ownerUserId, computerAccount.provider],
      where: sql`${computerAccount.ownerUserId} is not null`,
    })
    .returning({ id: computerAccount.id });

  if (!inserted[0]) throw new Error(`you already connected a ${PROVIDER_LABELS[provider] ?? provider} account`);
  return { id: inserted[0].id };
}

/**
 * Remove the user's own account. A managed row is refused here rather than
 * hidden in the UI alone: it belongs to the deployment, and deleting it would
 * take every user's fallback computer away.
 */
export async function disconnectComputerAccount(userId: string, accountId: string): Promise<void> {
  const db = database();
  const [row] = await db
    .select({ id: computerAccount.id, managed: computerAccount.managed })
    .from(computerAccount)
    .where(and(eq(computerAccount.id, accountId), eq(computerAccount.ownerUserId, userId)))
    .limit(1);

  if (!row) {
    const [managed] = await db
      .select({ id: computerAccount.id })
      .from(computerAccount)
      .where(and(eq(computerAccount.id, accountId), eq(computerAccount.managed, true)))
      .limit(1);
    throw new Error(
      managed
        ? "this computer is provided by the deployment and cannot be removed"
        : "that account is not yours to remove",
    );
  }

  await db.delete(computerAccount).where(and(eq(computerAccount.id, accountId), isNull(computerAccount.managed)));
}
