import { serverEnv } from "@terabot/config";
import { database, roleOf } from "@terabot/db";
import type { ServerEnv } from "@terabot/config";
import { eq } from "drizzle-orm";
import { billingSubscription } from "@terabot/db";
import { parsePlans, type Plan } from "./plans.ts";

/**
 * The billing gate.
 *
 * It is on only when the deployment is actually set up to take money: Polar
 * credentials, at least one configured plan, **and** a paid computer provider.
 * With any of those missing there is no gate at all — access stays free and
 * automatic, which is what every existing deployment of this app looks like.
 *
 * The gate never renders anything. A gated action is refused on the server and
 * returns a `GateNotice`, which the run passes to the model so the bot can
 * explain the situation and the fix in its own words.
 */

export interface GateNotice {
  /** Stable machine code. `plan_required` is the only one that means "not paying". */
  code: "plan_required" | "plan_inactive";
  /** What is true, in one sentence. */
  situation: string;
  /** What the person can do about it. */
  resolution: string;
}

/** A refusal a caller turns into an HTTP body or a server-action error. */
export class GateError extends Error {
  readonly notice: GateNotice;
  constructor(notice: GateNotice) {
    super(`${notice.situation} ${notice.resolution}`);
    this.name = "GateError";
    this.notice = notice;
  }
}

export interface GateConfig {
  /** Polar can take a payment. */
  polar: boolean;
  /** A computer provider costs money, so there is something to pay for. */
  paidComputers: boolean;
  plans: Plan[];
}

export function gateConfig(env: ServerEnv = serverEnv()): GateConfig {
  return {
    // All three are needed to complete a checkout and record its result: the
    // token creates the session, `POLAR_PLANS` says what to sell, and the
    // webhook secret is how the truth gets back to us.
    polar: Boolean(env.POLAR_ACCESS_TOKEN) && Boolean(env.POLAR_WEBHOOK_SECRET) && Boolean(env.POLAR_PLANS),
    paidComputers: Boolean(env.INSTABOX_API_KEY) || Boolean(env.BOAT_API_KEY),
    plans: parsePlans(env.POLAR_PLANS),
  };
}

/**
 * The single question every gated action asks. False means "behave exactly as
 * before the gate existed".
 */
export function billingGateEnabled(env: ServerEnv = serverEnv()): boolean {
  const config = gateConfig(env);
  return config.polar && config.paidComputers && config.plans.length > 0;
}

export interface Access {
  /** Whether billing is switched on for this deployment. */
  gated: boolean;
  /** Whether this person may use the paid product. */
  allowed: boolean;
  role: "owner" | "member";
  plan: Plan | null;
  notice: GateNotice | null;
}

const FREE: Omit<Access, "role"> = { gated: false, allowed: true, plan: null, notice: null };

/** "active" and "trialing" both mean Polar is charging (or about to) and access stands. */
const PAYING = new Set(["active", "trialing"]);

function noticeFor(status: string | null): GateNotice {
  if (status === "past_due" || status === "unpaid") {
    return {
      code: "plan_inactive",
      situation: "The plan's last payment did not go through, so cloud work is paused.",
      resolution: "Update the payment method in Settings → Billing to turn it back on.",
    };
  }
  return {
    code: "plan_required",
    situation: "No cloud plan is active on this account.",
    resolution: "The person can choose one in Settings → Billing.",
  };
}

/**
 * Resolves one account's access. The Owner never pays and is never gated; that
 * is decided from the `user` row, not from anything the client sends.
 */
export async function accessFor(userId: string, env: ServerEnv = serverEnv()): Promise<Access> {
  const role = (await roleOf(userId)) ?? "member";
  if (!billingGateEnabled(env)) return { ...FREE, role };
  if (role === "owner") return { ...FREE, role, gated: true };

  const rows = await database()
    .select({
      status: billingSubscription.status,
      planId: billingSubscription.planId,
      currentPeriodEnd: billingSubscription.currentPeriodEnd,
    })
    .from(billingSubscription)
    .where(eq(billingSubscription.userId, userId))
    .limit(1);

  const row = rows[0];
  const plans = parsePlans(env.POLAR_PLANS);

  if (!row) {
    return { gated: true, allowed: false, role, plan: null, notice: noticeFor(null) };
  }

  // A subscription that ran out of paid period is over even if the webhook that
  // says so has not arrived yet: the period end is what was bought.
  const ended = row.currentPeriodEnd !== null && row.currentPeriodEnd.getTime() <= Date.now();
  const paying = PAYING.has(row.status) && !ended;
  const plan = plans.find((entry) => entry.id === row.planId) ?? null;

  if (!paying) {
    return { gated: true, allowed: false, role, plan, notice: noticeFor(row.status) };
  }
  return { gated: true, allowed: true, role, plan, notice: null };
}

/** Throws when the account may not perform a gated action. */
export async function requireAccess(userId: string, env: ServerEnv = serverEnv()): Promise<Access> {
  const access = await accessFor(userId, env);
  if (!access.allowed && access.notice) throw new GateError(access.notice);
  return access;
}

/**
 * The three gated actions, named after what the person is trying to do rather
 * than after a table. They are separate functions even though they resolve the
 * same access today: the product rule is that these are three refusals, and a
 * future plan that allows one of them must not silently allow all three.
 */
export const canSendMessages = accessFor;
export const canStartANewBot = accessFor;
export const canUseComputer = accessFor;

/**
 * The sentence the run hands to the model. One place, so every caller says the
 * same thing and the phrasing can be changed in a single edit.
 */
export function describeGate(notice: GateNotice): string {
  return [
    `[Gated action refused] ${notice.situation}`,
    `Tell the person this plainly, in your own words, as part of your normal reply — do not claim you did the work.`,
    `What fixes it: ${notice.resolution}`,
  ].join(" ");
}
