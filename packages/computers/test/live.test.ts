import { describe, expect, it } from "vitest";
import { InstaboxProvider } from "../src/index.ts";

const apiKey = process.env.INSTABOX_API_KEY ?? "";
const live = process.env.INSTABOX_LIVE === "1" && Boolean(apiKey);

/**
 * The one test that spends a real box. Opt in with INSTABOX_LIVE=1 and a key in
 * INSTABOX_API_KEY; it creates one box, measures every step the product relies
 * on, and destroys it, asserting that nothing is left behind.
 *
 * On free Instabox this is the whole monthly allowance of one running box, so
 * it never runs on the default `pnpm test`.
 */
describe.skipIf(!live)("instabox live", () => {
  it("provisions one box, execs, moves a file, suspends, resumes and destroys it", async () => {
    const provider = new InstaboxProvider({ account: "instabox:live", apiKey });
    const timings: Record<string, number> = {};
    const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      const value = await fn();
      timings[name] = Date.now() - started;
      console.log(`  ${name}: ${timings[name]} ms`);
      return value;
    };

    let ref: Awaited<ReturnType<typeof provider.provision>> | undefined;
    try {
      ref = await time("provision (create, operation, ready)", () =>
        provider.provision({ metadata: { "terabot-test": "live" }, ttlSeconds: 3600 }),
      );
      console.log(`  box: ${ref.id} on ${ref.account}`);

      const status = await time("status", () => provider.status(ref!));
      expect(status.state).toBe("running");
      expect(status.ready).toBe(true);
      expect(status.raw).toBe("running");

      const echo = await time("exec echo", () => provider.exec(ref!, "echo terabot-live"));
      expect(echo.exitCode).toBe(0);
      expect(echo.stdout).toContain("terabot-live");

      await time("putFile", () => provider.putFile(ref!, "/data/home/terabot-live.txt", "hello live"));
      const back = await time("getFile", () => provider.getFile(ref!, "/data/home/terabot-live.txt"));
      expect(new TextDecoder().decode(back)).toBe("hello live");

      const entries = await time("list", () => provider.list(ref!, "/data/home"));
      expect(entries.some((entry) => entry.name === "terabot-live.txt")).toBe(true);

      const slept = await time("sleep (suspend)", () => provider.sleep(ref!));
      expect(slept.state).toBe("sleeping");
      expect(slept.ready).toBe(false);

      const woke = await time("start (resume to ready)", () => provider.start(ref!));
      expect(woke.ready).toBe(true);
      console.log(`  processesPreserved: ${String(woke.processesPreserved)}`);

      const after = await time("exec after resume", () => provider.exec(ref!, "echo awake"));
      expect(after.stdout).toContain("awake");
    } finally {
      if (ref) {
        await time("destroy", () => provider.destroy(ref!));
        const boxes = await provider.listComputers();
        console.log(`  boxes left on the account: ${boxes.length}`);
        expect(boxes.some((box) => box.id === ref!.id)).toBe(false);
      }
    }
  }, 300_000);
});
