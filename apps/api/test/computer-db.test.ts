import { loadEnv } from "@terabot/config/load-env";
import {
  ComputerAllocator,
  DrizzleComputerStore,
  FakeComputerProvider,
  createComputerRuntime,
  createProviderFactory,
  eligibleAccounts,
} from "@terabot/computers";
import type { AccountRecord, ComputerProvider } from "@terabot/computers";
import {
  auth,
  bot,
  closeDatabase,
  computer,
  computerAccount,
  computerOrphan,
  conversation,
  database,
  encryptSecret,
  ensureWorkspace,
  newId,
  user,
} from "@terabot/db";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

loadEnv();
const db = database();

/**
 * The allocator against the real schema.
 *
 * The in-memory store proves the rules; this proves the *rules as Postgres
 * enforces them* — the partial unique index, the atomic bind, the orphan ledger
 * and the workspace scoping, all of which are database behaviour that a memory
 * store can only imitate.
 */

async function workspaceFor(name: string) {
  const email = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@terabot.dev`;
  const signUp = await auth().api.signUpEmail({
    body: { email, password: "computer-db-password", name: "Computer DB" },
    returnHeaders: true,
  });
  const user = signUp.response.user as { id: string };
  const workspaceRow = await ensureWorkspace(user.id, "Computer DB");
  return { ...workspaceRow, ownerId: user.id };
}

async function makeBot(workspaceId: string, name: string) {
  const botId = newId();
  const conversationId = newId();
  await db.insert(bot).values({
    id: botId,
    workspaceId,
    name,
    avatar: { shape: "circle", color: "amber" },
    accentColor: "#f69412",
    instructions: "",
    computerState: "unbound",
  });
  await db.insert(conversation).values({ id: conversationId, botId, title: name });
  return botId;
}

/** A provider whose boxes live in the test process, counting the lifecycle calls. */
function spyProviders() {
  const fakes = new Map<string, FakeComputerProvider>();
  const destroyed: string[] = [];
  let destroyFails = 0;

  const factory = (account: AccountRecord): ComputerProvider => {
    let fake = fakes.get(account.id);
    if (!fake) {
      fake = new FakeComputerProvider({ account: account.id });
      fakes.set(account.id, fake);
    }
    const wrapped = fake;
    return {
      name: wrapped.name,
      account: wrapped.account,
      provision: (options) => wrapped.provision(options),
      start: (ref, options) => wrapped.start(ref, options),
      sleep: (ref) => wrapped.sleep(ref),
      async destroy(ref) {
        if (destroyFails > 0) {
          destroyFails -= 1;
          const { ProviderError } = await import("@terabot/computers");
          throw new ProviderError("unavailable", "the provider is down");
        }
        destroyed.push(ref.id);
        await wrapped.destroy(ref);
      },
      exec: (ref, command, options) => wrapped.exec(ref, command, options),
      putFile: (ref, path, data) => wrapped.putFile(ref, path, data),
      getFile: (ref, path) => wrapped.getFile(ref, path),
      list: (ref, path) => wrapped.list(ref, path),
      screenshot: (ref) => wrapped.screenshot(ref),
      status: (ref) => wrapped.status(ref),
      lease: (ref, id, ttl) => wrapped.lease(ref, id, ttl),
      releaseLease: (ref, id) => wrapped.releaseLease(ref, id),
      listComputers: () => wrapped.listComputers(),
    };
  };

  return {
    factory,
    destroyed,
    failNextDestroys: (times: number) => {
      destroyFails = times;
    },
  };
}

async function addAccount(ownerUserId: string | null, provider: string, managed: boolean) {
  const id = newId();
  await db.insert(computerAccount).values({
    id,
    ownerUserId,
    provider,
    label: `${provider}-${managed ? "managed" : "own"}`,
    encryptedCredential: encryptSecret("test-key"),
    status: "active",
    capacity: 5,
    managed,
  });
  return id;
}

afterAll(async () => {
  await closeDatabase();
});

describe("the one-account-per-provider rule is enforced by the database", () => {
  it("rejects a second account for the same provider and allows a different one", async () => {
    const space = await workspaceFor("one-per-provider");

    await addAccount(space.ownerId, "instabox", false);

    // A second Instabox row for this workspace must fail at the index. Drizzle
    // wraps driver errors, so the SQLSTATE lives on `cause`; assert on the cause
    // rather than on the wrapper, which is what a caller's unwrapping has to do.
    const duplicate = await addAccount(space.ownerId, "instabox", false).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).not.toBeNull();
    const cause = (duplicate as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint).toBe("computer_account_owner_provider_idx");

    // A different provider is fine: several providers is the whole point.
    await expect(addAccount(space.ownerId, "boat", false)).resolves.toBeTruthy();

    const rows = await db
      .select({ provider: computerAccount.provider })
      .from(computerAccount)
      .where(eq(computerAccount.ownerUserId, space.ownerId));
    expect(rows.map((row) => row.provider).sort()).toEqual(["boat", "instabox"]);
  });

  it("allows one managed pool per provider, and no second", async () => {
    /*
     * Hermetic: this creates the pool it then tries to duplicate. Relying on a
     * seeded managed row made the assertion depend on which seed CI ran, and a
     * deployment with no pool yet passed the "duplicate" case for the wrong
     * reason — nothing to collide with.
     */
    const existing = await db
      .select({ provider: computerAccount.provider })
      .from(computerAccount)
      .where(eq(computerAccount.managed, true));
    const taken = new Set(existing.map((row) => row.provider));
    const provider = (["instabox", "agent37", "boat"] as const).find((name) => !taken.has(name));
    if (!provider) return; // Every provider already has a pool; nothing to add here.

    await expect(addAccount(null, provider, true)).resolves.toBeTruthy();
    const duplicate = await addAccount(null, provider, true).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicate).not.toBeNull();
    expect((duplicate as { cause?: { code?: string } }).cause?.code).toBe("23505");
    expect((duplicate as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      "computer_account_managed_provider_idx",
    );

    // A user's own account of that same provider is still allowed: the
    // owner-scoped index skips managed rows, so the two do not collide.
    const space = await workspaceFor("managed-and-own");
    await expect(addAccount(space.ownerId, provider, false)).resolves.toBeTruthy();
  });
});

describe("allocation against the real schema", () => {
  it("provisions one box, records the bot's workspace on it, and never gives a second", async () => {
    const space = await workspaceFor("alloc-once");
    const botId = await makeBot(space.id, "Once");
    await addAccount(space.ownerId, "instabox", false);
    const spy = spyProviders();
    const runtime = createComputerRuntime({
      store: new DrizzleComputerStore(),
      providers: spy.factory,
    });

    const first = await runtime.runComputer(botId, async () => "ok");
    expect(first.ok).toBe(true);

    const boxes = await db
      .select()
      .from(computer)
      .where(and(eq(computer.workspaceId, space.id), eq(computer.status, "awake")));
    expect(boxes).toHaveLength(1);

    // A second use reuses that box: still exactly one.
    const second = await runtime.runComputer(botId, async () => "ok");
    expect(second.ok).toBe(true);
    const after = await db
      .select()
      .from(computer)
      .where(and(eq(computer.workspaceId, space.id), eq(computer.status, "awake")));
    expect(after).toHaveLength(1);
  });

  it("destroys the box at the provider when the bot is deleted", async () => {
    const space = await workspaceFor("destroy-on-delete");
    const botId = await makeBot(space.id, "Doomed");
    await addAccount(space.ownerId, "instabox", false);
    const spy = spyProviders();
    const runtime = createComputerRuntime({
      store: new DrizzleComputerStore(),
      providers: spy.factory,
    });
    await runtime.runComputer(botId, async () => "ok");

    await runtime.allocator.destroyForBot(botId);

    expect(spy.destroyed).toHaveLength(1);
    const orphans = await db.select().from(computerOrphan).where(eq(computerOrphan.botId, botId));
    expect(orphans).toHaveLength(0);
  });

  it("records the orphan in Postgres when the provider will not destroy the box", async () => {
    const space = await workspaceFor("orphan-row");
    const botId = await makeBot(space.id, "Leaky");
    // Only the account's existence matters here; the box records which one it used.
    await addAccount(space.ownerId, "instabox", false);
    const spy = spyProviders();
    const runtime = createComputerRuntime({
      store: new DrizzleComputerStore(),
      providers: spy.factory,
    });
    await runtime.runComputer(botId, async () => "ok");
    const [box] = await db.select().from(computer).where(eq(computer.workspaceId, space.id));
    spy.failNextDestroys(1);

    await runtime.allocator.destroyForBot(botId);

    // The bot row is gone from the allocator's point of view, and the box that is
    // still running at the provider is recorded with everything a later reap needs.
    const orphans = await db.select().from(computerOrphan).where(eq(computerOrphan.externalId, box!.externalId!));
    expect(orphans).toHaveLength(1);
    // The account the box was made on is recorded, so a later reap knows which
    // credential to use — `accountId` here is whatever the allocator picked.
    expect(orphans[0]).toMatchObject({
      provider: "fake",
      accountId: box!.accountId,
      reason: "bot-delete",
      externalId: box!.externalId,
    });

    // Which account the allocator picked is its business — a managed pool ranks
    // above a workspace's own key by design, and this database may hold the
    // seeded dev pool. What matters is that the orphan names the account the box
    // was actually made on, because that is the credential a reap needs.
    expect(orphans[0]?.accountId).toBe(box!.accountId);
    expect(orphans[0]?.lastError).toContain("unavailable");

    // And the reap clears it once the provider answers.
    const reaped = await runtime.allocator.reapOrphans();
    expect(reaped.reaped).toBe(1);
    expect(
      await db.select().from(computerOrphan).where(eq(computerOrphan.externalId, box!.externalId!)),
    ).toHaveLength(0);
  });

  it("never spends another user's account", async () => {
    const mine = await workspaceFor("scope-mine");
    const theirs = await workspaceFor("scope-theirs");
    const botId = await makeBot(mine.id, "Mine");
    const theirAccount = await addAccount(theirs.ownerId, "instabox", false);
    const spy = spyProviders();
    const runtime = createComputerRuntime({
      store: new DrizzleComputerStore(),
      providers: spy.factory,
    });

    /*
     * Asserted on the pool the allocator actually sees, not on the outcome: this
     * shared test database also holds the seeded dev pool, so a run here can
     * legitimately succeed on a managed account. What must never happen is this
     * workspace's bot being offered another workspace's key.
     */
    const ownerUserId = await runtime.allocator.store.botOwnerUserId(botId);
    expect(ownerUserId).toBe(mine.ownerId);
    const reachable = eligibleAccounts(await runtime.allocator.store.listAccounts(), ownerUserId);
    expect(reachable.map((account) => account.id)).not.toContain(theirAccount);

    await runtime.runComputer(botId, async () => "ok");

    // Whatever it used, any box it built belongs to this workspace.
    const boxes = await db.select().from(computer).where(eq(computer.workspaceId, mine.id));
    for (const box of boxes) expect(box.accountId).not.toBe(theirAccount);
  });
});

void ComputerAllocator;

describe("removing an account destroys its boxes first", () => {
  it("reports what is outstanding rather than orphaning a box it cannot reach", async () => {
    const space = await workspaceFor("account-remove");
    const botId = await makeBot(space.id, "Owned");
    const accountId = await addAccount(space.ownerId, "instabox", false);
    const spy = spyProviders();
    const runtime = createComputerRuntime({
      store: new DrizzleComputerStore(),
      providers: spy.factory,
    });
    /*
     * The box is created directly on the account under test, not by allocating:
     * which account the allocator prefers is its own rule, and this shared test
     * database holds a seeded dev pool that ranks above a workspace's key. These
     * tests are about removal, so the box's account is a given.
     */
    const boxId = newId();
    await db.insert(computer).values({
      id: boxId,
      accountId,
      workspaceId: space.id,
      provider: "fake",
      externalId: `box-${boxId}`,
      status: "awake",
      metadata: { botId },
    });
    await runtime.allocator.store.bindComputer(botId, {
      id: boxId,
      accountId,
      workspaceId: space.id,
      provider: "fake",
      externalId: `box-${boxId}`,
      status: "awake",
      metadata: { botId },
      lastUsedAt: null,
      lastError: null,
      lastErrorCode: null,
      createdAt: new Date().toISOString(),
    });
    // Warm the provider cache so the destroy below goes through the spy.
    spy.factory({ id: accountId } as AccountRecord);

    // The provider refuses: the account's credential is still needed to retry.
    spy.failNextDestroys(1);
    const refused = await runtime.allocator.destroyForAccount(accountId);
    expect(refused.outstanding).toBe(1);

    // Once the provider answers, the account's last box goes and nothing is owed.
    const done = await runtime.allocator.destroyForAccount(accountId);
    expect(done.outstanding).toBe(0);
    const stillOwed = await db.select().from(computerOrphan).where(eq(computerOrphan.accountId, accountId));
    expect(stillOwed).toHaveLength(0);
  });

  it("keeps the credential when its owner is deleted, so the box can still be reaped", async () => {
    const space = await workspaceFor("keep-credential");
    const botId = await makeBot(space.id, "Left");
    const accountId = await addAccount(space.ownerId, "instabox", false);
    const boxId = newId();
    await db.insert(computer).values({
      id: boxId,
      accountId,
      workspaceId: space.id,
      provider: "fake",
      externalId: `box-${boxId}`,
      status: "awake",
      metadata: { botId },
    });

    /*
     * Deleting the owner is what removed the credential before this was fixed:
     * the cascade took the account row with the user, and the box kept running
     * at the provider with nothing left that could authenticate a destroy. This
     * test fails if that foreign key ever goes back to `cascade`.
     */
    await db.delete(user).where(eq(user.id, space.ownerId));

    const account = await db.select().from(computerAccount).where(eq(computerAccount.id, accountId));
    expect(account).toHaveLength(1);
    expect(account[0]?.ownerUserId).toBeNull();
    expect(account[0]?.encryptedCredential).toBeTruthy();

    // And the box is still reachable through the account, which is the point of
    // keeping the row: the credential is what destroys it.
    const box = await db.select().from(computer).where(eq(computer.accountId, accountId));
    expect(box.length).toBeGreaterThan(0);
    expect(box[0]?.accountId).toBe(accountId);
  });
});

describe("a bot never gets a second box, even from two processes", () => {
  it("provisions exactly one box when two separate allocators race for the same bot", async () => {
    const space = await workspaceFor("race-one-bot");
    const botId = await makeBot(space.id, "Racy");
    await addAccount(space.ownerId, "instabox", false);

    /*
     * Two *instances*, not two calls on one. `allocateForBot` holds a per-bot lock
     * inside a single allocator, so one instance would prove nothing about two
     * processes — the web app and the worker, or two serverless instances, each
     * build their own. The only thing shared here is Postgres, which is exactly
     * what makes the unique index the real guarantee rather than the lock.
     *
     * The barrier is what makes this a race at all. Without it the two calls
     * serialise by accident — the first finishes binding before the second reads
     * its binding — and the test passes just as happily with the unique index
     * weakened, which is no test. Both provisions must be in flight before either
     * binds, so both reach `tryBindComputer` holding a box.
     */
    let provisions = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const countingProviders = () => {
      const fakes = new Map<string, FakeComputerProvider>();
      return (account: AccountRecord): ComputerProvider => {
        let fake = fakes.get(account.id);
        if (!fake) {
          fake = new FakeComputerProvider({ account: account.id });
          fakes.set(account.id, fake);
        }
        const wrapped = fake;
        return {
          name: wrapped.name,
          account: wrapped.account,
          async provision(options) {
            provisions += 1;
            const made = await wrapped.provision(options);
            // Hold every provision until both callers have one.
            if (provisions === 2) releaseBarrier?.();
            await barrier;
            return made;
          },
          start: (ref, options) => wrapped.start(ref, options),
          sleep: (ref) => wrapped.sleep(ref),
          destroy: (ref) => wrapped.destroy(ref),
          exec: (ref, command, options) => wrapped.exec(ref, command, options),
          putFile: (ref, path, data) => wrapped.putFile(ref, path, data),
          getFile: (ref, path) => wrapped.getFile(ref, path),
          list: (ref, path) => wrapped.list(ref, path),
          screenshot: (ref) => wrapped.screenshot(ref),
          status: (ref) => wrapped.status(ref),
          lease: (ref, id, ttl) => wrapped.lease(ref, id, ttl),
          releaseLease: (ref, id) => wrapped.releaseLease(ref, id),
          listComputers: () => wrapped.listComputers(),
        };
      };
    };

    const a = new ComputerAllocator({ store: new DrizzleComputerStore(), providers: countingProviders() });
    const b = new ComputerAllocator({ store: new DrizzleComputerStore(), providers: countingProviders() });

    // A deadlock here is the failure mode to notice, not to hang on: the barrier
    // opens as soon as two provisions exist, so a timeout means only one happened.
    const [first, second] = await Promise.all([a.allocateForBot(botId), b.allocateForBot(botId)]);

    expect(provisions).toBe(2);
    expect([first.state, second.state]).toEqual(["ready", "ready"]);
    // Both callers end up on the same box...
    expect(first.computerId).toBe(second.computerId);

    const live = await db
      .select()
      .from(computer)
      .where(and(eq(computer.workspaceId, space.id), ne(computer.status, "deleted")));
    // ...and only one box survives, because the loser's bind lost and it destroyed
    // what it made. This is the assertion the unique index carries.
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(first.computerId);

    // The loser's box is destroyed, not left to bill.
    const all = await db.select().from(computer).where(eq(computer.workspaceId, space.id));
    const deleted = all.filter((row) => row.status === "deleted");
    expect(all.length - deleted.length).toBe(1);
    expect(deleted).toHaveLength(1);
  });
});

/*
 * The same atomicity, against the real provider rather than a fake.
 *
 * The Postgres test above proves the lock and the unique index; this proves the
 * thing a person actually experiences: two first uses arriving together spend one
 * real box, and the provider itself ends up holding exactly one machine. A fake
 * that counts calls cannot show that — only Instabox's own list can.
 *
 * Opt in with INSTABOX_LIVE=1. It spends one real box, destroyed afterwards.
 */
describe.skipIf(process.env.INSTABOX_LIVE !== "1")("the real provider spends one box per bot", () => {
  it("creates exactly one machine when two allocators race for the same bot", async () => {
    const space = await workspaceFor("race-live");
    const botId = await makeBot(space.id, "Live racy");
    const accountId = await addAccount(space.ownerId, "instabox", false);

    // The row holds the deployment key, encrypted, exactly as the app stores it.
    await db
      .update(computerAccount)
      .set({ encryptedCredential: encryptSecret(process.env.INSTABOX_API_KEY ?? "") })
      .where(eq(computerAccount.id, accountId));

    const providers = createProviderFactory();
    const account = (await new DrizzleComputerStore().listAccounts()).find((entry) => entry.id === accountId)!;
    const provider = providers(account);
    const a = new ComputerAllocator({ store: new DrizzleComputerStore(), providers });
    const b = new ComputerAllocator({ store: new DrizzleComputerStore(), providers });

    // What is here before the race, so cleanup only touches boxes it made.
    const before = (await provider.listComputers()).map((entry) => entry.id);

    try {
      const [first, second] = await Promise.all([a.allocateForBot(botId), b.allocateForBot(botId)]);

      expect([first.state, second.state]).toEqual(["ready", "ready"]);
      expect(first.computerId).toBe(second.computerId);

      // One row, and one machine at the provider.
      const live = await db
        .select()
        .from(computer)
        .where(and(eq(computer.workspaceId, space.id), ne(computer.status, "deleted")));
      expect(live).toHaveLength(1);

      /*
       * The box must be on *this* account. The allocator is allowed to fall
       * through to another provider when one refuses — that is the behaviour
       * `failures.test.ts` covers — but then this test would be asserting
       * against a box that does not exist here and failing with a bare "0
       * boxes". Naming the account makes that case say what happened instead.
       */
      expect(live[0]?.accountId).toBe(accountId);

      const listed = await provider.listComputers();
      const ids = listed.map((entry) => entry.id);
      console.log(`  boxes at the provider: ${ids.join(", ") || "(none)"}`);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toBe(live[0]?.externalId);
    } finally {
      // Destroy whatever it made, whatever the assertions did.
      await a.destroyForBot(botId).catch(() => undefined);
      const remaining = (await provider.listComputers().catch(() => [])).filter(
        (entry) => !before.includes(entry.id),
      );
      for (const box of remaining) {
        await provider.destroy(box).catch(() => undefined);
      }
    }
  }, 600_000);
});
