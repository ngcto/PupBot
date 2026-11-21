import { detectCaptcha, describeDetection } from "./detect.ts";
import { createSolver, solverRequestFor, tokenInjectionScript } from "./solver.ts";
import type { CaptchaSolver } from "./solver.ts";
import type { CaptchaDetection, CuaPageState } from "../types.ts";

/**
 * The challenge ladder, as one function.
 *
 * The order is the product decision, and it is cheapest-and-most-legitimate
 * first:
 *
 *   1. **Existing session.** A challenge, once passed, leaves a cookie. A bot
 *      that keeps its profile is not challenged again, so the highest-value rung
 *      is not a solver at all — it is not throwing the session away. This rung is
 *      the caller's: it is satisfied by `prepareBrowser` with an
 *      `isolated_named` profile, and `assessChallenge` reports that.
 *   2. **A different entry.** Many sites gate the web UI but not an API or an
 *      OAuth password flow. That is a judgement the model makes with the
 *      knowledge that the page is gated; this function reports it as an option.
 *   3. **Slow down and retry.** A soft heuristic (a Cloudflare interstitial, a
 *      score-gated v3) sometimes clears on a human cadence. `retryAdvice` says
 *      whether this challenge is that kind and what cadence to use.
 *   4. **A configured solver.** Only for a widget with a site key, only when a
 *      key is configured, and the token is chosen here but injected by the
 *      caller in the page.
 *   5. **Human assist**, opt-in, when nothing above applies.
 *
 * The one invariant: a challenge that was not passed is never reported as
 * passed. Every branch returns state a caller can act on honestly.
 */

export type ChallengePath =
  /** Nothing is gated; carry on. */
  | "not_gated"
  /** Reuse the bot's saved profile so the cookie answers for it. */
  | "existing_session"
  /** Try an API, a mobile route, or a password grant instead of this UI. */
  | "different_entry"
  /** Wait and retry at a human cadence; the gate is a soft heuristic. */
  | "slow_retry"
  /** Ask the configured solver for a token, then inject it. */
  | "solver"
  /** Pause and ask the person who owns the account. */
  | "human";

export interface ChallengeOptions {
  /**
   * The bot's browser keeps a named profile. When true, the session rung is
   * available — which is the cheapest way past a repeat challenge.
   */
  persistentProfile?: boolean;
  /** Whether a solver is configured in this deployment. */
  solver?: CaptchaSolver;
  /** Let a stuck challenge pause the run for a person. Off by default. */
  humanAssist?: boolean;
  /** The bound tab's URL, needed to ask a solver for a token. */
  pageUrl?: string;
  signal?: AbortSignal;
}

export interface ChallengeAssessment {
  detection: CaptchaDetection;
  /** What to say to the model about the gate, in one sentence. */
  description: string;
  /**
   * The mechanisms available **on this page**, in the order to try them. An
   * empty list means nothing here can pass it.
   */
  paths: ChallengePath[];
  /** What to do first. */
  next: ChallengePath;
  /**
   * Advice, not a mechanism: when the gate is on this UI, the same service is
   * often reachable by an API, a mobile route or a password grant. True until a
   * token has been obtained.
   */
  differentEntryAvailable: boolean;
  /** Present when `next` is `slow_retry`: the cadence to use. */
  retryAdvice?: { waitMs: number; attempts: number; why: string };
  /**
   * Present when a token was obtained: the script that installs it in the page,
   * to be run on the bound tab. Absent on every other path, and absent when the
   * solver failed — with `solverOutcome` saying why.
   */
  injectScript?: string;
  solverOutcome?: { ok: boolean; message: string };
  /** Set when only a person can proceed. */
  needsHuman?: { reason: string };
  /**
   * The invariant, spelled out so no caller has to infer it: false until the
   * page has been re-read and shown to be past the gate. A caller must not
   * report the action as complete while this is false.
   */
  passed: false;
}

/**
 * Assess a page and choose the cheapest mechanism available on it.
 *
 * Pure planning by default: it costs no network round trip, so a caller can ask
 * "is this gated and what are my options" on every page read. `solve: true` is
 * an explicit decision to spend a solver round trip now, which is why it takes
 * precedence over the rest of the ladder — the caller has already decided.
 */
