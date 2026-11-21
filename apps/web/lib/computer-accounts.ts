import { computerAccount, computer, database, encryptSecret, newId } from "@terabot/db";
import { and, eq, sql } from "drizzle-orm";
import type { ComputerAccountView, ProviderAvailability } from "./types.ts";

/** Providers the product can put a bot on, named for a person. */
export const PROVIDER_LABELS: Record<string, string> = {
  instabox: "Instabox",
  agent37: "Agent37",
  boat: "Boat",
  fake: "Stub (development only)",
};

/**
 * Providers a user may connect a key for.
 *
 * This is a capability list, not a catalogue: a provider appears once
 * `createProviderFactory` can build it. Boat's key is documented and its row
 * would be accepted, but its provider still throws "not implemented", so
 * offering it would take a credential and then fail every allocation. Adding a
 * provider here is the last step of implementing it.
 */
export const CONNECTABLE_PROVIDERS = ["instabox", "agent37"] as const;

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
      ownerUserId: computerAccount.ownerUserId,
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
    ownerUserId: row.ownerUserId,
    hasKey: row.hasKey,
    lastError: row.lastError,
    parkedUntil: row.parkedUntil ? row.parkedUntil.toISOString() : null,
  }));
}

/**
 * One entry per provider a user may connect.
 *
 * A provider is offered only if the product can actually run a bot on it: Boat
 * has no provider implementation yet, so offering its key would accept a
 * credential and then fail every allocation. `canConnect` counts only accounts
 * the *user* owns — a shared or legacy account visible to them must not consume
 * their one slot.
 */
export async function providerAvailability(userId: string): Promise<ProviderAvailability[]> {
  const accounts = await listComputerAccounts(userId);
  const mine = accounts.filter((account) => account.ownerUserId === userId);
  return CONNECTABLE_PROVIDERS.map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider] ?? provider,
    managed: accounts.some((account) => account.provider === provider && account.managed),
    // One account per provider per user. A user with their own row cannot add
    // another; they can still connect a different provider.
    canConnect: !mine.some((entry) => entry.provider === provider),
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
  if (!(CONNECTABLE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error("that computer provider is not available yet");
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

  // Stop new allocations first, then look again. The allocator only provisions
  // from an `active` account, so a provisioning request that had not yet read
  // this row now refuses to use it, and the count below is read against a pool
  // that can no longer grow. Without this a create in flight would land after
  // the delete, fail its foreign key, and leave a machine nobody has a row for.
  await db
    .update(computerAccount)
    .set({ status: "draining" })
    .where(and(eq(computerAccount.id, accountId), eq(computerAccount.ownerUserId, userId)));

  // `computer.account_id` is ON DELETE SET NULL, so deleting the row would leave
  // every box it owns attached to nothing: the idle sweep skips a box with no
  // account and reconcile only walks accounts that still exist, so nothing would
  // ever destroy it. Refuse while a box exists rather than orphan it.
  //
  // Waiting for the box to sleep does not help: a sleeping box still occupies
  // this account, which is why the count is every non-deleted row, and the only
  // way out is to delete the bots that own them.
  const [attached] = await db
    .select({ count: sql<number>`count(*)` })
    .from(computer)
    .where(and(eq(computer.accountId, accountId), sql`${computer.status} <> 'deleted'`));
  const live = Number(attached?.count ?? 0);
  if (live > 0) {
    // Back to serving bots: a refused disconnect must not leave the account
    // draining, which would quietly take the user's own computer away.
    await db
      .update(computerAccount)
      .set({ status: "active" })
      .where(and(eq(computerAccount.id, accountId), eq(computerAccount.ownerUserId, userId)));
    throw new Error(
      live === 1
        ? "this computer still has a bot's machine. Delete that bot, then disconnect."
        : `this computer still has ${live} bots' machines. Delete those bots, then disconnect.`,
    );
  }

  await db
    .delete(computerAccount)
    .where(
      and(
        eq(computerAccount.id, accountId),
        eq(computerAccount.ownerUserId, userId),
        // `managed` is NOT NULL with a false default, so this must compare to
        // false rather than test for null.
        eq(computerAccount.managed, false),
      ),
    );
}
