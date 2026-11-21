import type { CaptchaDetection, CaptchaKind, CaptchaSignal } from "../types.ts";

/**
 * The hard-challenge rung: hand the widget to a commercial solver the user has
 * a key for, and inject the token it returns.
 *
 * What is deliberately here, and what is deliberately not:
 *
 * - **The provider is configuration, not code.** One adapter is implemented
 *   (2captcha's **task API v2**, which is the current interface), and the seam
 *   for others is `CaptchaSolver` — a two-method interface. A solver's terms are
 *   theirs; we do not bundle them, we do not pick one for a user, and we do not
 *   hardcode a key.
 * - **No key, no solver.** Without `CAPTCHA_SOLVER_API_KEY` the function returns
 *   a clear "not configured" result, and the caller reports to its owner that a
 *   human is needed. It never silently pretends the challenge passed.
 * - **The key never leaves the server.** It goes into one outbound request from
 *   the process holding the key and is never logged, never returned, never put
 *   in a tool result or a run event.
 *
 * Scope, once and plainly: this exists so a bot can operate services its owner
 * already has an account on. It is not for mass account creation and not for
 * defeating a site's controls where you have no account.
 *
 * ## The wire protocol, as it actually is
 *
 * 2captcha has two incompatible interfaces and they are easy to conflate:
 *
 * - **Legacy** (`2captcha.com/in.php`, `/res.php`): form-encoded, numeric
 *   `status`, a bare `OK|<token>` text response.
 * - **Task API v2** (`api.2captcha.com/createTask`, `/getTaskResult`): JSON
 *   bodies, `clientKey`, `errorId` + `taskId` on creation, and
 *   `status: "processing" | "ready"` on polling.
 *
 * This adapter speaks **only** the task API. Mixing a form field into a JSON
 * request, or reading a numeric status out of a string status, produces an
 * adapter that looks plausible and cannot obtain a token with a real key.
 */

/** Which solver API shape to speak. One implemented; the rest are the seam. */
export type SolverProvider = "2captcha";

export interface SolverConfig {
  provider: SolverProvider;
  apiKey: string;
  /** Overridable for tests, and for a compatible self-hosted endpoint. */
  baseUrl?: string;
  /** How long to wait for a token, in seconds. Bounds every request too. */
  timeoutSeconds?: number;
}

export interface SolverRequest {
  kind: CaptchaKind;
  siteKey: string;
  pageUrl: string;
  /** The widget's own action, for reCAPTCHA v3 and Cloudflare challenge pages. */
  action?: string;
  /** reCAPTCHA v3 score threshold the page is checking against. */
  minScore?: number;
  /** Any extra key/value the vendor's API needs, such as `cData` or `pagedata`. */
  extra?: Record<string, string>;
}

export type SolverResult =
  | { ok: true; token: string; provider: SolverProvider; waitedSeconds: number }
  /**
   * `not_configured` is the honest answer when no key exists, and it is a
   * different thing from a challenge the vendor could not solve.
   */
  | { ok: false; reason: "not_configured" | "unsupported_kind" | "solver_error" | "timeout" | "no_token"; message: string };

/** The seam. Anything that can do these two things is a solver. */
export interface CaptchaSolver {
  readonly provider: SolverProvider;
  readonly configured: boolean;
  solve(request: SolverRequest, options?: { signal?: AbortSignal }): Promise<SolverResult>;
}

/** The task API's base. The legacy host (`2captcha.com`) is a different API. */
const DEFAULT_BASE_URL = "https://api.2captcha.com";

/** The task API asks for at least this long between polls. */
const POLL_INTERVAL_MS = 5000;

