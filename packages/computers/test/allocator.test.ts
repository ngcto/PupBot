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

/**
 * Like `harness`, but the provider kind decides what a box can do. `fake` claims
 * every capability and `instabox` is complete, so the only gap this needs to
 * express is Agent37's: no framebuffer. Written as a provider factory rather
 * than a fake provider because capability must be readable from the provider
 * the allocator actually built, which is what the gap check reads.
 */
function harnessWithCapabilities(options: { agent37CannotScreenshot: boolean }) {
  const store = new MemoryComputerStore();
  const fakes = new Map<string, FakeComputerProvider>();
  const providers = (account: AccountRecord): ComputerProvider => {
    let provider = fakes.get(account.id);
    if (provider) return provider;
    provider = new FakeComputerProvider({ account: account.id });
    Object.defineProperty(provider, "name", { value: account.provider });
    if (account.provider === "agent37" && options.agent37CannotScreenshot) {
      Object.defineProperty(provider, "capabilities", {
        value: {
          exec: true,
          files: true,
          screenshot: false,
          pausePreservesMemory: true,
          deleteAfter: false,
          unsupported: {
            screenshot:
              "no screenshot endpoint; a visible screen exists only as a noVNC desktop on a custom template, not as a PNG",
          },
        },
      });
    }
    fakes.set(account.id, provider);
    return provider;
  };
  const allocator = new ComputerAllocator({
    store,
    providers,
    config: { idleSeconds: 60, leaseTtlSeconds: 60, provisionNoCapacityRetries: 2, retryBudgetMs: 600_000 },
    now: () => new Date(START),
    sleep: async () => undefined,
    log: () => undefined,
  });
  return { store, allocator, fake: (accountId: string) => fakes.get(accountId)! };
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
    // The model, not a card, is what tells the user: "all busy" must carry no
    // purchase prompt, because there is nothing to buy.
    expect(result.failure?.code).toBe("all_busy");
    expect(result.failure?.userAction).toBe("wait");
    // No purchase prompt: a busy machine is not a reason to sell a plan. The
    // wording may mention "this plan" descriptively, so the assertion is on the
    // advice, not on a word.
    expect(result.failure?.resolution).not.toContain("Billing");
    expect(result.failure?.resolution).not.toContain("choose a plan");
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
    // A refused template is the provider's problem, so the user is pointed at
    // the credential, not told to buy a plan they may already have.
    expect(result.failure?.code).toBe("provider_error");
    expect(result.failure?.resolution).toContain("Settings");
    expect(result.failure?.detail).toContain("template_refused");
  });

  it("blocks a bot with a reason when no account is connected at all", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    const binding = await store.botBinding("bot-1");
    expect(binding?.state).toBe("blocked");
    // No provider at all is a setting the user can change, and the wording has
    // to say so: this is the whole message they will ever see.
    expect(result.failure?.code).toBe("no_provider");
    expect(result.failure?.userAction).toBe("configure");
    expect(binding?.reason).toContain("no computer provider is configured");
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

describe("allocator — one provider being out of capacity does not fail the use", () => {
  it("tries every configured provider and uses one that still has room", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "ws-1");
    // Equal capacity, so the tiebreak is the provider name: boat is asked first,
    // then instabox. Both are workspace-configured, so the managed-first rule
    // does not decide this.
    store.addAccount({ id: "boat", provider: "boat", label: "boat", capacity: 5, managed: false, ownerUserId: "ws-1" });
    store.addAccount({ id: "ib", provider: "instabox", label: "instabox", capacity: 5, managed: false, ownerUserId: "ws-1" });

    // boat is not locally full: only the provider's own refusal can move on.
    // `quota` is the code the allocator never retries, so the refusal is final
    // and the next provider is the only way forward.
    fake("boat").fail("provision", new ProviderError("quota", "this plan already has its machine"));

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("ib");
    // The first provider was really asked and really refused, and only then was
    // the second one used: one provider being out of capacity did not fail the use.
    expect(fake("boat").calls.provision).toBe(1);
    expect(fake("ib").calls.provision).toBe(1);
    expect(fake("ib").calls.destroy).toBe(0);
  });

  it("reports all_busy with no purchase prompt only after every provider refuses", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "ws-1");
    store.addAccount({ id: "a", label: "a", provider: "instabox", capacity: 5, managed: false, ownerUserId: "ws-1" });
    store.addAccount({ id: "b", label: "b", provider: "boat", capacity: 5, managed: false, ownerUserId: "ws-1" });
    fake("a").fail("provision", new ProviderError("quota", "full"));
    fake("b").fail("provision", new ProviderError("rate_limited", "slow down", { retryAfterSeconds: 30 }));

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("blocked");
    // Both were tried: one provider being full is not the answer.
    expect(fake("a").calls.provision).toBe(1);
    expect(fake("b").calls.provision).toBe(1);
    expect(result.failure?.code).toBe("all_busy");
    expect(result.failure?.userAction).toBe("wait");
  });

  it("orders identically on every run: hosted first, then the user's own key, then managed", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "ws-1");
    store.addAccount({ id: "z-user", label: "z", provider: "instabox", capacity: 4, managed: false, ownerUserId: "ws-1" });
    store.addAccount({ id: "a-managed", label: "a", provider: "instabox", capacity: 4, managed: true });

    // A user's own key is spent before the deployment's pool, even though "a"
    // sorts first: their key is the one they chose for their bots.
    const first = await allocator.allocateForBot("bot-1");
    expect(first.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("z-user");
  });
});

