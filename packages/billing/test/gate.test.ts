import { loadEnv } from "@terabot/config/load-env";

loadEnv();
import { closeDatabase, database, ensureWorkspace, user } from "@terabot/db";
import { serverEnv } from "@terabot/config";
import type { ServerEnv } from "@terabot/config";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessFor, billingGateEnabled, gateConfig, requireAccess, GateError } from "../src/gate.ts";

/**
 * The promise this file exists to keep: **with no Polar environment, nothing
 * changes.** Every assertion below runs the real gate against a real database
 * with the billing variables unset, and asserts it never refuses anyone.
 */

const BASE = serverEnv();

/** A copy of the real environment with the billing variables removed. */
function withoutPolar(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    ...BASE,
    POLAR_ACCESS_TOKEN: undefined,
    POLAR_WEBHOOK_SECRET: undefined,
    POLAR_PLANS: undefined,
    ...overrides,
  };
}

const POLAR_SET = {
  POLAR_ACCESS_TOKEN: "polar_oat_test_token_value",
  POLAR_WEBHOOK_SECRET: "whsec_test_secret_value",
  POLAR_PLANS: JSON.stringify([{ id: "pro", label: "Pro", productId: "prod_test_1" }]),
};

describe("billing gate", () => {
  const created: string[] = [];

  async function makeUser(role: "owner" | "member"): Promise<string> {
    const email = `gate-${randomUUID()}@terabot.dev`;
    const result = await database()
      .insert(user)
      .values({ id: `gate_${randomUUID()}`, email, name: "Gate Test", role })
      .returning({ id: user.id });
    const id = result[0]!.id;
    created.push(id);
    await ensureWorkspace(id, "Gate Test");
    return id;
  }

  let member: string;
  let owner: string;

  beforeAll(async () => {
    member = await makeUser("member");
    owner = await makeUser("owner");
  });

  afterAll(async () => {
    for (const id of created) {
      await database().delete(user).where(eq(user.id, id));
    }
    await closeDatabase();
  });

  describe("with no Polar configured", () => {
    it("reports the gate as off", () => {
      expect(billingGateEnabled(withoutPolar())).toBe(false);
      expect(gateConfig(withoutPolar()).polar).toBe(false);
    });

    it("lets a member through, and says nothing about a plan", async () => {
      const access = await accessFor(member, withoutPolar());
      expect(access.allowed).toBe(true);
      expect(access.gated).toBe(false);
      expect(access.notice).toBeNull();
      expect(access.plan).toBeNull();
    });

    it("does not throw from requireAccess", async () => {
      await expect(requireAccess(member, withoutPolar())).resolves.toMatchObject({ allowed: true });
    });

    it("stays off when Polar is set but there is no paid computer provider", async () => {
      const env = withoutPolar({ ...POLAR_SET, INSTABOX_API_KEY: undefined, BOAT_API_KEY: undefined });
      expect(billingGateEnabled(env)).toBe(false);
      await expect(requireAccess(member, env)).resolves.toMatchObject({ allowed: true, gated: false });
    });

    it("stays off when a computer provider is set but Polar is not", async () => {
      const env = withoutPolar({ INSTABOX_API_KEY: "instabox_key_value" });
      expect(billingGateEnabled(env)).toBe(false);
      await expect(requireAccess(member, env)).resolves.toMatchObject({ allowed: true, gated: false });
    });

    it("stays off when Polar has no plans configured", async () => {
      const env = withoutPolar({
        POLAR_ACCESS_TOKEN: "polar_oat_test_token_value",
        POLAR_WEBHOOK_SECRET: "whsec_test_secret_value",
        INSTABOX_API_KEY: "instabox_key_value",
      });
      expect(billingGateEnabled(env)).toBe(false);
      await expect(requireAccess(member, env)).resolves.toMatchObject({ allowed: true, gated: false });
    });
  });

  describe("with Polar and a paid computer provider", () => {
    const gated = (overrides: Partial<ServerEnv> = {}) =>
      withoutPolar({ ...POLAR_SET, INSTABOX_API_KEY: "instabox_key_value", ...overrides });

    it("is on", () => {
      expect(billingGateEnabled(gated())).toBe(true);
    });

    it("refuses a member who has never checked out", async () => {
      const access = await accessFor(member, gated());
      expect(access.allowed).toBe(false);
      expect(access.gated).toBe(true);
      expect(access.notice?.code).toBe("plan_required");
      expect(access.notice?.resolution).toContain("Settings → Billing");
    });

    it("throws a GateError the caller can turn into a refusal", async () => {
      const error = await requireAccess(member, gated()).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(GateError);
      expect((error as GateError).notice.code).toBe("plan_required");
    });

    it("never gates the Owner, even with no plan at all", async () => {
      const access = await accessFor(owner, gated());
      expect(access.allowed).toBe(true);
      expect(access.notice).toBeNull();
      await expect(requireAccess(owner, gated())).resolves.toMatchObject({ allowed: true, role: "owner" });
    });

    it("reads the Owner role from the database, not from the caller", async () => {
      // A member row is a member even when a request claims otherwise; accessFor
      // takes only an id, so there is no role argument to forge.
      const access = await accessFor(member, gated());
      expect(access.role).toBe("member");
      expect(access.allowed).toBe(false);
    });
  });
});