export async function assessChallenge(
  page: Pick<CuaPageState, "url" | "title" | "outline" | "refs" | "content">,
  options: ChallengeOptions & { solve?: boolean } = {},
): Promise<ChallengeAssessment> {
  const detection = detectCaptcha({
    frameUrls: collectFrameUrls(page),
    text: [page.outline, ...page.content.map((entry) => entry.value ?? entry.name ?? "")].join("\n"),
    title: page.title,
    html: page.refs.map((ref) => `${ref.role} ${ref.name ?? ""} ${ref.value ?? ""}`).join("\n"),
  });
  const description = describeDetection(detection);

  if (!detection.gated) {
    return {
      detection,
      description,
      paths: ["not_gated"],
      next: "not_gated",
      differentEntryAvailable: false,
      passed: false,
    };
  }

  const solver = options.solver;
  const primary = detection.primary;
  const paths: ChallengePath[] = [];

  // A repeat challenge is answered by the cookie already in the profile, which
  // is why a persisted session is the first rung and not the last.
  if (options.persistentProfile) paths.push("existing_session");
  // A soft heuristic clears on a human cadence; a hard gate never does.
  if (primary?.soft) paths.push("slow_retry");
  if (detection.solvable && solver?.configured) paths.push("solver");
  if (options.humanAssist) paths.push("human");

  const base = {
    detection,
    description,
    paths,
    next: paths[0] ?? ("different_entry" as ChallengePath),
    differentEntryAvailable: true,
    passed: false as const,
  };

  // An explicit solve takes the solver rung now, whatever else is cheaper: the
  // caller decided. Without a configured solver it falls through to the ladder.
  if (options.solve && solver?.configured) {
    if (!detection.solvable || !primary) {
      return {
        ...base,
        solverOutcome: {
          ok: false,
          message: "this challenge has no site key to solve, so a solver cannot return a token for it",
        },
        ...(options.humanAssist ? { needsHuman: { reason: "no solver can pass this challenge; a person must" } } : {}),
      };
    }
    const request = solverRequestFor(detection, options.pageUrl ?? page.url ?? "");
    if (!request) {
      return {
        ...base,
        solverOutcome: { ok: false, message: "the page URL is unknown, so a solver cannot be asked" },
      };
    }
    const result = await solver.solve(request, options.signal ? { signal: options.signal } : {});
    if (!result.ok) {
      return {
        ...base,
        solverOutcome: { ok: false, message: result.message },
        ...(options.humanAssist ? { needsHuman: { reason: result.message } } : {}),
      };
    }
    return {
      ...base,
      injectScript: tokenInjectionScript(primary, result.token),
      solverOutcome: { ok: true, message: `the solver returned a token after ${result.waitedSeconds}s` },
    };
  }

  if (base.next === "slow_retry") {
    return {
      ...base,
      retryAdvice: {
        waitMs: 3000,
        attempts: 2,
        why: `${primary?.kind ?? "the challenge"} is a soft heuristic: pause, re-observe, and only retry the same action at a human cadence`,
      },
    };
  }

  if (base.next === "human") {
    return {
      ...base,
      needsHuman: {
        reason:
          `This page is gated by ${primary?.kind ?? "a challenge"} and no configured path clears it. ` +
          "Pause and ask the person who owns the account.",
      },
    };
  }

  return base;
}

function collectFrameUrls(page: Pick<CuaPageState, "refs" | "content">): string[] {
  const urls: string[] = [];
  for (const ref of [...page.refs, ...page.content]) {
    if (ref.frame && /^(https?:|about:)/.test(ref.frame)) urls.push(ref.frame);
  }
  return urls;
}

/**
 * The default solver for a deployment: configured from the environment, or a
 * solver that honestly says it is not configured.
 */
export function solverFromEnv(env: NodeJS.ProcessEnv = process.env): CaptchaSolver {
  const apiKey = env.CAPTCHA_SOLVER_API_KEY?.trim();
  const provider = env.CAPTCHA_SOLVER_PROVIDER?.trim();
  if (!apiKey || (provider && provider !== "2captcha")) return createSolver(null);
  const baseUrl = env.CAPTCHA_SOLVER_BASE_URL?.trim();
  return createSolver({ provider: "2captcha", apiKey, ...(baseUrl ? { baseUrl } : {}) });
}