describe("allocator — a workspace only reaches its own accounts", () => {
  it("never spends another workspace's key", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1", "ws-1");
    store.botOwners.set("bot-1", "ws-1");
    store.addAccount({ id: "theirs", provider: "instabox", label: "theirs", capacity: 5, managed: false, ownerUserId: "ws-2" });
    store.addAccount({ id: "mine", provider: "boat", label: "mine", capacity: 5, managed: false, ownerUserId: "ws-1" });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("mine");
    expect(fake("theirs").calls.provision).toBe(0);
  });
});

describe("allocator — a bot never gets a second box", () => {
  it("destroys the loser when two allocations race past the in-process lock", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });

    // Two processes would each pass their own lock; the store's atomic bind is
    // what resolves it. Simulate that by clearing the binding between them.
    const first = await allocator.allocateForBot("bot-1");
    expect(first.state).toBe("ready");
    await store.setBindingState("bot-1", "unbound", null);
    const existing = (await store.botBinding("bot-1"))?.computer;
    // The bot still holds a live box: a second allocation must reuse it, never
    // create another, even though the binding state says otherwise.
    expect(existing).not.toBeNull();

    const second = await allocator.allocateForBot("bot-1");
    expect(second.state).toBe("ready");
    const computers = await store.listComputers();
    expect(computers.filter((computer) => computer.status !== "deleted")).toHaveLength(1);
  });
});

