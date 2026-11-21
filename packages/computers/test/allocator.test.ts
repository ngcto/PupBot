import { describe, expect, it } from "vitest";
import {
  ComputerAllocator,
  FakeComputerProvider,
  MemoryComputerStore,
  ProviderError,
} from "../src/index.ts";
import type { AccountRecord, AllocatorConfig, ComputerProvider } from "../src/index.ts";

const START = Date.parse("2026-11-20T00:00:00Z");

function harness(config: Partial<AllocatorConfig> = {}) {
  const store = new MemoryComputerStore();
  const fakes = new Map<string, FakeComputerProvider>();
  let clock = START;

  const providers = (account: AccountRecord): ComputerProvider => {
    let fake = fakes.get(account.id);
    if (!fake) {
      fake = new FakeComputerProvider({ account: account.id });
      fakes.set(account.id, fake);
    }
    return fake;
  };

  const allocator = new ComputerAllocator({
    store,
    providers,
    config: { idleSeconds: 60, leaseTtlSeconds: 60, provisionNoCapacityRetries: 2, retryBudgetMs: 600_000, ...config },
    now: () => new Date(clock),
    sleep: async () => undefined,
    log: () => undefined,
  });

  return {
    store,
    allocator,
    fake: (accountId: string) => {
      const existing = fakes.get(accountId);
      if (existing) return existing;
      const fake = new FakeComputerProvider({ account: accountId });
      fakes.set(accountId, fake);
      return fake;
    },
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
    nowMs: () => clock,
  };
}

describe("allocator — picking an account", () => {
  it("skips an account that is at capacity and uses the next one", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", label: "a", capacity: 1 });
    store.addAccount({ id: "b", label: "b", capacity: 2 });
    store.addComputer({ accountId: "a", externalId: "a-box-1" });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("ready");
    expect(binding?.computer?.accountId).toBe("b");
    expect(fake("b").calls.provision).toBe(1);
    expect(fake("a").calls.provision).toBe(0);
  });

  it("prefers the account that already hosted the bot", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", label: "a", capacity: 5 });
    store.addAccount({ id: "b", label: "b", capacity: 5 });
    store.addComputer({
      accountId: "b",
      externalId: "b-old",
      status: "asleep",
      metadata: { botId: "bot-1" },
    });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("b");
  });

  it("retries no_capacity on the same account with backoff", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    fake("a").fail("provision", new ProviderError("no_capacity", "no room", { retryable: true, retryAfterSeconds: 5 }), 1);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect(fake("a").calls.provision).toBe(2);
  });

  it("gives up on no_capacity after the retry budget and tries the next account", async () => {
    const { store, allocator, fake } = harness({ provisionNoCapacityRetries: 2 });
    store.addBot("bot-1");
    store.addAccount({ id: "a", label: "a", capacity: 5 });
    store.addAccount({ id: "b", label: "b", capacity: 5 });
    fake("a").fail("provision", new ProviderError("no_capacity", "no room", { retryable: true, retryAfterSeconds: 5 }), 3);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect(fake("a").calls.provision).toBe(3);
    expect(fake("b").calls.provision).toBe(1);
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("b");
  });

  it("never loops a create after quota: one call, then the bot is blocked with a reason", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    fake("a").fail("provision", new ProviderError("quota", "sandbox limit reached (1 of 1)"), 5);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    expect(fake("a").calls.provision).toBe(1);
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("blocked");
    expect(binding?.reason).toContain("full");
  });

  it("parks an account when the provider rate-limits it and uses another", async () => {
    const { store, allocator, fake, nowMs } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", label: "a", capacity: 5 });
    store.addAccount({ id: "b", label: "b", capacity: 5 });
    fake("a").fail("provision", new ProviderError("rate_limited", "slow down", { retryAfterSeconds: 60 }));

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    const accountA = (await store.listAccounts()).find((account) => account.id === "a");
    expect(Date.parse(accountA?.parkedUntil ?? "")).toBe(nowMs() + 60_000);
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("b");
  });

  it("marks an account misconfigured on template_refused and does not retry it", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", label: "a", capacity: 5 });
    fake("a").fail("provision", new ProviderError("template_refused", "plan cannot use that template"));

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    expect(fake("a").calls.provision).toBe(1);
    const account = (await store.listAccounts()).find((entry) => entry.id === "a");
    expect(account?.status).toBe("error");
    expect((await store.botBinding("bot-1"))?.reason).toContain("plan");
  });

  it("blocks a bot with a reason when no account is connected at all", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("blocked");
    expect(binding?.reason).toBe("No computer account is connected.");
  });

  it("retries an allocation on the next use after a blocked attempt", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 1 });
    fake("a").fail("provision", new ProviderError("quota", "full"), 1);

    expect((await allocator.allocateForBot("bot-1")).state).toBe("blocked");
    const second = await allocator.ensureReady("bot-1");

    expect(second.ok).toBe(true);
    expect(fake("a").calls.provision).toBe(2);
  });
});