/** Read the deployment's solver configuration. Never throws on absence. */
export function solverConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SolverConfig | null {
  const apiKey = env.CAPTCHA_SOLVER_API_KEY?.trim();
  if (!apiKey) return null;
  const provider = (env.CAPTCHA_SOLVER_PROVIDER?.trim() || "2captcha") as SolverProvider;
  if (provider !== "2captcha") return null;
  const baseUrl = env.CAPTCHA_SOLVER_BASE_URL?.trim();
  return {
    provider,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** Maps our kind onto the vendor's task type name. */
const TASK_TYPES: Partial<Record<CaptchaKind, string>> = {
  recaptcha_v2_checkbox: "RecaptchaV2TaskProxyless",
  recaptcha_v2_invisible: "RecaptchaV2TaskProxyless",
  recaptcha_v3: "RecaptchaV3TaskProxyless",
  recaptcha_enterprise: "RecaptchaV2EnterpriseTaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  turnstile: "TurnstileTaskProxyless",
};

/**
 * The body of a `createTask` call for our kind.
 *
 * Exported so the request shape is assertable in a unit test without a network
 * call, which is what stops the two protocols drifting back together.
 */
export function taskBody(request: SolverRequest, clientKey: string): Record<string, unknown> | null {
  const type = TASK_TYPES[request.kind];
  if (!type) return null;
  return {
    clientKey,
    task: {
      type,
      websiteURL: request.pageUrl,
      websiteKey: request.siteKey,
      // v3 needs the page action and the score the page checks against. The task
      // API names the action `pageAction`; sending `action` is silently ignored.
      ...(request.kind === "recaptcha_v3"
        ? { pageAction: request.action ?? "verify", minScore: request.minScore ?? 0.7 }
        : {}),
      ...(request.extra ?? {}),
    },
  };
}

interface CreateTaskReply {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number | string;
}

interface GetTaskResultReply {
  errorId?: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  solution?: Record<string, unknown>;
}

/** The token in a `solution`, whichever field this task type uses. */
export function tokenFromSolution(solution: Record<string, unknown> | undefined): string | undefined {
  if (!solution) return undefined;
  const value = solution.gRecaptchaResponse ?? solution.token;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A solver over the task API, or a configured-but-disabled one.
 *
 * Every request is bounded by the deadline, not just the loop: a vendor that
 * stalls mid-request must not leave `solve()` pending past its own advertised
 * ceiling inside a run that has a wall clock.
 */
export function createSolver(config: SolverConfig | null, fetchImpl: typeof fetch = fetch): CaptchaSolver {
  if (!config) {
    return {
      provider: "2captcha",
      configured: false,
      async solve() {
        return {
          ok: false,
          reason: "not_configured",
          message:
            "No CAPTCHA solver is configured, so this challenge cannot be solved. " +
            "Set CAPTCHA_SOLVER_API_KEY and CAPTCHA_SOLVER_PROVIDER to use one, or handle the page another way.",
        };
      },
    };
  }

  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutSeconds = config.timeoutSeconds ?? 180;

  return {
    provider: config.provider,
    configured: true,
    async solve(request, options = {}) {
      if (!TASK_TYPES[request.kind]) {
        return {
          ok: false,
          reason: "unsupported_kind",
          message: `${request.kind} has no token to inject, so no solver can pass it.`,
        };
      }
      if (!request.siteKey) {
        return { ok: false, reason: "solver_error", message: "this challenge exposes no site key to solve" };
      }

      // An abort that already happened never replays as an event, and the
      // request controller below starts un-aborted — so check it explicitly, or
      // a cancelled run would still create a paid task and keep polling.
      if (options.signal?.aborted) throw new Error("aborted");

      const started = Date.now();
      const deadline = started + timeoutSeconds * 1000;

      const post = async (path: string, body: unknown): Promise<Record<string, unknown> | null> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        // The deadline rides on the request itself, so a stalled socket cannot
        // outlive it; the caller's signal still cancels earlier.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        const onCallerAbort = () => controller.abort();
        options.signal?.addEventListener("abort", onCallerAbort, { once: true });
        try {
          const response = await fetchImpl(`${base}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!response.ok) {
            return { errorId: -1, errorDescription: `HTTP ${response.status} from the solver` };
          }
          return (await response.json()) as Record<string, unknown>;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return {
            errorId: -1,
            errorDescription: error instanceof Error ? error.message : "the solver request failed",
          };
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onCallerAbort);
        }
      };

      try {
        const created = (await post("/createTask", taskBody(request, config.apiKey))) as CreateTaskReply | null;
        if (!created) {
          return { ok: false, reason: "timeout", message: `the solver did not accept a task within ${timeoutSeconds}s` };
        }
        if (created.errorId !== 0 || created.taskId === undefined) {
          // `errorCode` is the vendor's vocabulary; the key is never echoed back.
          return {
            ok: false,
            reason: "solver_error",
            message: `the solver refused the task: ${created.errorCode ?? created.errorDescription ?? "unknown"}`,
          };
        }

        const taskId = created.taskId;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return {
              ok: false,
              reason: "timeout",
              message: `the solver did not return a token within ${timeoutSeconds}s`,
            };
          }
          await sleep(Math.min(POLL_INTERVAL_MS, remaining), options.signal);

          const polled = (await post("/getTaskResult", {
            clientKey: config.apiKey,
            taskId,
          })) as GetTaskResultReply | null;
          if (!polled) {
            return {
              ok: false,
              reason: "timeout",
              message: `the solver did not answer a poll within ${timeoutSeconds}s`,
            };
          }
          if (polled.errorId !== 0 && polled.errorId !== undefined) {
            return {
              ok: false,
              reason: "solver_error",
              message: `the solver failed: ${polled.errorCode ?? polled.errorDescription ?? "unknown"}`,
            };
          }
          if (polled.status === "ready") {
            const token = tokenFromSolution(polled.solution);
            if (!token) {
              return { ok: false, reason: "no_token", message: "the solver reported ready without a token" };
            }
            return {
              ok: true,
              token,
              provider: config.provider,
              waitedSeconds: Math.round((Date.now() - started) / 1000),
            };
          }
          // `processing` is the only other documented status; anything else is a
          // vendor change this build should report rather than spin on.
          if (polled.status !== "processing") {
            return {
              ok: false,
              reason: "solver_error",
              message: `the solver returned an unexpected status: ${String(polled.status ?? "none")}`,
            };
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return {
          ok: false,
          reason: "solver_error",
          message: error instanceof Error ? error.message : "the solver request failed",
        };
      }
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The injection script for a solved token.
 *
 * A solver returns a token; the page's own widget is what is still unsolved.
 * Writing the token into the field the widget reads, and firing the callback the
 * page registered, is the documented bridge — and it is done **inside the
 * page** through the driver's browser context, never by a second browser.
 *
 * It returns a script, not a side effect, because the caller already owns the
 * "run this on the bound tab" primitive. Keeping the two apart is what lets the
 * whole ladder be unit-tested without a desktop.
 */
export function tokenInjectionScript(signal: CaptchaSignal, token: string): string {
  const key = signal.siteKey ? JSON.stringify(signal.siteKey) : "null";
  const value = JSON.stringify(token);
  switch (signal.kind) {
    case "hcaptcha":
      // The response field alone is not enough: a form that enables its submit
      // from `data-callback` only reacts when the page's own callback receives
      // the token, and `hcaptcha.execute` does not deliver one.
      return `(() => {
  const h = document.querySelector('textarea[name="h-captcha-response"], textarea#h-captcha-response');
  if (h) h.value = ${value};
  const widget = document.querySelector('[data-callback], .h-captcha');
  const name = widget && widget.getAttribute('data-callback');
  let fired = false;
  if (name && typeof window[name] === 'function') { try { window[name](${value}); fired = true; } catch {} }
  const id = ${key} || (widget && widget.getAttribute('data-sitekey'));
  if (window.hcaptcha && id) {
    try { window.hcaptcha.getResponse = () => ${value}; } catch {}
    try { window.hcaptcha.execute(id, { async: false }); } catch {}
  }
  return !!h || fired;
})()`;
    case "turnstile":
      return `(() => {
  const t = document.querySelector('textarea[name="cf-turnstile-response"], input[name="cf-turnstile-response"]');
  if (t) t.value = ${value};
  const cb = document.querySelector('[data-callback]');
  const name = cb && cb.getAttribute('data-callback');
  if (name && typeof window[name] === 'function') { try { window[name](${value}); } catch {} }
  return !!t;
})()`;
    default:
      // reCAPTCHA v2 / v3 / enterprise all read the same textarea, and the page
      // registers its own callback that must be told the token arrived.
      return `(() => {
  const a = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
  if (a) a.value = ${value};
  const cfg = window.___grecaptcha_cfg;
  let fired = false;
  if (cfg && cfg.clients) {
    for (const key of Object.keys(cfg.clients)) {
      const client = cfg.clients[key];
      if (!client) continue;
      for (const sub of Object.keys(client)) {
        const cb = client[sub] && client[sub].callback;
        if (typeof cb === 'function') { try { cb(${value}); fired = true; } catch {} }
      }
    }
  }
  return !!a || fired;
})()`;
  }
}

/** The page URL to report to a solver: whatever the bound tab is on. */
export function solverRequestFor(detection: CaptchaDetection, pageUrl: string): SolverRequest | null {
  const signal = detection.primary;
  // A task with an empty `websiteURL` is invalid, and the vendor would take the
  // money before saying so. Refusing here keeps the caller on its local
  // explanation instead of spending a task on a guess.
  if (!signal || !signal.siteKey || !detection.solvable) return null;
  if (!/^https?:\/\//i.test(pageUrl)) return null;
  return {
    kind: signal.kind,
    siteKey: signal.siteKey,
    pageUrl,
  };
}
