import { loadEnv } from "@terabot/config/load-env";
import { closeDatabase, database } from "@terabot/db";
import type { Database } from "@terabot/db";
import { computerAccount, user } from "@terabot/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ensureManagedComputerAccounts, managedProviderSpecs } from "../src/accounts.ts";

loadEnv();

const sqlNotManaged = sql`${computerAccount.ownerUserId} is not null`;

/**
 * These tests mutate `computer_account`, so they run inside a transaction that
 * is always rolled back. `pnpm test` points at the configured application
 * database, and a suite that committed here would delete the deployment's real
 * managed account, null every computer's `account_id` through the foreign key,
 * and leave a dummy credential behind. Drizzle's transaction handle is the only
 * database the tests touch.
 */
class Rollback extends Error {}

const handle = database();
let tx: Database;

async function inRolledBackTransaction(fn: (db: Database) => Promise<void>): Promise<void> {
  try {
    await handle.transaction(async (inner) => {
      tx = inner as unknown as Database;
      await fn(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

afterAll(async () => {
  await closeDatabase();
});

async function managedRows(db: Database) {
  return db.select().from(computerAccount).where(eq(computerAccount.managed, true));
}

describe("managed computer accounts against Postgres", () => {
  it("creates nothing when the deployment configured no key, and drains what is left", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.delete(computerAccount).where(eq(computerAccount.managed, true));
      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "ibx-test-key" }, { db });

      const result = await ensureManagedComputerAccounts({}, { db });
      expect(result.ensured).toEqual([]);
      expect(result.absent).toEqual(["instabox", "agent37"]);

      // The row stays, because the boxes on it still exist and reconcile needs
      // the credential to find them; draining is what stops it serving bots.
      const rows = await managedRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("draining");
    });
  });

  it("brings a managed account back when the key returns", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.delete(computerAccount).where(eq(computerAccount.managed, true));
      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "ibx-test-key" }, { db });
      await ensureManagedComputerAccounts({}, { db });
      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "ibx-test-key" }, { db });

      const rows = await managedRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("active");
    });
  });

  it("creates the managed row for a configured provider and is idempotent", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.delete(computerAccount).where(eq(computerAccount.managed, true));

      const first = await ensureManagedComputerAccounts(
        { INSTABOX_API_KEY: "ibx-test-key", INSTABOX_CAPACITY: "2" },
        { db },
      );
      expect(first.created).toEqual(["instabox"]);
      expect(first.absent).toEqual(["agent37"]);

      const rows = await managedRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.provider).toBe("instabox");
      expect(rows[0]?.ownerUserId).toBeNull();
      expect(rows[0]?.managed).toBe(true);
      expect(rows[0]?.capacity).toBe(2);
      // The key is stored encrypted, never in the clear.
      expect(rows[0]?.encryptedCredential).not.toContain("test-key");
      expect(rows[0]?.encryptedCredential.split(":")).toHaveLength(4);

      const second = await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "ibx-test-key" }, { db });
      expect(second.created).toEqual([]);
      expect(second.ensured).toEqual(["instabox"]);
      // No duplicate row, and the id survived, so boxes already allocated to
      // this account stay attributed.
      const again = await managedRows(db);
      expect(again).toHaveLength(1);
      expect(again[0]?.id).toBe(rows[0]?.id);
    });
  });

  it("refreshes capacity and a rotated key on the same row", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.delete(computerAccount).where(eq(computerAccount.managed, true));
      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "first-key", INSTABOX_CAPACITY: "1" }, { db });
      const [before] = await managedRows(db);
      expect(before).toBeTruthy();

      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "rotated-key", INSTABOX_CAPACITY: "7" }, { db });

      const [after] = await managedRows(db);
      expect(after?.id).toBe(before!.id);
      expect(after?.capacity).toBe(7);
      expect(after?.encryptedCredential).not.toBe(before!.encryptedCredential);
    });
  });

  it("brings a drained managed account back once the key works again", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.delete(computerAccount).where(eq(computerAccount.managed, true));
      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "k" }, { db });
      await db
        .update(computerAccount)
        .set({ status: "error", lastError: "auth: key revoked" })
        .where(eq(computerAccount.managed, true));

      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "fixed-key" }, { db });

      const [row] = await managedRows(db);
      expect(row?.status).toBe("active");
    });
  });

  it("never turns a user's own account into a managed one or back", async () => {
    await inRolledBackTransaction(async (db) => {
      const userId = `test-managed-${Date.now()}`;
      await db.insert(user).values({ id: userId, name: "Managed Test", email: `${userId}@example.test` });
      const [mine] = await db
        .insert(computerAccount)
        .values({
          id: crypto.randomUUID(),
          provider: "boat",
          label: "My Boat",
          encryptedCredential: "v1:aa:bb:cc",
          status: "active",
          capacity: 1,
          managed: false,
          ownerUserId: userId,
        })
        .returning();

      await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "k" }, { db });

      const [after] = await db.select().from(computerAccount).where(eq(computerAccount.id, mine!.id));
      expect(after?.managed).toBe(false);
      expect(after?.ownerUserId).toBe(userId);
    });
  });

  it("allows one account per provider per user, and manages a different provider alongside", async () => {
    await inRolledBackTransaction(async (db) => {
      const userId = `test-unique-${Date.now()}`;
      await db.insert(user).values({ id: userId, name: "Unique Test", email: `${userId}@example.test` });
      const insert = (provider: string) =>
        db
          .insert(computerAccount)
          .values({
            id: crypto.randomUUID(),
            provider,
            label: `Mine ${provider}`,
            encryptedCredential: "v1:aa:bb:cc",
            status: "active",
            capacity: 1,
            managed: false,
            ownerUserId: userId,
          })
          .onConflictDoNothing({
            target: [computerAccount.ownerUserId, computerAccount.provider],
            where: sqlNotManaged,
          })
          .returning({ id: computerAccount.id });

      expect(await insert("instabox")).toHaveLength(1);
      // A second account of the same provider is refused...
      expect(await insert("instabox")).toHaveLength(0);
      // ...but a different provider is fine.
      expect(await insert("agent37")).toHaveLength(1);

      // And a different user may still connect their own Instabox.
      const other = `test-unique-other-${Date.now()}`;
      await db.insert(user).values({ id: other, name: "Other", email: `${other}@example.test` });
      const [row] = await db
        .insert(computerAccount)
        .values({
          id: crypto.randomUUID(),
          provider: "instabox",
          label: "Their Instabox",
          encryptedCredential: "v1:aa:bb:cc",
          status: "active",
          capacity: 1,
          managed: false,
          ownerUserId: other,
        })
        .returning({ id: computerAccount.id });
      expect(row?.id).toBeTruthy();
    });
  });
});

describe("managedProviderSpecs under the config schema defaults", () => {
  it("never invents a provider the environment did not configure", () => {
    expect(managedProviderSpecs({}).map((spec) => spec.provider)).toEqual([]);
  });
});
