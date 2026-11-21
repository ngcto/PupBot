import { loadEnv } from "@terabot/config/load-env";
import { closeDatabase, database } from "@terabot/db";
import { computerAccount, user } from "@terabot/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ensureManagedComputerAccounts, managedProviderSpecs } from "../src/accounts.ts";

loadEnv();

const db = database();

afterAll(async () => {
  await closeDatabase();
});

async function managedRows() {
  return db.select().from(computerAccount).where(eq(computerAccount.managed, true));
}

describe("managed computer accounts against Postgres", () => {
  it("does nothing at all when the deployment configured no key", async () => {
    const before = await managedRows();
    const result = await ensureManagedComputerAccounts({}, { db });
    expect(result.ensured).toEqual([]);
    expect(result.absent).toEqual(["instabox"]);
    expect(await managedRows()).toHaveLength(before.length);
  });

  it("creates the managed row for a configured provider and is idempotent", async () => {
    await db.delete(computerAccount).where(eq(computerAccount.managed, true));

    const first = await ensureManagedComputerAccounts(
      { INSTABOX_API_KEY: "ibx-test-key", INSTABOX_CAPACITY: "2" },
      { db },
    );
    expect(first.created).toEqual(["instabox"]);
    expect(first.absent).toEqual([]);

    const rows = await managedRows();
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
    // No duplicate row, and the id survived, so boxes already allocated to this
    // account stay attributed.
    const again = await managedRows();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(rows[0]?.id);
  });

  it("refreshes capacity and a rotated key on the same row", async () => {
    const [before] = await managedRows();
    expect(before).toBeTruthy();

    await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "rotated-key", INSTABOX_CAPACITY: "7" }, { db });

    const [after] = (await managedRows()).filter((row) => row.provider === "instabox");
    expect(after?.id).toBe(before!.id);
    expect(after?.capacity).toBe(7);
    expect(after?.encryptedCredential).not.toBe(before!.encryptedCredential);
  });

  it("brings a drained managed account back once the key works again", async () => {
    await db
      .update(computerAccount)
      .set({ status: "error", lastError: "auth: key revoked" })
      .where(and(eq(computerAccount.managed, true), eq(computerAccount.provider, "instabox")));

    await ensureManagedComputerAccounts({ INSTABOX_API_KEY: "fixed-key" }, { db });

    const [row] = (await managedRows()).filter((entry) => entry.provider === "instabox");
    expect(row?.status).toBe("active");
  });

  it("never turns a user's own account into a managed one or back", async () => {
    const userId = `test-managed-${Date.now()}`;
    await db.insert(user).values({ id: userId, name: "Managed Test", email: `${userId}@example.test` });
    try {
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
    } finally {
      await db.delete(computerAccount).where(eq(computerAccount.ownerUserId, userId));
      await db.delete(user).where(eq(user.id, userId));
    }
  });
});

describe("managedProviderSpecs under the config schema defaults", () => {
  it("never invents a provider the environment did not configure", () => {
    expect(managedProviderSpecs({}).map((spec) => spec.provider)).toEqual([]);
  });
});