describe("allocator — wake, leases and sleep", () => {
  it("allocates on first use, then wakes only a sleeping box", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });

    const first = await allocator.ensureReady("bot-1");
    expect(first.ok).toBe(true);
    expect(first.woke).toBe(false);
    expect(first.leaseId).toBeTruthy();
    expect(fake("a").calls.start).toBe(0);

    const computer = (await store.botBinding("bot-1"))!.computer!;
    await fake("a").sleep({ provider: "fake", account: "a", id: computer.externalId });
    await store.updateComputer(computer.id, { status: "asleep" });
    fake("a").calls.start = 0;

    const second = await allocator.ensureReady("bot-1");
    expect(second.ok).toBe(true);
    expect(second.woke).toBe(true);
    expect(fake("a").calls.start).toBe(1);
    expect((await store.getComputer(computer.id))?.status).toBe("awake");
  });

  it("shares one start between concurrent wakes of the same box", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.ensureReady("bot-1");
    const computer = (await store.botBinding("bot-1"))!.computer!;
    await fake("a").sleep({ provider: "fake", account: "a", id: computer.externalId });
    await store.updateComputer(computer.id, { status: "asleep" });
    fake("a").calls.start = 0;

    const [a, b] = await Promise.all([allocator.ensureReady("bot-1"), allocator.ensureReady("bot-1")]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fake("a").calls.start).toBe(1);
  });

  it("sleeps a box once its last lease lapses and the idle window passes", async () => {
    const { store, allocator, fake, advance, nowMs } = harness({ idleSeconds: 60 });
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    const ready = await allocator.ensureReady("bot-1");
    const computer = (await store.botBinding("bot-1"))!.computer!;

    advance(30);
    expect((await allocator.sweepIdle()).slept).toBe(0);

    const lease = [...store.leases.values()].find((entry) => entry.id === ready.leaseId)!;
    lease.expiresAt = new Date(nowMs() - 1000).toISOString();
    advance(120);

    const summary = await allocator.sweepIdle();

    expect(summary.slept).toBe(1);
    expect((await store.getComputer(computer.id))?.status).toBe("asleep");
    expect(fake("a").calls.sleep).toBe(1);
  });

  it("keeps a box awake while a lease is live", async () => {
    const { store, allocator, advance } = harness({ idleSeconds: 60 });
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.ensureReady("bot-1");

    advance(600);
    const summary = await allocator.sweepIdle();

    expect(summary.slept).toBe(0);
    expect((await store.botBinding("bot-1"))?.computer?.status).toBe("awake");
  });

  it("renews a live lease that is about to lapse and drops a dead one", async () => {
    const { store, allocator, advance, nowMs } = harness({ leaseTtlSeconds: 60, leaseRenewLeadSeconds: 45 });
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    const ready = await allocator.ensureReady("bot-1");
    const lease = [...store.leases.values()].find((entry) => entry.id === ready.leaseId)!;

    lease.expiresAt = new Date(nowMs() + 5_000).toISOString();
    expect((await allocator.renewLeases()).renewed).toBe(1);
    expect(Date.parse((await store.listLeases())[0]!.expiresAt)).toBeGreaterThan(nowMs() + 5_000);

    advance(120);
    await store.putLease({ ...lease, expiresAt: new Date(nowMs() - 1_000).toISOString() });
    expect((await allocator.renewLeases()).released).toBe(1);
    expect(await store.listLeases()).toHaveLength(0);
  });

  it("replaces a box that never wakes instead of leaving the bot broken", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.ensureReady("bot-1");
    const old = (await store.botBinding("bot-1"))!.computer!;
    await fake("a").sleep({ provider: "fake", account: "a", id: old.externalId });
    await store.updateComputer(old.id, { status: "asleep" });
    fake("a").fail("start", new ProviderError("timeout", "did not wake"), 4);

    const result = await allocator.ensureReady("bot-1");

    expect(result.ok).toBe(true);
    const binding = await store.botBinding("bot-1");
    expect(binding?.computer?.id).not.toBe(old.id);
    expect(binding?.computer?.status).toBe("awake");
    expect((await store.getComputer(old.id))?.status).toBe("deleted");
  });

  it("fails a run without blocking the bot when the box is unreachable", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.ensureReady("bot-1");
    fake("a").fail("status", new ProviderError("unavailable", "host is not answering"));

    const result = await allocator.ensureReady("bot-1");

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("restarting");
    expect((await store.botBinding("bot-1"))?.state).toBe("ready");
  });
});

