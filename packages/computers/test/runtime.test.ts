import { describe, expect, it } from "vitest";
import { ALLOCATOR_DEFAULTS, createComputerRuntime, MemoryComputerStore } from "../src/index.ts";

/**
 * The runtime exists to keep two clocks on one number.
 *
 * The reaper sleeps a box `idleSeconds` after its last use, and the provider is
 * told the same number so that it pauses the box by itself if our process dies.
 * The failure this prevents is invisible when it goes wrong: a box that never
 * pauses looks exactly like a box that is in use, until the bill arrives.
 */
describe("the computer runtime arms both idle enforcers with one number", () => {
  it("gives the provider factory the reaper's own idle window", () => {
    const runtime = createComputerRuntime({
      store: new MemoryComputerStore(),
      idleSeconds: 240,
    });

    // The reaper sleeps on 240...
    expect(runtime.allocator.config.idleSeconds).toBe(240);
    // ...and the provider registry was built with the same 240, which is what the
    // Instabox provider turns into `autoSuspendAfterSeconds` on every create
    // (proved in instabox.test.ts). Neither clock is left at a default.
    expect(runtime.providerOptions.idleTimeoutSeconds).toBe(240);
  });

  it("defaults both to the allocator's own window, and it is minutes not hours", () => {
    const runtime = createComputerRuntime({ store: new MemoryComputerStore() });

    expect(runtime.allocator.config.idleSeconds).toBe(ALLOCATOR_DEFAULTS.idleSeconds);
    expect(runtime.providerOptions.idleTimeoutSeconds).toBe(ALLOCATOR_DEFAULTS.idleSeconds);
    // A few minutes: long enough that a person reading a reply and typing the next
    // message keeps the same box, short enough that an abandoned bot stops costing.
    expect(ALLOCATOR_DEFAULTS.idleSeconds).toBeGreaterThanOrEqual(120);
    expect(ALLOCATOR_DEFAULTS.idleSeconds).toBeLessThanOrEqual(900);
  });

  it("carries a delete backstop too, so a leaked box cannot bill forever", () => {
    const runtime = createComputerRuntime({ store: new MemoryComputerStore() });
    expect(runtime.providerOptions.ttlSeconds).toBe(ALLOCATOR_DEFAULTS.ttlSeconds);
  });
});
