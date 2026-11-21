import { loadEnv } from "@terabot/config/load-env";
import {
  ComputerAllocator,
  DrizzleComputerStore,
  createProviderFactory,
  ensureManagedComputerAccounts,
  managedProviderSpecs,
} from "@terabot/computers";
import { bot, closeDatabase, computer, computerAccount, database, ensureWorkspace, newId, user } from "@terabot/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

loadEnv();

/**
 * The live proof of the managed path. Opt in with INSTABOX_LIVE=1 and a real
 * INSTABOX_API_KEY: this creates one box on the deployment's own account,
 * proves the allocator hands it to a bot that has no plan and no configuration,
 * and destroys it. It is skipped on `pnpm test` because a free Instabox plan
 * allows one running box.
 */
const live = process.env.INSTABOX_LIVE === "1" && Boolean(process.env.INSTABOX_API_KEY);

describe.skipIf(!live)("managed computers, live", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("ensures the deployment's account and gives a new bot a real computer", async () => {
    const db = database();
    const key = process.env.INSTABOX_API_KEY!;

    const specs = managedProviderSpecs({ INSTABOX_API_KEY: key, INSTABOX_CAPACITY: "1" });
    console.log(`  specs: ${JSON.stringify(specs.map((spec) => [spec.provider, spec.capacity]))}`);

    const first = await ensureManagedComputerAccounts({ INSTABOX_API_KEY: key, INSTABOX_CAPACITY: "1" }, { db });
    console.log(`  first ensure: created=${JSON.stringify(first.created)} ensured=${JSON.stringify(first.ensured)}`);

    const [row] = await db.select().from(computerAccount).where(eq(computerAccount.managed, true));
    expect(row?.provider).toBe("instabox");
    expect(row?.managed).toBe(true);
    expect(row?.ownerUserId).toBeNull();
    // Stored encrypted, never the plaintext, and never returned to a client.
    expect(row?.encryptedCredential.startsWith("v1:")).toBe(true);
    expect(row?.encryptedCredential).not.toContain(key.slice(0, 6));
    console.log(`  managed row: provider=${row?.provider} capacity=${row?.capacity} status=${row?.status}`);

    const second = await ensureManagedComputerAccounts({ INSTABOX_API_KEY: key }, { db });
    const rows = await db.select().from(computerAccount).where(eq(computerAccount.managed, true));
    expect(second.created).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row?.id);
    console.log("  second ensure: no new row, same id");

    const userId = `live-managed-${Date.now()}`;
    await db.insert(user).values({ id: userId, name: "Live managed proof", email: `${userId}@example.test` });
    const workspace = await ensureWorkspace(userId, "Live managed proof");
    const botId = newId();
    await db.insert(bot).values({
      id: botId,
      workspaceId: workspace.id,
      name: "Live proof bot",
      avatar: { shape: "circle", color: "#1884fc" },
      accentColor: "#1884fc",
      instructions: "",
      position: 0,
    });

    const allocator = new ComputerAllocator({
      store: new DrizzleComputerStore(),
      providers: createProviderFactory({ template: "agent-browser" }),
    });

    let computerId: string | undefined;
    try {
      const started = Date.now();
      const result = await allocator.allocateForBot(botId);
      console.log(`  allocateForBot: ${result.reason ?? result.state} in ${Date.now() - started} ms`);
      expect(result.state).toBe("ready");
      computerId = result.computerId!;

      const [box] = await db.select().from(computer).where(eq(computer.id, computerId));
      console.log(`  box: ${box?.externalId} provider=${box?.provider} status=${box?.status}`);
      console.log(`  metadata: ${JSON.stringify(box?.metadata)}`);
      expect(box?.provider).toBe("instabox");
      expect(box?.status).toBe("awake");
      // Reconcile safety: our marker must be on the box.
      expect(box?.metadata?.terabot).toBe("1");

      const ready = await allocator.ensureReady(botId);
      console.log(`  ensureReady: ok=${ready.ok} lease=${Boolean(ready.leaseId)}`);
      expect(ready.ok).toBe(true);
      if (ready.leaseId) await allocator.releaseLease(botId, ready.leaseId);

      const binding = await allocator.bindingForBot(botId);
      expect(binding.state).toBe("ready");
    } finally {
      // The destroy can be the thing that failed, so the fixtures are removed in
      // their own finally: a real key against the real application database must
      // never leave a live proof bot behind for the next run to find.
      try {
        await allocator.destroyForBot(botId);
        const [after] = computerId
          ? await db.select().from(computer).where(eq(computer.id, computerId))
          : [undefined];
        console.log(`  after destroy: computer row=${after?.status ?? "none"}`);
        expect(after?.status).toBe("deleted");
        const [botRow] = await db.select().from(bot).where(eq(bot.id, botId));
        expect(botRow?.computerState).toBe("unbound");
      } finally {
        await db.delete(bot).where(eq(bot.id, botId));
        await db.delete(user).where(eq(user.id, userId));
      }
    }
  }, 600_000);
});
