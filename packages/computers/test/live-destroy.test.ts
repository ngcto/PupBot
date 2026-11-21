import { describe, expect, it } from "vitest";
import { InstaboxProvider } from "../src/index.ts";

const apiKey = process.env.INSTABOX_API_KEY ?? "";
const live = process.env.INSTABOX_LIVE === "1" && Boolean(apiKey);

/**
 * The money proof: a real box is created at Instabox, then destroyed through the
 * same `destroy` the allocator calls when a bot is deleted, and the provider is
 * asked again to show it is gone.
 *
 * Everything else about the orphan path is proven against the fake and against
 * Postgres, but "does destroy actually delete it" can only be answered by the
 * provider. Re-listing is the assertion: an API that answers 200 to a delete
 * while the machine keeps running would pass a "destroy did not throw" test and
 * still bill someone every hour.
 *
 * Opt in with INSTABOX_LIVE=1. It spends one real box, so it never runs on the
 * default `pnpm test`.
 */
describe.skipIf(!live)("instabox live destroy", () => {
  it("deletes a real box and it is gone when the account is listed again", async () => {
    const provider = new InstaboxProvider({ account: "instabox:live-destroy", apiKey });

    const ref = await provider.provision({
      metadata: { "terabot-test": "live-destroy" },
      ttlSeconds: 3600,
    });
    console.log(`  created ${ref.id}`);

    // It exists right now, or the rest of this test proves nothing.
    const before = await provider.listComputers();
    expect(before.some((box) => box.id === ref.id)).toBe(true);

    /*
     * The orphan path's live half, on this same box because a free Instabox plan
     * allows one machine at a time.
     *
     * When a destroy fails, the record left behind must be enough to finish the
     * job later with only the provider, the account and the external id. The
     * realistic failure is a rotated or revoked key, so that is what is used: a
     * client with a bad key is told to delete the box and cannot.
     */
    const broken = new InstaboxProvider({ account: "instabox:live-destroy", apiKey: "ibk_not_a_real_key" });
    const refused = await broken.destroy(ref).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeTruthy();
    console.log(`  a bad credential cannot delete it: ${(refused as { code?: string }).code}`);

    // The box is still there — which is exactly why the credential has to outlive
    // the workspace, and why an orphan row must carry the account it belongs to.
    const survived = await provider.listComputers();
    expect(survived.some((box) => box.id === ref.id)).toBe(true);

    await provider.destroy(ref);
    console.log(`  destroyed ${ref.id}`);

    // The provider itself says it is gone, not just that the call returned.
    const after = await provider.listComputers();
    expect(after.some((box) => box.id === ref.id)).toBe(false);

    // A second destroy is a no-op rather than a `not_found`, which is the contract
    // the allocator's orphan path relies on to avoid recording a phantom leak.
    await expect(provider.destroy(ref)).resolves.toBeUndefined();
    // And status agrees.
    await expect(provider.status(ref)).rejects.toMatchObject({ code: "not_found" });
  }, 300_000);
});
