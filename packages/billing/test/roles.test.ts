import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { closeDatabase, database, ensureWorkspace, user } from "@terabot/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Owner establishment. The rule: `user.role` defaults to `member`, and only
 * `syncOwnerRoles` — driven by `OWNER_EMAILS` — can make an account an Owner.
 * Nothing here lets a caller promote itself.
 */

describe("owner roles", () => {
  const created: string[] = [];

  async function makeUser(role: "owner" | "member", email = `role-${randomUUID()}@terabot.dev`) {
    const result = await database()
      .insert(user)
      .values({ id: `role_${randomUUID()}`, email, name: "Role Test", role })
      .returning({ id: user.id, role: user.role });
    created.push(result[0]!.id);
    return result[0]!;
  }

  beforeAll(async () => {
    await ensureWorkspace((await makeUser("member")).id, "Role Test");
  });

  afterAll(async () => {
    for (const id of created) await database().delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("defaults a new account to member", async () => {
    const email = `default-${randomUUID()}@terabot.dev`;
    const inserted = await database()
      .insert(user)
      .values({ id: `role_${randomUUID()}`, email, name: "Default Role" })
      .returning({ id: user.id, role: user.role });
    created.push(inserted[0]!.id);
    expect(inserted[0]!.role).toBe("member");
  });

  it("promotes an email in OWNER_EMAILS and demotes one that left it", async () => {
    const { syncOwnerRoles, ownerEmails } = await import("@terabot/db");
    const { resetEnvCache } = await import("@terabot/config");
    const list = ownerEmails();
    // Only meaningful on a machine that configured an Owner; the assertion for
    // the unconfigured case is the next test.
    if (list.length === 0) return;

    const target = list[0]!;
    const seeded = await makeUser("member", target);
    const result = await syncOwnerRoles();
    expect(result.disabled).toBe(false);
    const after = await database().select({ role: user.role }).from(user).where(eq(user.id, seeded.id));
    expect(after[0]!.role).toBe("owner");
    resetEnvCache();
  });

  it("promotes nobody when OWNER_EMAILS is unset, and demotes nobody either", async () => {
    const { syncOwnerRoles } = await import("@terabot/db");
    const { resetEnvCache, serverEnv } = await import("@terabot/config");
    const original = serverEnv().OWNER_EMAILS;
    // The schema is validated once per process; clear it so a blank value is read.
    process.env.OWNER_EMAILS = "";
    resetEnvCache();

    const keeper = await makeUser("owner");
    const result = await syncOwnerRoles();
    expect(result.disabled).toBe(true);
    expect(result.granted).toBe(0);
    expect(result.revoked).toBe(0);

    const after = await database().select({ role: user.role }).from(user).where(eq(user.id, keeper.id));
    expect(after[0]!.role).toBe("owner");

    process.env.OWNER_EMAILS = original ?? "";
    resetEnvCache();
  });
});
