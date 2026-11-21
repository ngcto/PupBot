import { serverEnv } from "@terabot/config";
import type { ServerEnv } from "@terabot/config";
import { billingSubscription, database, newId, user } from "@terabot/db";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { billingGateEnabled, gateConfig } from "./gate.ts";
import { billingReturnUrl, createPolarClient, PolarError, type PolarClient } from "./polar.ts";
import { parsePlans, type Plan } from "./plans.ts";

/**
 * Checkout and webhook reconciliation.
 *
 * The rule this file exists to hold: a row is written when a checkout starts and
 * again for every webhook, and nothing else about the account is created from a
 * payment. An abandoned checkout therefore leaves one `incomplete` row and
 * nothing else — the account already exists, so there is no half-provisioned
 * state to repair.
 */

export class BillingUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnavailable";
  }
}

function client(env: ServerEnv): PolarClient {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new BillingUnavailable("Polar is not configured: POLAR_ACCESS_TOKEN is unset.");
  }
  return createPolarClient({ token: env.POLAR_ACCESS_TOKEN, sandbox: env.POLAR_SERVER === "sandbox" });
}

export function plansFor(env: ServerEnv = serverEnv()): Plan[] {
  return parsePlans(env.POLAR_PLANS);
}

export interface CheckoutStart {
  url: string;
  checkoutId: string;
  planId: string;
}

/**
 * Creates a Polar checkout session for one account and records the attempt.
 *
 * The row is upserted to `incomplete` only when it is not already paying: a
 * second click must not reset a live subscription's status.
 */
export async function startCheckout(input: {
  userId: string;
  email: string;
  planId: string;
  env?: ServerEnv;
}): Promise<CheckoutStart> {
  const env = input.env ?? serverEnv();
  // Charging for something we cannot then honour is worse than not selling it:
  // without a webhook secret nothing records the payment, and without a paid
  // provider there is nothing to pay for. The gate's own condition decides.
  if (!billingGateEnabled(env)) {
    throw new BillingUnavailable("Billing is not configured on this deployment; nothing can be charged here.");
  }
  const plan = plansFor(env).find((entry) => entry.id === input.planId);
  if (!plan) throw new BillingUnavailable(`No plan with id "${input.planId}" is configured.`);

  const session = await client(env).createCheckout({
    products: [plan.productId],
    externalCustomerId: input.userId,
    customerEmail: input.email,
    successUrl: billingReturnUrl(env, "success"),
  });

  const db = database();
  await db
    .insert(billingSubscription)
    .values({
      id: newId(),
      userId: input.userId,
      planId: plan.id,
      status: "incomplete",
      polarCheckoutId: session.id,
    })
    .onConflictDoUpdate({
      target: billingSubscription.userId,
      set: { polarCheckoutId: session.id, planId: plan.id, updatedAt: new Date() },
    });

  return { url: session.url, checkoutId: session.id, planId: plan.id };
}

/**
 * Asks Polar what this account's subscription really is and records it.
 *
 * This is what makes a return from checkout work without a webhook having
 * arrived yet, and it is safe to call on every page load of the billing screen:
 * with no Polar configured it does nothing.
 */
export async function refreshFromPolar(userId: string, env: ServerEnv = serverEnv()): Promise<boolean> {
  if (!env.POLAR_ACCESS_TOKEN) return false;
  const state = await client(env).customerState(userId);
  if (!state) return false;

  const plans = plansFor(env);
  const live = state.active_subscriptions.find((subscription) => {
    return plans.some((plan) => plan.productId === subscription.product_id);
  });

  const db = database();
  if (!live) {
    // Polar holds no live subscription: only a row that claims one is corrected.
    // An `incomplete` row from an abandoned checkout stays as it is.
    await db
      .update(billingSubscription)
      .set({ status: "canceled", updatedAt: new Date(), lastEventAt: new Date() })
      .where(and(eq(billingSubscription.userId, userId), ne(billingSubscription.status, "incomplete")));
    return false;
  }

  const plan = plans.find((entry) => entry.productId === live.product_id) ?? null;
  const status = normaliseStatus(live.status);
  await db
    .insert(billingSubscription)
    .values({
      id: newId(),
      userId,
      planId: plan?.id ?? "unknown",
      status,
      polarCustomerId: state.id,
      polarSubscriptionId: live.id,
      currentPeriodEnd: live.current_period_end ? new Date(live.current_period_end) : null,
      cancelAtPeriodEnd: live.cancel_at_period_end ?? false,
    })
    .onConflictDoUpdate({
      target: billingSubscription.userId,
      set: {
        planId: plan?.id ?? "unknown",
        status,
        polarCustomerId: state.id,
        polarSubscriptionId: live.id,
        currentPeriodEnd: live.current_period_end ? new Date(live.current_period_end) : null,
        cancelAtPeriodEnd: live.cancel_at_period_end ?? false,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      },
    });
  return true;
}

const SUBSCRIPTION_STATUSES = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "revoked",
  "paused",
]);

/** Polar may add a status we do not know; an unknown one must not read as paid. */
function normaliseStatus(raw: string): "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "revoked" | "paused" {
  return (SUBSCRIPTION_STATUSES.has(raw) ? raw : "incomplete") as ReturnType<typeof normaliseStatus>;
}

/* ───────────────────────────── webhooks ───────────────────────────── */

const subscriptionEventSchema = z.object({
  type: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    product_id: z.string().min(1).optional(),
    current_period_end: z.string().nullable().optional(),
    cancel_at_period_end: z.boolean().optional(),
    customer: z
      .object({
        id: z.string().min(1).optional(),
        external_id: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      })
      .optional(),
    customer_id: z.string().min(1).optional(),
    /** Polar's own modification time: the ordering key for a delivery. */
    modified_at: z.string().nullable().optional(),
  }),
});

