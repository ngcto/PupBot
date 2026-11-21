import { describe, expect, it } from "vitest";
import { ComputerAllocator, FakeComputerProvider, MemoryComputerStore, ProviderError } from "../src/index.ts";
import type { AccountRecord, AllocatorConfig, ComputerProvider } from "../src/index.ts";

const START = Date.parse("2026-11-21T00:00:00Z");

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
    config: { idleSeconds: 60, leaseTtlSeconds: 60, ...config },
    now: () => new Date(clock),
    sleep: async () => undefined,
    log: () => undefined,
  });

  return {
    store,
    allocator,
    fake: (accountId: string) => {
      let fake = fakes.get(accountId);
      if (!fake) {
        fake = new FakeComputerProvider({ account: accountId });
        fakes.set(accountId, fake);
      }
      return fake;
    },
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

/**
 * The order the allocator tries accounts in decides whose key gets spent and
 * whether a bot gets a real machine. These tests pin it: the user's own key
 * first, then the deployment's managed account, then an unowned row, and a box
 * the bot already lives on before any of them.
 */
describe("allocator — account ranking", () => {
  it("prefers the user's own account over the deployment's managed one", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-a");
    store.addAccount({ id: "managed", label: "A Terabot's Instabox", managed: true, capacity: 5 });
    store.addAccount({ id: "mine", label: "Z My Instabox", ownerUserId: "user-a", capacity: 5 });

    await allocator.allocateForBot("bot-1");

    expect(fake("mine").calls.provision).toBe(1);
    expect(fake("managed").calls.provision).toBe(0);
  });

  it("prefers a managed account over a leftover unowned row", async () => {
    // A seed writes an unowned `fake` account; a development deployment also has
    // a managed Instabox one. The stub must not win, whatever its label: it
    // lives in one process' memory and is not a computer.
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "stub", label: "A Stub pool", managed: false, ownerUserId: null, capacity: 5 });
    store.addAccount({ id: "managed", label: "Z Terabot's Instabox", managed: true, capacity: 1 });

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    const computer = (await store.botBinding("bot-1"))!.computer!;
    expect(computer.accountId).toBe("managed");
  });

  it("still uses an unowned row when it is the only thing there is", async () => {
    const { store, allocator } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "stub", label: "Stub pool", managed: false, ownerUserId: null, capacity: 5 });

    expect((await allocator.allocateForBot("bot-1")).state).toBe("ready");
  });

  it("tries every provider before failing, and managed is not special-cased", async () => {
    const { store, allocator, fake } = harness();
    store.addBot("bot-1");
    store.botOwners.set("bot-1", "user-new");
    store.addAccount({ id: "mine", label: "A My Instabox", ownerUserId: "user-new", capacity: 1 });
    store.addAccount({ id: "managed", label: "B Terabot's Agent37", managed: true, capacity: 1 });
    fake("mine").fail("provision", new ProviderError("quota", "full"), 99);

    const result = await allocator.allocateForBot("bot-1");

    expect(result.state).toBe("ready");
    const computer = (await store.botBinding("bot-1"))!.computer!;
    expect(computer.accountId).toBe("managed");
  });
});