describe("checkout refuses to charge for something it cannot honour", () => {
  it("throws when only a Polar token is set, with no webhook and no paid provider", async () => {
    const { startCheckout, BillingUnavailable } = await import("../src/subscriptions.ts");
    const env = withoutPolar({ POLAR_ACCESS_TOKEN: "polar_oat_test_token_value" });
    await expect(
      startCheckout({ userId: "user_1", email: "a@b.dev", planId: "pro", env }),
    ).rejects.toBeInstanceOf(BillingUnavailable);
  });

  it("throws when Polar is complete but no paid computer provider is configured", async () => {
    const { startCheckout, BillingUnavailable } = await import("../src/subscriptions.ts");
    const env = withoutPolar({ ...POLAR_SET, INSTABOX_API_KEY: undefined, BOAT_API_KEY: undefined });
    await expect(
      startCheckout({ userId: "user_1", email: "a@b.dev", planId: "pro", env }),
    ).rejects.toBeInstanceOf(BillingUnavailable);
  });
});

describe("webhook entitlement", () => {
  const gatedEnv = () => withoutPolar({ ...POLAR_SET, INSTABOX_API_KEY: "instabox_key_value" });

  it("ignores a subscription for a product this deployment does not sell", async () => {
    const { applyWebhookEvent } = await import("../src/subscriptions.ts");
    const outcome = await applyWebhookEvent(
      {
        type: "subscription.active",
        data: {
          id: "sub_other",
          status: "active",
          product_id: "prod_someone_elses",
          customer: { id: "cus_1", external_id: "gate_nobody" },
        },
      },
      gatedEnv(),
    );
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe("unconfigured_product");
  });

  it("does nothing at all when the gate is off", async () => {
    const { applyWebhookEvent } = await import("../src/subscriptions.ts");
    const outcome = await applyWebhookEvent(
      { type: "subscription.active", data: { id: "sub", status: "active", product_id: "prod_test_1" } },
      withoutPolar(),
    );
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe("gate_disabled");
  });
});

describe("webhook ordering", () => {
  const gatedEnv = () => withoutPolar({ ...POLAR_SET, INSTABOX_API_KEY: "instabox_key_value" });
  const PRO = "prod_test_1";
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await database().delete(user).where(eq(user.id, id));
  });

  async function account() {
    const email = `order-${randomUUID()}@terabot.dev`;
    const rows = await database()
      .insert(user)
      .values({ id: `order_${randomUUID()}`, email, name: "Order Test" })
      .returning({ id: user.id });
    created.push(rows[0]!.id);
    return rows[0]!.id;
  }

  function event(subId: string, status: string, modifiedAt: string | null, product = PRO) {
    return {
      type: "subscription.updated",
      data: { id: subId, status, product_id: product, modified_at: modifiedAt },
    };
  }

  it("accepts a null modified_id without dropping the event", async () => {
    const { applyWebhookEvent } = await import("../src/subscriptions.ts");
    const id = await account();
    const outcome = await applyWebhookEvent(
      { type: "subscription.active", data: { id: "sub_null", status: "active", product_id: PRO, modified_at: null, customer: { external_id: id } } },
      gatedEnv(),
    );
    expect(outcome.handled).toBe(true);
  });

  it("ignores a late active after a revoked on the same subscription", async () => {
    const { applyWebhookEvent } = await import("../src/subscriptions.ts");
    const id = await account();
    const first = event("sub_a", "revoked", "2026-01-02T00:00:00.000Z");
    const late = event("sub_a", "active", "2026-01-01T00:00:00.000Z");
    await applyWebhookEvent({ ...first, data: { ...first.data, customer: { external_id: id } } }, gatedEnv());
    const outcome = await applyWebhookEvent({ ...late, data: { ...late.data, customer: { external_id: id } } }, gatedEnv());
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe("stale_event");
  });

  it("does not let an older subscription's cancellation wipe a newer active one", async () => {
    const { applyWebhookEvent } = await import("../src/subscriptions.ts");
    const { billingSubscription } = await import("@terabot/db");
    const id = await account();

    const bActive = event("sub_b", "active", "2026-01-02T00:00:00.000Z");
    await applyWebhookEvent({ ...bActive, data: { ...bActive.data, customer: { external_id: id } } }, gatedEnv());

    // Subscription A is older and unrelated now: its cancellation must not take
    // the row away from the plan the person is actually paying for.
    const aCanceled = event("sub_a", "canceled", "2026-01-01T00:00:00.000Z");
    const outcome = await applyWebhookEvent(
      { ...aCanceled, data: { ...aCanceled.data, customer: { external_id: id } } },
      gatedEnv(),
    );
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe("other_subscription");

    const row = await database()
      .select({ status: billingSubscription.status, sub: billingSubscription.polarSubscriptionId })
      .from(billingSubscription)
      .where(eq(billingSubscription.userId, id))
      .limit(1);
    expect(row[0]!.status).toBe("active");
    expect(row[0]!.sub).toBe("sub_b");
  });
});
