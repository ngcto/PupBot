import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  bot as botTable,
  botComputer,
  computer as computerTable,
  computerAccount,
  computerLease,
  computerOrphan,
  database,
  newId,
  workspace,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import type {
  AccountPatch,
  AccountRecord,
  BindingRecord,
  BindingState,
  ComputerPatch,
  ComputerRecord,
  ComputerStore,
  CreateComputerInput,
  LeaseRecord,
  OrphanRecord,
  OrphanReason,
} from "./types.ts";
import type { ComputerRowStatus } from "./types.ts";
import type { PoolAvailability } from "./failures.ts";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * The Postgres store. The bot row carries the binding state the product reads
 * ("unbound", "binding", "ready", "blocked" plus the reason) and `bot_computer`
 * carries the link to the box, which is what reconcile needs after a crash.
 */
export class DrizzleComputerStore implements ComputerStore {
  readonly #db: Database;

  constructor(db: Database = database()) {
    this.#db = db;
  }

  /**
   * Accounts a bot may draw on: the ones its own workspace configured plus the
   * deployment's managed pools. The old version returned every row in the table,
   * so one user's key could be spent provisioning another user's bot.
   */
  async botOwnerUserId(botId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ ownerId: workspace.ownerId })
      .from(botTable)
      .innerJoin(workspace, eq(workspace.id, botTable.workspaceId))
      .where(eq(botTable.id, botId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = await this.#db.select().from(computerAccount);
    return rows.map(toAccount);
  }

  /**
   * What a bot's workspace can reach, which decides what a blocked bot is told.
   * The allocator sees accounts, not entitlement, so a managed pool that needs a
   * plan and a workspace with no plan both look like "no active account" to it.
   */
  async poolAvailabilityFor(botId: string): Promise<PoolAvailability> {
    const bots = await this.#db
      .select({ workspaceId: botTable.workspaceId })
      .from(botTable)
      .where(eq(botTable.id, botId))
      .limit(1);
    if (!bots[0]) return { managedPool: false, planMissing: false };

    const managed = await this.#db
      .select({ id: computerAccount.id })
      .from(computerAccount)
      .where(and(eq(computerAccount.managed, true), eq(computerAccount.status, "active")))
      .limit(1);

    /*
     * KNOWN-INCOMPLETE (TERA-71, billing/Polar): `planMissing` is hardcoded false.
     *
     * There is no entitlement to read yet, so every deployment pool is treated as
     * usable. The consequence is concrete: on a Polar-gated deployment a user with
     * no plan is never told they need one — they are told the pool is busy, which
     * is a different problem with a different fix. That is a wrong answer, not an
     * unfinished feature, and it is why this is called out rather than left as a
     * quiet default.
     *
     * This one return is the seam. When billing lands it asks for an entitlement
     * for this bot's owner and sets `planMissing` from it; nothing above this line
     * has to change, because `classifyFailure` already turns a missing plan into
     * the `no_plan` obstacle with its own wording and its own "choose a plan"
     * action. `no_plan` is already proven against a supplied `PoolAvailability`.
     */
    return { managedPool: managed.length > 0, planMissing: false };
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    await this.#db
      .update(computerAccount)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
        ...(patch.parkedUntil !== undefined
          ? { parkedUntil: patch.parkedUntil ? new Date(patch.parkedUntil) : null }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      })
      .where(eq(computerAccount.id, id));
  }

  async listComputers(): Promise<ComputerRecord[]> {
    const rows = await this.#db.select().from(computerTable);
    return rows.map(toComputer);
  }

  async getComputer(id: string): Promise<ComputerRecord | null> {
    const rows = await this.#db.select().from(computerTable).where(eq(computerTable.id, id)).limit(1);
    return rows[0] ? toComputer(rows[0]) : null;
  }

  async createComputer(input: CreateComputerInput): Promise<ComputerRecord> {
    const id = newId();
    const [row] = await this.#db
      .insert(computerTable)
      .values({
        id,
        accountId: input.accountId,
        workspaceId: input.workspaceId ?? null,
        provider: input.provider,
        externalId: input.externalId,
        status: input.status,
        metadata: input.metadata ?? null,
        lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null,
      })
      .returning();
    return toComputer(row!);
  }

  async updateComputer(id: string, patch: ComputerPatch): Promise<void> {
    await this.#db
      .update(computerTable)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.lastUsedAt !== undefined
          ? { lastUsedAt: patch.lastUsedAt ? new Date(patch.lastUsedAt) : null }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        ...(patch.lastErrorCode !== undefined ? { lastErrorCode: patch.lastErrorCode } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      })
      .where(eq(computerTable.id, id));
  }

  async botExists(botId: string): Promise<boolean> {
    const rows = await this.#db.select({ id: botTable.id }).from(botTable).where(eq(botTable.id, botId)).limit(1);
    return rows.length > 0;
  }

  async botWorkspaceId(botId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ workspaceId: botTable.workspaceId })
      .from(botTable)
      .where(eq(botTable.id, botId))
      .limit(1);
    return rows[0]?.workspaceId ?? null;
  }

  async botBinding(botId: string): Promise<BindingRecord | null> {
    const rows = await this.#db
      .select({ state: botTable.computerState, reason: botTable.computerReason })
      .from(botTable)
      .where(eq(botTable.id, botId))
      .limit(1);
    const bot = rows[0];
    if (!bot) return null;

    const links = await this.#db
      .select({ computer: computerTable })
      .from(botComputer)
      .innerJoin(computerTable, eq(computerTable.id, botComputer.computerId))
      .where(and(eq(botComputer.botId, botId), isNull(botComputer.releasedAt)))
      .limit(1);

    return {
      botId,
      state: bot.state as BindingState,
      reason: bot.reason,
      computer: links[0] ? toComputer(links[0].computer) : null,
    };
  }

  async setBindingState(botId: string, state: BindingState, reason: string | null): Promise<void> {
    await this.#db
      .update(botTable)
      .set({ computerState: state, computerReason: reason, updatedAt: new Date() })
      .where(eq(botTable.id, botId));
  }

  /**
   * Link a box to a bot, but only if the bot has no live box.
   *
   * This is the single-box guarantee, and it is enforced by Postgres rather than
   * by the caller: `bot_computer_active_idx` is unique on `bot_id` where
   * `released_at is null`, so a second concurrent insert for the same bot
   * violates it and this returns false. The caller then destroys the box it just
   * made — it is the loser of the race and holds a box nobody will use. An
   * in-process lock cannot promise this, because two runs can be served by two
   * processes (the web app and the worker, or two serverless instances).
   */
  async tryBindComputer(botId: string, computer: ComputerRecord): Promise<boolean> {
    try {
      await this.#db.transaction(async (tx) => {
        await tx.insert(botComputer).values({ id: newId(), botId, computerId: computer.id });
        await tx
          .update(botTable)
          .set({ computerState: "ready", computerReason: null, updatedAt: new Date() })
          .where(eq(botTable.id, botId));
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error, "bot_computer_active_idx")) return false;
      throw error;
    }
  }

  async bindComputer(botId: string, computer: ComputerRecord): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(botComputer)
        .set({ releasedAt: new Date() })
        .where(and(eq(botComputer.botId, botId), isNull(botComputer.releasedAt)));
      await tx.insert(botComputer).values({ id: newId(), botId, computerId: computer.id });
      await tx
        .update(botTable)
        .set({ computerState: "ready", computerReason: null, updatedAt: new Date() })
        .where(eq(botTable.id, botId));
    });
  }

  async releaseComputer(botId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .update(botComputer)
        .set({ releasedAt: new Date() })
        .where(and(eq(botComputer.botId, botId), isNull(botComputer.releasedAt)));
      await tx
        .update(botTable)
        .set({ computerState: "unbound", computerReason: null, updatedAt: new Date() })
        .where(eq(botTable.id, botId));
    });
  }

  async staleBindingBotIds(before: string): Promise<string[]> {
    const rows = await this.#db
      .select({ id: botTable.id })
      .from(botTable)
      .where(and(eq(botTable.computerState, "binding"), lt(botTable.updatedAt, new Date(before))));
    return rows.map((row) => row.id);
  }

  async botForComputer(computerId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ botId: botComputer.botId })
      .from(botComputer)
      .where(and(eq(botComputer.computerId, computerId), isNull(botComputer.releasedAt)))
      .limit(1);
    return rows[0]?.botId ?? null;
  }

  async listOrphans(): Promise<OrphanRecord[]> {
    const rows = await this.#db.select().from(computerOrphan);
    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      provider: row.provider,
      externalId: row.externalId,
      reason: row.reason as OrphanReason,
      botId: row.botId,
      attempts: row.attempts,
      lastError: row.lastError,
      lastAttemptAt: iso(row.lastAttemptAt),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async recordOrphan(input: {
    accountId: string | null;
    provider: string;
    externalId: string;
    reason: OrphanReason;
    botId?: string | null;
    lastError: string;
  }): Promise<void> {
    await this.#db.insert(computerOrphan).values({
      id: newId(),
      accountId: input.accountId,
      provider: input.provider,
      externalId: input.externalId,
      reason: input.reason,
      botId: input.botId ?? null,
      lastError: input.lastError,
    });
  }

  async markOrphanAttempt(id: string, error: string | null): Promise<void> {
    await this.#db
      .update(computerOrphan)
      .set({
        attempts: sql`${computerOrphan.attempts} + 1`,
        lastError: error,
        lastAttemptAt: new Date(),
      })
      .where(eq(computerOrphan.id, id));
  }

  async deleteOrphan(id: string): Promise<void> {
    await this.#db.delete(computerOrphan).where(eq(computerOrphan.id, id));
  }

  async listLeases(): Promise<LeaseRecord[]> {
    const rows = await this.#db.select().from(computerLease);
    return rows.map((row) => ({ id: row.id, computerId: row.computerId, expiresAt: row.expiresAt.toISOString() }));
  }

  async putLease(lease: LeaseRecord): Promise<void> {
    await this.#db
      .insert(computerLease)
      .values({ id: lease.id, computerId: lease.computerId, expiresAt: new Date(lease.expiresAt) })
      .onConflictDoUpdate({
        target: computerLease.id,
        set: { expiresAt: new Date(lease.expiresAt) },
      });
  }

  async deleteLease(id: string): Promise<void> {
    await this.#db.delete(computerLease).where(eq(computerLease.id, id));
  }

  async deleteLeasesForComputer(computerId: string): Promise<void> {
    await this.#db.delete(computerLease).where(eq(computerLease.computerId, computerId));
  }
}

/** Postgres reports a unique-index violation with SQLSTATE 23505 and the index name. */
function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: string; constraint?: string; detail?: string; cause?: unknown };
  if (candidate.code === "23505") {
    return candidate.constraint === indexName || (candidate.detail?.includes(indexName) ?? false);
  }
  return isUniqueViolation(candidate.cause, indexName);
}

type AccountRow = typeof computerAccount.$inferSelect;
type ComputerRow = typeof computerTable.$inferSelect;

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    managed: row.managed,
    provider: row.provider,
    label: row.label,
    encryptedCredential: row.encryptedCredential,
    status: row.status,
    capacity: row.capacity,
    parkedUntil: iso(row.parkedUntil),
    lastError: row.lastError,
  };
}

function toComputer(row: ComputerRow): ComputerRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    provider: row.provider,
    externalId: row.externalId ?? "",
    status: row.status as ComputerRowStatus,
    metadata: (row.metadata as Record<string, string> | null) ?? null,
    lastUsedAt: iso(row.lastUsedAt),
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
  };
}