/** Events that carry a subscription; `subscription.updated` is the catch-all. */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.cycled",
  "subscription.past_due",
  "subscription.revoked",
  "subscription.paused",
  "subscription.resumed",
  "subscription.migrated",
]);

export interface WebhookOutcome {
  handled: boolean;
  /** The account the event applied to, when it could be resolved. */
  userId?: string;
  reason?: string;
}

async function userIdFor(externalId: string | null | undefined, email: string | null | undefined): Promise<string | null> {
  const db = database();
  if (externalId) {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, externalId)).limit(1);
    if (rows[0]) return rows[0].id;
  }
  if (email) {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/**
 * Applies one verified webhook payload.
 *
 * Verified upstream by `verifyWebhook`; this function assumes the signature has
 * already been checked and only decides what the payload means.
 */
export async function applyWebhookEvent(payload: unknown, env: ServerEnv = serverEnv()): Promise<WebhookOutcome> {
  if (!billingGateEnabled(env)) return { handled: false, reason: "gate_disabled" };

  const parsed = subscriptionEventSchema.safeParse(payload);
  if (!parsed.success) return { handled: false, reason: "unrecognised_payload" };
  const event = parsed.data;
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return { handled: false, reason: `ignored:${event.type}` };

  // A subscription for a product this deployment does not sell must never read
  // as paid access, whoever it belongs to. A Polar organization can hold several
  // products, and only the ones in `POLAR_PLANS` are ours to honour.
  const plans = plansFor(env);
  const plan = event.data.product_id ? (plans.find((entry) => entry.productId === event.data.product_id) ?? null) : null;
  if (!plan) return { handled: false, reason: "unconfigured_product" };

  const externalId = event.data.customer?.external_id ?? null;
  const email = event.data.customer?.email ?? null;
  const userId = await userIdFor(externalId, email);
  if (!userId) return { handled: false, reason: "unknown_customer" };

  const db = database();
  const incoming = event.data.modified_at ? new Date(event.data.modified_at) : null;
  const status = normaliseStatus(event.data.status);
  const patch = {
    planId: plan.id,
    status,
    polarCustomerId: event.data.customer?.id ?? event.data.customer_id ?? null,
    polarSubscriptionId: event.data.id,
    currentPeriodEnd: event.data.current_period_end ? new Date(event.data.current_period_end) : null,
    cancelAtPeriodEnd: event.data.cancel_at_period_end ?? false,
  };

  /**
   * One transaction, one row lock: the check and the write cannot interleave, so
   * two deliveries for the same account cannot both pass a stale check and then
   * commit out of order.
   *
   * Ordering is per subscription, not per account. A person can hold two
   * subscriptions at once (they bought a second plan before cancelling the
   * first), and an event for the one we are *not* tracking must not overwrite the
   * one we are: it is only allowed to take the row over when it is the newer
   * subscription, or carries no ordering information at all.
   */
  return await db.transaction(async (tx): Promise<WebhookOutcome> => {
    const locked = await tx
      .select()
      .from(billingSubscription)
      .where(eq(billingSubscription.userId, userId))
      .for("update")
      .limit(1);
    const current = locked[0];

    if (!current) {
      await tx.insert(billingSubscription).values({
        id: newId(),
        userId,
        ...patch,
        lastEventAt: incoming,
      });
      return { handled: true, userId };
    }

    const sameSubscription = current.polarSubscriptionId === event.data.id;
    if (!sameSubscription) {
      // Different subscription: only a strictly newer one may replace what we
      // track. Without a timestamp there is nothing to compare, so the stored
      // subscription keeps the row and this event is ignored.
      const newer =
        incoming !== null && (current.lastEventAt === null || incoming.getTime() > current.lastEventAt.getTime());
      if (!newer) return { handled: false, reason: "other_subscription", userId };
      await tx
        .update(billingSubscription)
        .set({ ...patch, lastEventAt: incoming, updatedAt: new Date() })
        .where(eq(billingSubscription.userId, userId));
      return { handled: true, userId };
    }

    // Same subscription: an event older than what we already applied is a late
    // or retried delivery, and must not resurrect a revoked subscription.
    if (incoming && current.lastEventAt && incoming.getTime() < current.lastEventAt.getTime()) {
      return { handled: false, reason: "stale_event", userId };
    }

    await tx
      .update(billingSubscription)
      .set({
        ...patch,
        // Never stamp our own clock into Polar's ordering key: an event without
        // a timestamp leaves the previous value alone rather than making later
        // legitimate events look stale.
        ...(incoming ? { lastEventAt: incoming } : {}),
        updatedAt: new Date(),
      })
      .where(eq(billingSubscription.userId, userId));
    return { handled: true, userId };
  });
}

/**
 * What `/settings/billing` shows and what the gate reads, in one place.
 */
export async function billingSummary(userId: string, env: ServerEnv = serverEnv()) {
  const config = gateConfig(env);
  const enabled = billingGateEnabled(env);
  const rows = await database()
    .select()
    .from(billingSubscription)
    .where(eq(billingSubscription.userId, userId))
    .limit(1);
  const row = rows[0] ?? null;
  return {
    // The same condition the gate uses, so the page never offers a checkout the
    // gate would refuse and never hides one it would allow.
    configured: enabled,
    plans: config.plans,
    status: row?.status ?? null,
    planId: row?.planId ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    polarCustomerId: row?.polarCustomerId ?? null,
  };
}

export { PolarError };
