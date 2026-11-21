import type { ServerEnv } from "@terabot/config";
import { z } from "zod";

/**
 * The slice of Polar's REST API this product needs: create a checkout session,
 * and read a customer's state. Nothing else, and no SDK — the two calls are
 * small enough that a dependency would be more surface than it is worth.
 *
 * https://polar.sh/docs/api-reference/2026-10/introduction
 * https://polar.sh/docs/features/checkout/session
 */

export const POLAR_API = "https://api.polar.sh/v1";
export const POLAR_SANDBOX_API = "https://sandbox-api.polar.sh/v1";

export class PolarError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(message: string, options: { status?: number | null; code?: string } = {}) {
    super(message);
    this.name = "PolarError";
    this.status = options.status ?? null;
    this.code = options.code ?? "polar_error";
  }
}

export interface PolarClientOptions {
  token: string;
  /** Sandbox or production, from `POLAR_SERVER` (default `production`). */
  sandbox?: boolean;
  fetch?: typeof fetch;
}

export interface CreateCheckoutInput {
  /** Polar product ids; the plan chooses one. */
  products: string[];
  /** Our user id, so the customer comes back linked to the account. */
  externalCustomerId: string;
  customerEmail?: string;
  successUrl: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

const checkoutSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
});

const subscriptionSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  product_id: z.string().min(1),
  current_period_end: z.string().nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
});

const customerStateSchema = z.object({
  id: z.string().min(1),
  active_subscriptions: z.array(subscriptionSchema).default([]),
});

export type CustomerState = z.infer<typeof customerStateSchema>;
export type PolarSubscription = z.infer<typeof subscriptionSchema>;

/** Polar reports failures as `{ error, detail }`; never echo the token back. */
async function readError(response: Response): Promise<PolarError> {
  let detail = `Polar answered ${response.status}`;
  try {
    const body = (await response.json()) as { detail?: unknown; error?: unknown };
    const text = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : null;
    if (text) detail = text;
  } catch {
    /* a non-JSON body keeps the status message */
  }
  return new PolarError(detail, {
    status: response.status,
    code: response.status === 401 ? "polar_unauthorized" : response.status === 404 ? "polar_not_found" : "polar_error",
  });
}

export function createPolarClient(options: PolarClientOptions) {
  const base = options.sandbox ? POLAR_SANDBOX_API : POLAR_API;
  const doFetch = options.fetch ?? fetch;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw await readError(response);
    return response.json();
  }

  return {
    async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
      const body = {
        products: input.products,
        external_customer_id: input.externalCustomerId,
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        success_url: input.successUrl,
      };
      const raw = await request("/checkouts/", { method: "POST", body: JSON.stringify(body) });
      const parsed = checkoutSchema.safeParse(raw);
      if (!parsed.success) {
        throw new PolarError("Polar returned a checkout without a url", { code: "polar_bad_response" });
      }
      return { id: parsed.data.id, url: parsed.data.url };
    },

    /** The customer's current subscriptions, by our own user id. */
    async customerState(externalCustomerId: string): Promise<CustomerState | null> {
      try {
        const raw = await request(`/customers/external/${encodeURIComponent(externalCustomerId)}/state`, {
          method: "GET",
        });
        const parsed = customerStateSchema.safeParse(raw);
        if (!parsed.success) {
          throw new PolarError("Polar returned an unexpected customer state", { code: "polar_bad_response" });
        }
        return parsed.data;
      } catch (error) {
        // No customer yet is a normal answer for someone who never checked out.
        if (error instanceof PolarError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

export type PolarClient = ReturnType<typeof createPolarClient>;

/** Where a checkout sends the person afterwards: Settings → Billing on our own origin. */
export function billingReturnUrl(env: ServerEnv, outcome: "success" | "canceled"): string {
  // Trimming a trailing slash without a regex: the input is operator config, and
  // a pattern here is a needless thing for a scanner to reason about.
  let origin = env.BETTER_AUTH_URL;
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  return `${origin}/settings/billing?checkout=${outcome}`;
}