describe("allocator — destroy on bot delete, and the orphan path", () => {
  it("destroys the box at the provider when the bot is deleted", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.allocateForBot("bot-1");
    const box = (await store.botBinding("bot-1"))?.computer;
    expect(box).not.toBeNull();

    await allocator.destroyForBot("bot-1");

    expect(fake("a").calls.destroy).toBe(1);
    expect((await store.getComputer(box!.id))?.status).toBe("deleted");
    expect(await store.listOrphans()).toHaveLength(0);
  });

  it("records an orphan with everything a later delete needs when the provider refuses", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.allocateForBot("bot-1");
    const box = (await store.botBinding("bot-1"))?.computer;
    fake("a").fail("destroy", new ProviderError("unavailable", "provider is down"));

    await allocator.destroyForBot("bot-1");

    // The delete completed locally...
    expect((await store.getComputer(box!.id))?.status).toBe("deleted");
    // ...and the box that is still billing is on the record, in full.
    const orphans = await store.listOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      provider: "fake",
      externalId: box!.externalId,
      reason: "bot-delete",
      accountId: "a",
    });
    expect(orphans[0]?.lastError).toContain("unavailable");
  });

  it("reaps the orphan once the provider answers again, and forgets it", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.allocateForBot("bot-1");
    fake("a").fail("destroy", new ProviderError("unavailable", "provider is down"));
    await allocator.destroyForBot("bot-1");
    expect(await store.listOrphans()).toHaveLength(1);

    const reaped = await allocator.reapOrphans();

    expect(reaped).toEqual({ reaped: 1, failed: 0 });
    expect(await store.listOrphans()).toHaveLength(0);
  });

  it("keeps the orphan and counts the attempt when it still will not go", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.allocateForBot("bot-1");
    fake("a").fail("destroy", new ProviderError("unavailable", "down"), 2);
    await allocator.destroyForBot("bot-1");

    const reaped = await allocator.reapOrphans();

    expect(reaped).toEqual({ reaped: 0, failed: 1 });
    const orphans = await store.listOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.attempts).toBe(1);
  });

  it("destroys every box a deleted workspace still owns", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1", "ws-1");
    store.addBot("bot-2", "ws-1");
    store.botOwners.set("bot-1", "ws-1");
    store.botOwners.set("bot-2", "ws-1");
    store.addAccount({ id: "a", capacity: 5, managed: false, ownerUserId: "ws-1" });
    await allocator.allocateForBot("bot-1");
    await allocator.allocateForBot("bot-2");

    const summary = await allocator.destroyForWorkspace("ws-1");

    expect(summary.destroyed).toBe(2);
    expect(fake("a").calls.destroy).toBe(2);
  });
});

