import type { CaptchaDetection, CaptchaKind, CaptchaSignal } from "../types.ts";

/**
 * The hard-challenge rung: hand the widget to a commercial solver the user has
 * a key for, and inject the token it returns.
 *
 * What is deliberately here, and what is deliberately not:
 *
 * - **The provider is configuration, not code.** One adapter is implemented
 *   (2captcha's task API, which is the widest-supported public interface), and
 *   the seam for others is `CaptchaSolver` — a two-method interface. A solver's
 *   terms are theirs; we do not bundle them, we do not pick one for a user, and
 *   we do not hardcode a key.
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
 */

/** Which solver API shape to speak. One implemented; the rest are the seam. */
export type SolverProvider = "2captcha";

export interface SolverConfig {
  provider: SolverProvider;
  apiKey: string;
  /** Overridable for tests, and for a compatible self-hosted endpoint. */
  baseUrl?: string;
  /** How long to wait for a token, in seconds. */
  timeoutSeconds?: number;
}

export interface SolverRequest {
  kind: CaptchaKind;
  siteKey: string;
  pageUrl: string;
  /** The widget's own action, for reCAPTCHA v3, when the page names one. */
  action?: string;
  /** reCAPTCHA v3 score threshold the page is checking against. */
  minScore?: number;
  /** Any extra key/value the vendor's API needs, such as `data-s`. */
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
  recaptcha_enterprise: "RecaptchaV2TaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  turnstile: "TurnstileTaskProxyless",
};

/**
 * A solver over one vendor's HTTP API, or a configured-but-disabled one.
 *
 * The polling loop is bounded by the caller's timeout rather than by a fixed
 * number of attempts, because a vendor's own latency is not ours to predict.
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

  const base = (config.baseUrl ?? "https://2captcha.com").replace(/\/+$/, "");
  const timeoutSeconds = config.timeoutSeconds ?? 180;

  return {
    provider: config.provider,
    configured: true,
    async solve(request, options = {}) {
      const taskType = TASK_TYPES[request.kind];
      if (!taskType) {
        return {
          ok: false,
          reason: "unsupported_kind",
          message: `${request.kind} has no token to inject, so no solver can pass it.`,
        };
      }
      if (!request.siteKey) {
        return { ok: false, reason: "solver_error", message: "this challenge exposes no site key to solve" };
      }

      const started = Date.now();
      const create = new URLSearchParams({
        key: config.apiKey,
        method: "createTask",
        json: "1",
        task: JSON.stringify({
          type: taskType,
          websiteURL: request.pageUrl,
          websiteKey: request.siteKey,
          ...(request.kind === "recaptcha_v3"
            ? { pageAction: request.action ?? "verify", minScore: request.minScore ?? 0.7 }
            : {}),
          ...(request.extra ?? {}),
        }),
      });

      try {
        const created = await fetchImpl(`${base}/createTask`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: create.toString(),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const createdBody = (await created.json()) as { status?: number; taskId?: number | string; request?: string };
        if (createdBody.status !== 1 || createdBody.taskId === undefined) {
          // `request` is the vendor's error code; the key is never echoed back.
          return {
            ok: false,
            reason: "solver_error",
            message: `the solver refused the task: ${String(createdBody.request ?? "unknown")}`,
          };
        }

        const taskId = String(createdBody.taskId);
        for (;;) {
          if (Date.now() - started > timeoutSeconds * 1000) {
            return {
              ok: false,
              reason: "timeout",
              message: `the solver did not return a token within ${timeoutSeconds}s`,
            };
          }
          await sleep(5000, options.signal);
          const poll = await fetchImpl(
            `${base}/getTaskResult?${new URLSearchParams({ key: config.apiKey, taskId, json: "1" }).toString()}`,
            options.signal ? { signal: options.signal } : {},
          );
          const pollBody = (await poll.json()) as {
            status?: number;
            request?: string;
            solution?: { gRecaptchaResponse?: string; token?: string };
          };
          if (pollBody.status === 1) {
            const token = pollBody.solution?.gRecaptchaResponse ?? pollBody.solution?.token;
            if (!token) return { ok: false, reason: "no_token", message: "the solver reported success without a token" };
            return {
              ok: true,
              token,
              provider: config.provider,
              waitedSeconds: Math.round((Date.now() - started) / 1000),
            };
          }
          if (pollBody.request && pollBody.request !== "CAPCHA_NOT_READY") {
            return { ok: false, reason: "solver_error", message: `the solver failed: ${pollBody.request}` };
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
 * Writing the token into the textarea the widget reads, and firing the callback
 * the page registered, is the documented bridge — and it is done **inside the
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
      return `(() => {
  const h = document.querySelector('textarea[name="h-captcha-response"], textarea#h-captcha-response');
  if (h) h.value = ${value};
  const frame = document.querySelector('iframe[src*="hcaptcha"]');
  const id = ${key} || (document.querySelector('[data-sitekey]') || {}).dataset?.sitekey;
  if (window.hcaptcha && id) {
    try { window.hcaptcha.getResponse = () => ${value}; } catch {}
    try { window.hcaptcha.execute(id, { async: false }); } catch {}
  }
  return !!h;
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
  if (!signal || !signal.siteKey) return null;
  return {
    kind: signal.kind,
    siteKey: signal.siteKey,
    pageUrl,
  };
}
