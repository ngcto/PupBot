import { describe, expect, it } from "vitest";
import { MANAGED_PROVIDERS, eligibleAccounts, managedProviderSpecs } from "../src/index.ts";
import type { AccountRecord } from "../src/index.ts";

function account(overrides: Partial<AccountRecord> & { id: string }): AccountRecord {
  return {
    provider: "instabox",
    label: overrides.id,
    encryptedCredential: "encrypted",
    status: "active",
    capacity: 1,
    managed: false,
    ownerUserId: null,
    parkedUntil: null,
    lastError: null,
    ...overrides,
  };
}

describe("managed providers an environment turns on", () => {
  it("lends nothing when the deployment configured no key", () => {
    expect(managedProviderSpecs({})).toEqual([]);
  });

  it("reads the key independently, so a provider the deployment did not configure stays absent", () => {
    expect(managedProviderSpecs({ INSTABOX_API_KEY: "k" }).map((spec) => spec.provider)).toEqual(["instabox"]);
  });

  it("uses the documented capacity default and honours an override", () => {
    const [instabox] = managedProviderSpecs({ INSTABOX_API_KEY: "k" });
    expect(instabox?.capacity).toBe(1);
    expect(managedProviderSpecs({ INSTABOX_API_KEY: "k", INSTABOX_CAPACITY: "5" })[0]?.capacity).toBe(5);
    // A malformed value falls back instead of making an account that can never
    // be used, or one with unlimited capacity from NaN.
    expect(managedProviderSpecs({ INSTABOX_API_KEY: "k", INSTABOX_CAPACITY: "0" })[0]?.capacity).toBe(1);
    expect(managedProviderSpecs({ INSTABOX_API_KEY: "k", INSTABOX_CAPACITY: "abc" })[0]?.capacity).toBe(1);
  });

  it("names every provider it considered, so a caller can say what is absent", () => {
    expect(MANAGED_PROVIDERS).toEqual(["instabox"]);
  });
});

describe("which accounts may serve a bot", () => {
  it("gives a bot with no owner only the deployment's accounts", () => {
    const accounts = [
      account({ id: "managed", managed: true }),
      account({ id: "someone-else", ownerUserId: "user-a" }),
    ];
    expect(eligibleAccounts(accounts, null).map((entry) => entry.id)).toEqual(["managed"]);
  });

  it("gives a bot its owner's own account and every managed account", () => {
    const accounts = [
      account({ id: "managed", managed: true }),
      account({ id: "mine", ownerUserId: "user-a" }),
      account({ id: "theirs", ownerUserId: "user-b" }),
    ];
    expect(eligibleAccounts(accounts, "user-a").map((entry) => entry.id)).toEqual(["managed", "mine"]);
  });

  it("never hands one user's key to another user's bot", () => {
    const accounts = [account({ id: "theirs", ownerUserId: "user-b" })];
    expect(eligibleAccounts(accounts, "user-a")).toEqual([]);
  });

  it("skips a draining or broken account and keeps the rest", () => {
    const accounts = [
      account({ id: "draining", managed: true, status: "draining" }),
      account({ id: "broken", managed: true, status: "error" }),
      account({ id: "fine", managed: true }),
    ];
    expect(eligibleAccounts(accounts, null).map((entry) => entry.id)).toEqual(["fine"]);
  });

  it("leaves a managed row eligible for a user who also connected their own", () => {
    // Their own key wins on ranking, but it must not remove the deployment's
    // account from the pool: it is the fallback when their own is full.
    const accounts = [
      account({ id: "mine", ownerUserId: "user-a" }),
      account({ id: "managed", managed: true }),
    ];
    expect(eligibleAccounts(accounts, "user-a")).toHaveLength(2);
  });
});
