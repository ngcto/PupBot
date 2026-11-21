import {
  bot as botTable,
  botComputer,
  computer as computerTable,
  computerAccount,
  computerLease,
  database,
  newId,
} from "@terabot/db";
import type { Database } from "@terabot/db";
import { and, eq, isNull, lt } from "drizzle-orm";
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
} from "./types.ts";
import type { ComputerRowStatus } from "./types.ts";

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

  async listAccounts(): Promise<AccountRecord[]> {
    const rows = await this.#db.select().from(computerAccount);
    return rows.map(toAccount);
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

type AccountRow = typeof computerAccount.$inferSelect;
type ComputerRow = typeof computerTable.$inferSelect;

function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
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
