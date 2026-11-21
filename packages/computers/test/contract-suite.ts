import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../src/index.ts";
import type { ComputerProvider, ComputerRef } from "../src/index.ts";

/**
 * The behaviour every provider must have, run against the fake in CI and
 * against Instabox with INSTABOX_LIVE=1. It is the spike's selftest, turned
 * into the obligations the contract states.
 */
export function contractSuite(label: string, make: () => Promise<ComputerProvider>): void {
  describe(`${label} contract`, () => {
    let provider: ComputerProvider;
    let ref: ComputerRef;

    beforeAll(async () => {
      provider = await make();
      ref = await provider.provision({ metadata: { "pupbot-test": "contract" } });
    }, 300_000);

    afterAll(async () => {
      if (provider && ref) await provider.destroy(ref).catch(() => undefined);
    }, 120_000);

    it("provision resolves only once the computer is usable", async () => {
      const status = await provider.status(ref);
      expect(status.state).toBe("running");
      expect(status.ready).toBe(true);
      expect(status.raw).toBeTruthy();
    });

    it("start is idempotent and cheap on a running computer", async () => {
      const first = await provider.start(ref);
      const second = await provider.start(ref);
      expect(first.ready).toBe(true);
      expect(second.ready).toBe(true);
    });

    it("exec runs a command", async () => {
      const result = await provider.exec(ref, "echo pupbot-contract");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pupbot-contract");
      expect(result.timedOut).toBe(false);
    });

    it("returns a non-zero exit as a result, not an exception", async () => {
      const result = await provider.exec(ref, "exit 7");
      expect(result.exitCode).toBe(7);
      expect(result.timedOut).toBe(false);
    });

    it("moves bytes in and out and lists a directory", async () => {
      const path = "/data/home/pupbot-contract.txt";
      await provider.putFile(ref, path, "hello from the contract test");
      const bytes = await provider.getFile(ref, path);
      expect(new TextDecoder().decode(bytes)).toBe("hello from the contract test");

      const entries = await provider.list(ref, "/data/home");
      expect(entries.some((entry) => entry.name === "pupbot-contract.txt")).toBe(true);
    });

    it("takes a screenshot of the desktop", async () => {
      const shot = await provider.screenshot(ref);
      expect(shot.png.byteLength).toBeGreaterThan(0);
      expect(Date.parse(shot.takenAt)).toBeGreaterThan(0);
    });

    it("leases and releases activity, keeping the computer awake", async () => {
      const lease = await provider.lease(ref, "pupbot-contract-lease", 60);
      expect(lease.id).toBe("pupbot-contract-lease");
      expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
      await provider.releaseLease(ref, "pupbot-contract-lease");
      // Releasing an already absent lease is a no-op.
      await provider.releaseLease(ref, "pupbot-contract-lease");
    });

    it("lists the computers the account owns", async () => {
      const boxes = await provider.listComputers();
      expect(boxes.some((box) => box.id === ref.id)).toBe(true);
    });

    it("sleeps, refuses exec while asleep, and wakes on start", async () => {
      const slept = await provider.sleep(ref);
      expect(slept.state).toBe("sleeping");
      expect(slept.ready).toBe(false);

      const again = await provider.sleep(ref);
      expect(again.state).toBe("sleeping");

      // MEASURED: exec never wakes a paused box; the allocator must call start.
      await expect(provider.exec(ref, "echo awake?")).rejects.toMatchObject({ code: "not_running" });

      const woke = await provider.start(ref);
      expect(woke.ready).toBe(true);
      const result = await provider.exec(ref, "echo after-wake");
      expect(result.stdout).toContain("after-wake");
    });

    it("throws ProviderError, never a bare error, for unknown computers", async () => {
      const missing: ComputerRef = { provider: provider.name, account: provider.account, id: "pupbot-no-such-box" };
      await expect(provider.status(missing)).rejects.toBeInstanceOf(ProviderError);
      await expect(provider.exec(missing, "true")).rejects.toBeInstanceOf(ProviderError);
      await provider.destroy(missing);
    });

    it("destroys the computer, and destroying it again resolves", async () => {
      await provider.destroy(ref);
      await expect(provider.destroy(ref)).resolves.toBeUndefined();
      await expect(provider.status(ref)).rejects.toMatchObject({ code: "not_found" });
      const boxes = await provider.listComputers();
      expect(boxes.some((box) => box.id === ref.id)).toBe(false);
      ref = { ...ref, id: "already-destroyed" };
    });
  });
}
