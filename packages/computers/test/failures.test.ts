import { describe, expect, it } from "vitest";
import { NO_POOL, classifyFailure } from "../src/index.ts";

/**
 * The four ways a bot can be stopped, and what each one tells the user.
 *
 * This is the product's user-facing text now: nothing renders a card, so the model
 * relays these strings and they are the entire mechanism. The tests assert the
 * *distinctions* — that "all busy" never asks for money, that a missing provider
 * and a missing plan are not the same advice — because a failure that names the
 * wrong fix is worse than one that names none.
 */
describe("classifying a computer failure for the model to relay", () => {
  it("no provider configured: sends the user to add one", () => {
    const failure = classifyFailure({ accounts: 0, availability: NO_POOL, failures: [] });
    expect(failure.code).toBe("no_provider");
    expect(failure.userAction).toBe("configure");
    expect(failure.resolution).toContain("Settings");
    expect(failure.resolution).toContain("Instabox");
    expect(failure.retryable).toBe(false);
    // Nothing was charged and nothing is broken: say so, or the user will think the
    // product failed rather than that it needs a key.
    expect(failure.detail).toContain("Nothing is broken");
  });

  it("no plan under a deployment pool: sends the user to billing, not to a key", () => {
    const failure = classifyFailure({
      accounts: 0,
      availability: { managedPool: true, planMissing: true },
      failures: [],
    });
    expect(failure.code).toBe("no_plan");
    expect(failure.userAction).toBe("plan");
    expect(failure.resolution).toContain("Billing");
    // The distinguishing assertion: it must not tell them to add a provider, which
    // would be an unrelated chore that cannot help.
    expect(failure.resolution).not.toContain("Instabox");
  });

  it("every provider busy: no purchase prompt, because there is nothing to buy", () => {
    const failure = classifyFailure({
      accounts: 2,
      availability: { managedPool: true, planMissing: false },
      failures: [
        { code: "quota", message: "plan limit reached" },
        { code: "rate_limited", message: "slow down" },
      ],
    });
    expect(failure.code).toBe("all_busy");
    expect(failure.userAction).toBe("wait");
    expect(failure.retryable).toBe(true);
    // The one that matters: a busy machine is not a reason to sell someone a plan.
    expect(failure.resolution.toLowerCase()).not.toContain("choose a plan");
    expect(failure.resolution.toLowerCase()).not.toContain("billing");
    expect(failure.detail).toContain("quota");
  });

  it("a provider error: names the key, not the user's wallet", () => {
    const failure = classifyFailure({
      accounts: 1,
      availability: NO_POOL,
      failures: [{ code: "template_refused", message: "plan cannot use that template" }],
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.userAction).toBe("configure");
    expect(failure.detail).toContain("template_refused");
    expect(failure.resolution).toContain("Settings");
  });

  it("never leaves a resolution that names nothing the user can do", () => {
    // Every case must produce something a person could actually act on, or an
    // explicit statement that they cannot — the model cannot invent the fix.
    const cases = [
      classifyFailure({ accounts: 0, availability: NO_POOL, failures: [] }),
      classifyFailure({ accounts: 0, availability: { managedPool: true, planMissing: true }, failures: [] }),
      classifyFailure({ accounts: 1, availability: NO_POOL, failures: [{ code: "quota", message: "full" }] }),
      classifyFailure({ accounts: 1, availability: NO_POOL, failures: [{ code: "auth", message: "bad key" }] }),
    ];
    for (const failure of cases) {
      expect(failure.resolution.length).toBeGreaterThan(20);
      expect(failure.summary.length).toBeGreaterThan(10);
      expect(["configure", "plan", "wait", "none"]).toContain(failure.userAction);
    }
  });
});

describe("advice that must not promise something untrue", () => {
  it("does not tell a user that waiting frees a full plan, because a sleeping box still counts", () => {
    const failure = classifyFailure({
      accounts: 1,
      availability: NO_POOL,
      failures: [{ code: "quota", message: "plan limit reached" }],
    });
    // Saying "machines are released when bots go idle" would be false: the
    // allocator counts sleeping boxes, so an idle bot still holds its slot.
    expect(failure.resolution).not.toMatch(/released when|go idle/i);
    expect(failure.resolution).toContain("delete a bot");
  });

  it("sends a provider outage to waiting, not to replacing a working key", () => {
    const failure = classifyFailure({
      accounts: 1,
      availability: NO_POOL,
      failures: [{ code: "unavailable", message: "the provider is down" }],
    });
    expect(failure.userAction).toBe("wait");
    expect(failure.resolution).not.toContain("replace");
    expect(failure.resolution.toLowerCase()).toContain("provider");
  });

  it("reserves key advice for a credential failure", () => {
    const failure = classifyFailure({
      accounts: 1,
      availability: NO_POOL,
      failures: [{ code: "auth", message: "invalid key" }],
    });
    expect(failure.userAction).toBe("configure");
    expect(failure.resolution).toContain("replace");
    expect(failure.summary).toContain("credentials");
  });
});
