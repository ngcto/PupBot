import { describe, expect, it } from "vitest";
import { InstaboxProvider, rowStatusFrom } from "../src/index.ts";
import type { ComputerRef } from "../src/index.ts";

const apiKey = process.env.INSTABOX_API_KEY ?? "";
const live = process.env.INSTABOX_LIVE === "1" && Boolean(apiKey);

/** Wall-clock for one phase, so the report can quote real timings. */
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const value = await work();
  console.log(`  ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return value;
}

/**
 * What the provider itself says about one box, read from its list rather than
 * from a status call on the box we happen to hold.
 *
 * This is the difference between "we asked it to sleep" and "Instabox has it
 * recorded as sleeping": the list is the provider's own inventory, so it also
 * proves the box exists exactly once and is gone from inventory after destroy.
 */
async function listedState(provider: InstaboxProvider, id: string): Promise<string> {
  const boxes = await provider.listComputers();
  const match = boxes.filter((entry) => entry.id === id);
  console.log(`  provider lists ${id}: ${match.map((entry) => entry.status.state).join(", ") || "absent"}`);
  expect(match).toHaveLength(1);
  return match[0]!.status.state;
}

/**
 * The whole lifecycle against the real provider, in one run: create a box, take
 * a lease on it, put it to sleep, wake it again, and destroy it.
 *
 * The destroy proof lives in `live-destroy.test.ts`, but destroy alone does not
 * answer the question this feature asks. Lazy provisioning means a box is created
 * on demand and *then slept* when idle, and a sleeping box has to come back with
 * its files intact — that round trip is what "idle sleep then wake on use" claims,
 * and only the provider can confirm it. A fake that reports `asleep` proves that
 * this code writes the word "asleep", nothing more.
 *
 * Opt in with INSTABOX_LIVE=1. It spends one real box per run, so it never runs on
 * the default `pnpm test`.
 */
describe.skipIf(!live)("instabox live lifecycle", () => {
  it("creates a box, leases it, sleeps it, wakes it with its files intact, and destroys it", async () => {
    const provider = new InstaboxProvider({ account: "instabox:live-lifecycle", apiKey });

    let ref: ComputerRef | undefined;
    try {
      ref = await timed("provision", () =>
        provider.provision({ metadata: { "terabot-test": "live-lifecycle" }, ttlSeconds: 3600 }),
      );
      const box = ref;
      console.log(`  created ${box.id}`);

      // Provision resolves only once the box accepts commands, so this is the
      // proof that a first use is immediately usable.
      const first = await timed("first exec", () => provider.exec(box, "echo provisioned"));
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("provisioned");
      // Exactly one box, and the provider calls it running.
      expect(await listedState(provider, box.id)).toBe("running");

      // A lease is what keeps a box from being swept mid-run; it has to be
      // accepted by the provider, not merely recorded locally.
      const lease = await timed("lease", () => provider.lease(box, "live-lease-1", 300));
      expect(lease).toBeTruthy();
      await provider.releaseLease(box, "live-lease-1");

      // Write a file before sleeping: it is the evidence that a wake restores the
      // machine rather than creating a new one.
      const marker = `terabot-${Date.now()}`;
      const wrote = await provider.exec(box, `printf '%s' '${marker}' > /tmp/terabot-marker.txt`);
      expect(wrote.exitCode).toBe(0);

      /*
       * The provider's vocabulary is `sleeping`; `asleep` is the database row's
       * word for it (`rowStatusFrom` maps sleeping and stopped onto asleep). The
       * live proof asserts the provider's own state, and separately that the row
       * mapping still says asleep for it.
       */
      const slept = await timed("sleep", () => provider.sleep(box));
      expect(slept.state).toBe("sleeping");
      expect(await listedState(provider, box.id)).toBe("sleeping");

      // The provider itself must report the paused state, not merely that we asked.
      const asleepStatus = await timed("status while asleep", () => provider.status(box));
      expect(asleepStatus.state).toBe("sleeping");
      expect(rowStatusFrom(asleepStatus.state)).toBe("asleep");
      // Nothing is usable until it wakes.
      expect(asleepStatus.ready).toBe(false);

      // Wake on use: `start` is the only wake path, and it resolves only once an
      // exec after it would work.
      const woken = await timed("wake", () => provider.start(box));
      expect(woken.state).toBe("running");
      expect(woken.ready).toBe(true);
      expect(await listedState(provider, box.id)).toBe("running");

      const after = await timed("exec after wake", () => provider.exec(box, "cat /tmp/terabot-marker.txt"));
      expect(after.exitCode).toBe(0);
      // Same machine, same disk: this is the whole claim of idle sleep.
      expect(after.stdout).toContain(marker);

      await timed("destroy", () => provider.destroy(box));
      const remaining = await provider.listComputers();
      expect(remaining.some((entry) => entry.id === box.id)).toBe(false);
      console.log(`  destroyed ${box.id}; provider now lists ${remaining.length} box(es)`);
    } finally {
      // Never leave a box billing, whatever the assertions did.
      if (ref) await provider.destroy(ref).catch(() => undefined);
    }
  }, 600_000);
});