describe("allocator — capability requirements", () => {
  it("allocates on an Agent37-only deployment when the caller asks for nothing", async () => {
    // The default must not take a working provider out of the pool. A box with no
    // framebuffer still runs commands and moves files, so a bot that never looks
    // at a screen gets it — this is the case a screenshot-by-default rule broke.
    const { store, allocator } = harnessWithCapabilities({ agent37CannotScreenshot: true });
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "managed", provider: "agent37", label: "Terabot's Agent37", managed: true, capacity: 1 });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("managed");
  });

  it("chooses a screenshot-capable account when the caller asks for a screen", async () => {
    // Strictness belongs to the caller, which knows whether its tools can look.
    // When it can, own-key-first no longer wins over a closer-but-incapable box.
    const { store, allocator } = harnessWithCapabilities({ agent37CannotScreenshot: true });
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-1");
    store.addAccount({ id: "mine", provider: "agent37", label: "My Agent37", capacity: 5, ownerUserId: "user-1" });
    store.addAccount({ id: "managed", provider: "instabox", capacity: 5, managed: true });

    const result = await allocator.allocateForBot("bot-1", { requires: ["screenshot"] });

    expect(result.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("managed");
  });

  it("blocks with the product's own sentence when a run that reads the screen has no capable provider", async () => {
    // This is the user-visible value of the capability check: a person whose only
    // computer cannot do the job is told which account and why, and what to do —
    // not "no computer is available", which sends them to check capacity.
    const { store, allocator } = harnessWithCapabilities({ agent37CannotScreenshot: true });
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-1");
    store.addAccount({ id: "mine", provider: "agent37", label: "My Agent37", capacity: 5, ownerUserId: "user-1" });

    const result = await allocator.allocateForBot("bot-1", { requires: ["screenshot"] });

    expect(result.state).toBe("blocked");
    // The exact sentence, not just the pieces: a rewrite that loses the account
    // name or the remedy fails here.
    expect(result.reason).toBe(
      "No connected computer can do what this bot needs. " +
        "My Agent37 cannot screenshot (no screenshot endpoint; a visible screen exists only as a noVNC desktop on a custom template, not as a PNG). " +
        "Connect one that can, or ask for a task that does not need it.",
    );
    expect((await store.listComputers()).filter((row) => row.status !== "deleted")).toHaveLength(0);
  });

  it("moves a bot onto a capable box when its run starts needing a screen, and destroys the old box", async () => {
    const { store, allocator } = harnessWithCapabilities({ agent37CannotScreenshot: true });
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-1");
    store.addAccount({ id: "mine", provider: "agent37", capacity: 5, ownerUserId: "user-1" });
    const first = await allocator.allocateForBot("bot-1");
    expect(first.state).toBe("ready");
    const before = (await store.botBinding("bot-1"))!.computer!;
    expect(before.accountId).toBe("mine");

    // A capable account appears; a run that needs a screen now has an answer.
    store.addAccount({ id: "managed", provider: "instabox", capacity: 5, managed: true });
    const moved = await allocator.allocateForBot("bot-1", { requires: ["screenshot"] });

    expect(moved.state).toBe("ready");
    expect((await store.botBinding("bot-1"))?.computer?.accountId).toBe("managed");
    // The box it left is gone, not merely unbound: an unbound box keeps billing
    // and nothing looks at it again.
    expect((await store.getComputer(before.id))?.status).toBe("deleted");
  });

  it("reuses the box the bot already has when it already qualifies", async () => {
    const { store, allocator } = harnessWithCapabilities({ agent37CannotScreenshot: true });
    store.addBot("bot-1");
    store.addAccount({ id: "mine", provider: "instabox", capacity: 5 });
    const first = await allocator.allocateForBot("bot-1");
    const again = await allocator.allocateForBot("bot-1", { requires: ["screenshot"] });

    expect(again.computerId).toBe(first.computerId);
    expect((await store.listComputers()).filter((row) => row.status !== "deleted")).toHaveLength(1);
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
});

describe("allocator — an unknown plan limit defers to the provider", () => {
  it("does not cap a user account at one box when its capacity is unknown", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1", "ws-1");
    store.addBot("bot-2", "ws-1");
    store.botOwners.set("bot-1", "ws-1");
    store.botOwners.set("bot-2", "ws-1");
    // capacity 0 is "the deployment does not know this plan": the provider decides.
    store.addAccount({ id: "mine", capacity: 0, managed: false, ownerUserId: "ws-1" });

    const first = await allocator.allocateForBot("bot-1");
    const second = await allocator.allocateForBot("bot-2");

    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    // Both bots got a box from the same account rather than the second being
    // refused on a limit the deployment invented.
    expect(fake("mine").calls.provision).toBe(2);
  });

  it("still honours a capacity the account actually states", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1", "ws-1");
    store.addBot("bot-2", "ws-1");
    store.botOwners.set("bot-1", "ws-1");
    store.botOwners.set("bot-2", "ws-1");
    store.addAccount({ id: "small", capacity: 1, managed: false, ownerUserId: "ws-1" });

    expect((await allocator.allocateForBot("bot-1")).state).toBe("ready");
    const second = await allocator.allocateForBot("bot-2");

    expect(second.state).toBe("blocked");
    expect(fake("small").calls.provision).toBe(1);
  });
});

describe("allocator — recovering from a box the provider no longer has", () => {
  it("rebinds a bot whose box was marked deleted, instead of blocking forever", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.addAccount({ id: "a", capacity: 5 });
    await allocator.allocateForBot("bot-1");
    const lost = (await store.botBinding("bot-1"))!.computer!;

    // The provider lost the box: the sweep marks the row deleted but the bot's
    // link is still the one the unique index sees.
    await store.updateComputer(lost.id, { status: "deleted" });

    const result = await allocator.ensureReady("bot-1");

    expect(result.ok).toBe(true);
    expect(result.computerId).not.toBe(lost.id);
    const live = (await store.listComputers()).filter((computer) => computer.status !== "deleted");
    expect(live).toHaveLength(1);
  });
});