describe("allocator — reconcile", () => {
  it("adopts an orphan box whose bot still exists", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    const ref = await fake("a").provision({ metadata: { botId: "bot-1" } });

    const summary = await allocator.reconcile();

    expect(summary.adopted).toBe(1);
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("ready");
    expect(binding?.computer?.externalId).toBe(ref.id);
  });

  it("refuses to adopt a box past the account's capacity", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addBot("bot-2");
    store.addAccount({ id: "a", capacity: 1 });
    // Two boxes exist at the provider with live bots, but the account has room
    // for one row. Adopting both is how a full pool silently overfills.
    await fake("a").provision({ metadata: { botId: "bot-1" } });
    await fake("a").provision({ metadata: { botId: "bot-2" } });

    const summary = await allocator.reconcile();

    expect(summary.adopted).toBe(1);
    expect(summary.failed).toBe(1);
    const live = (await store.listComputers()).filter((row) => row.status !== "deleted");
    expect(live).toHaveLength(1);
  });

  it("destroys a stray box whose bot is gone", async () => {
    const { store, allocator, fake } = harness();
    store.addAccount({ id: "a", capacity: 5 });
    await fake("a").provision({ metadata: { botId: "deleted-bot" } });

    const summary = await allocator.reconcile();

    expect(summary.destroyed).toBe(1);
    expect(await fake("a").listComputers()).toHaveLength(0);
  });

  it("re-provisions a box the provider no longer has", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    const row = store.addComputer({ accountId: "a", externalId: "a-lost-box", status: "awake", metadata: { botId: "bot-1" } });
    await store.bindComputer("bot-1", row);
    // A live box the provider does report, so the listing is not empty: an empty
    // listing is treated as "the provider cannot tell me", not "everything died".
    await fake("a").provision({ metadata: { botId: "bot-1" } });

    const summary = await allocator.reconcile();

    expect(summary.reprovisioned).toBe(1);
    expect((await store.getComputer(row.id))?.status).toBe("deleted");
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("ready");
    expect(binding?.computer?.externalId).not.toBe("a-lost-box");
    // The live box was adopted and a replacement provisioned for the lost one.
    expect((await fake("a").listComputers()).length).toBe(2);
  });

  it("does not destroy a box the database already tracks", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    const ready = await allocator.ensureReady("bot-1");
    expect(ready.ok).toBe(true);

    const summary = await allocator.reconcile();

    expect(summary.adopted).toBe(0);
    expect(summary.destroyed).toBe(0);
    expect((await fake("a").listComputers()).length).toBe(1);
  });
});

