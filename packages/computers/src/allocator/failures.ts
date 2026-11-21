import type { ProviderErrorCode } from "../contract.ts";

/**
 * Why a bot could not get a computer, in a form the model can act on.
 *
 * This type is the product's user-facing story now. Nothing renders a card or
 * injects a message: the run hands this to the model as a tool result, and the
 * model explains it to the user in its own words. So every field has to carry
 * its own weight — `summary` is the situation, `resolution` is the thing a
 * person would actually have to do, and `userAction` says whether there is
 * anything a person can do at all.
 *
 * It is deliberately the same shape as the harness's `Obstacle` (see
 * `packages/agent/src/computer.ts`) and a narrower code set. The two are kept
 * separate rather than shared so the provider layer does not depend on the
 * harness, and `apps/worker` maps one to the other in a single function. The
 * wording of a failure is written here, where the cause is known; the harness
 * only decides how a bot is asked to relay it.
 */
export interface ComputerFailure {
  code: ComputerFailureCode;
  /** One sentence naming what is wrong, readable to a model and to a person. */
  summary: string;
  /** The detail: which provider, which limit, which error. Never a stack trace. */
  detail: string;
  /** What would fix it, specific to the case. */
  resolution: string;
  /**
   * `configure` and `plan` are things the user can do; `wait` comes back on its
   * own; `none` is not the user's problem and must not be dressed as one.
   */
  userAction: "configure" | "plan" | "wait" | "none";
  /** True when trying again later may work without the user changing anything. */
  retryable: boolean;
}

export type ComputerFailureCode =
  /** This workspace has no computer provider and the deployment supplies no pool. */
  | "no_provider"
  /** A deployment pool exists but it needs a plan this workspace does not have. */
  | "no_plan"
  /** Providers are configured, but every one of them is full or rate-limited. */
  | "all_busy"
  /** A provider answered with an error we cannot turn into advice. */
  | "provider_error";

/**
 * What this workspace can actually reach, which decides what the model is told.
 * Gathered by the caller because it is a policy question — an entitlement
 * lookup, an environment read — not something the allocator should guess.
 */
export interface PoolAvailability {
  /** A deployment-provided pool exists (a managed account), so no user key is needed. */
  managedPool: boolean;
  /** That pool requires a plan, and this workspace has none active. */
  planMissing: boolean;
}

export const NO_POOL: PoolAvailability = { managedPool: false, planMissing: false };

/**
 * Turn the failures one allocation collected into the single thing the model
 * reads. The cases are ordered by what the user can do about them, because the
 * most actionable explanation is the one worth leading with: a missing provider
 * is a setting, a full provider is a wait, and a provider error is nobody's
 * fault.
 */
export function classifyFailure(input: {
  /** Every provider account this workspace could have used; empty means none. */
  accounts: number;
  availability: PoolAvailability;
  failures: Array<{ code: ProviderErrorCode; message: string }>;
}): ComputerFailure {
  const { accounts, availability, failures } = input;

  if (accounts === 0 && !availability.managedPool) {
    return {
      code: "no_provider",
      summary: "No computer is available because no computer provider is configured.",
      detail:
        "This bot has no machine to work on, and the deployment does not supply one. Nothing is broken and nothing was charged.",
      resolution:
        "The user can add a computer provider in Settings, under Computer: an Instabox API key is enough, and it is free to start.",
      userAction: "configure",
      retryable: false,
    };
  }

  if (accounts === 0 && availability.planMissing) {
    return {
      code: "no_plan",
      summary: "No computer is available because no cloud plan is active on this account.",
      detail:
        "Computers are provided by the deployment, but they are only unlocked for accounts with an active plan, and this one has none.",
      resolution:
        "The user can choose a plan in Settings, under Billing. The bot can work on the machine as soon as the plan is active.",
      userAction: "plan",
      retryable: false,
    };
  }

  const capacityCodes = new Set<ProviderErrorCode>(["quota", "no_capacity", "rate_limited"]);
  const allCapacity = failures.length > 0 && failures.every((failure) => capacityCodes.has(failure.code));
  if (allCapacity) {
    const rateLimited = failures.some((failure) => failure.code === "rate_limited");
    return {
      code: "all_busy",
      summary: rateLimited
        ? "All computers are busy right now: every provider is at its limit or rate-limited."
        : "All computers are busy right now: every provider has used all of its machines.",
      detail: `Tried ${failures.length} provider ${failures.length === 1 ? "account" : "accounts"}: ${failures
        .map((failure) => `${failure.code} (${failure.message})`)
        .join("; ")}.`,
      resolution: rateLimited
        ? "Nothing to buy and nothing to configure: a rate limit clears on its own within a few minutes, so trying again shortly is the fix. The user can also add a second provider in Settings, under Computer, so one provider being throttled does not block them."
        : // A sleeping box still occupies the plan's slot, so "wait for idle" would be
          // a promise this system does not keep. Say what actually frees a machine.
          "Nothing to buy: every machine this plan allows is holding a bot. Waiting does not free one, because a sleeping machine still counts. The user can delete a bot they no longer use, or add a second provider in Settings, under Computer, so one provider being full does not block them.",
      userAction: "wait",
      retryable: true,
    };
  }

  const first = failures[0];
  // A temporary outage is not a credential problem, and telling someone to replace
  // a working key sends them to fix the one thing that is fine.
  const transient = failures.every((failure) =>
    failure.code === "unavailable" || failure.code === "timeout" || failure.code === "busy",
  );
  if (transient) {
    return {
      code: "provider_error",
      summary: "The computer provider did not respond.",
      detail: first ? `The provider answered: ${first.code} (${first.message}).` : "No provider answered.",
      resolution:
        "Nothing to configure and nothing to buy: the provider itself is having trouble, so trying again in a few minutes is the fix. If it keeps happening, it is worth telling them the provider looks down rather than that their key is wrong.",
      userAction: "wait",
      retryable: true,
    };
  }

  const credential = failures.some((failure) => failure.code === "auth");
  return {
    code: "provider_error",
    summary: credential
      ? "The computer provider rejected this workspace's credentials."
      : "The computer provider did not accept the request.",
    detail: first ? `The provider answered: ${first.code} (${first.message}).` : "No provider answered.",
    resolution: credential
      ? "The user can replace that provider's key in Settings, under Computer; a key that was revoked or rotated is the usual cause."
      : "The user can check the provider account in Settings, under Computer: a key without the right permission or a plan that cannot create this machine is the usual cause. Retrying once is reasonable.",
    userAction: "configure",
    retryable: true,
  };
}