describe("allocator — capacity, account health and wake auth", () => {
  it("provisions once when two bots allocate at the same moment on a capacity-1 account", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addBot("bot-2");
    store.addAccount({ id: "a", label: "a", capacity: 1 });

    const [one, two] = await Promise.all([allocator.allocateForBot("bot-1"), allocator.allocateForBot("bot-2")]);

    expect([one.state, two.state].sort()).toEqual(["blocked", "ready"]);
    expect(fake("a").calls.provision).toBe(1);
  });

  it("restores a drained account once the provider answers again", async () => {
    const { store, allocator } = harness();
    store.addAccount({ id: "a", label: "a", capacity: 5, status: "error" });

    const summary = await allocator.reconcile();

    expect(summary.accounts).toBe(1);
    expect((await store.listAccounts()).find((account) => account.id === "a")?.status).toBe("active");
  });

  it("drains the account when a wake is rejected for bad credentials", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.ensureReady("bot-1");
    const computer = (await store.botBinding("bot-1"))!.computer!;
    await fake("a").sleep({ provider: "fake", account: "a", id: computer.externalId });
    await store.updateComputer(computer.id, { status: "asleep" });
    fake("a").fail("start", new ProviderError("auth", "key revoked"));

    const result = await allocator.ensureReady("bot-1");

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect((await store.listAccounts()).find((account) => account.id === "a")?.status).toBe("error");
  });
});

describe("allocator — managed and user-supplied accounts", () => {
  it("gives a bot with no plan a managed computer with no configuration", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "managed", label: "Terabot's Instabox", managed: true, capacity: 1 });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.state).toBe("ready");
  });

  it("prefers the user's own account over a managed one for their own bot", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-a");
    store.addAccount({ id: "managed", label: "Terabot's Instabox", managed: true, capacity: 5 });
    store.addAccount({ id: "mine", label: "My Instabox", ownerUserId: "user-a", capacity: 5 });

    await allocator.allocateForBot("bot-1");

    expect(fake("mine").calls.provision).toBe(1);
    expect(fake("managed").calls.provision).toBe(0);
  });

  it("falls back to managed capacity when the user's own account is full", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-a");
    store.addAccount({ id: "mine", label: "My Instabox", ownerUserId: "user-a", capacity: 1 });
    store.addAccount({ id: "managed", label: "Terabot's Instabox", managed: true, capacity: 1 });
    // Their own single box is already taken by another of their bots.
    store.addBot("bot-2");
    store.botOwners.set("bot-2", "user-a");
    store.addComputer({ accountId: "mine", externalId: "mine-box-1", metadata: { botId: "bot-2" } });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect(fake("managed").calls.provision).toBe(1);
  });

  it("does not hand one user's account to another user's bot", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-a");
    store.addAccount({ id: "theirs", label: "Their Instabox", ownerUserId: "user-b", capacity: 5 });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    expect(fake("theirs").calls.provision).toBe(0);
    expect((await store.botBinding("bot-1"))?.reason).toContain("no managed capacity");
  });

  it("says no managed computer is available rather than spinning when capacity is gone", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "managed", label: "Terabot's Instabox", managed: true, capacity: 1 });
    fake("managed").fail("provision", new ProviderError("no_capacity", "no host has room"), 99);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    expect(result.reason).toBe("No managed computer is available right now.");
    // Blocked, not stuck: the binding carries the sentence the composer shows.
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("blocked");
    expect(binding?.reason).toBe("No managed computer is available right now.");
  });

  it("tries every provider before failing, so one out of capacity does not end it", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    // Labels decide the order between two otherwise equal managed accounts, so
    // name them to put Instabox first: it is the one that is out of capacity.
    store.addAccount({ id: "ibx", label: "A Instabox", managed: true, capacity: 1 });
    store.addAccount({ id: "a37", label: "B Agent37", managed: true, capacity: 1 });
    fake("ibx").fail("provision", new ProviderError("quota", "full"), 99);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect(fake("ibx").calls.provision).toBe(1);
    expect(fake("a37").calls.provision).toBe(1);
  });

  it("reports every account being full by name, not as a single provider's failure", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "ibx", label: "A Instabox", managed: true, capacity: 1 });
    store.addAccount({ id: "a37", label: "B Agent37", managed: true, capacity: 1 });
    fake("ibx").fail("provision", new ProviderError("quota", "full"), 99);
    fake("a37").fail("provision", new ProviderError("quota", "full"), 99);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    expect(result.reason).toBe("Every computer account is full right now.");
    expect(fake("ibx").calls.provision).toBe(1);
    expect(fake("a37").calls.provision).toBe(1);
  });
});
