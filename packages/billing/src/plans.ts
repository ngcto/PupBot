import { z } from "zod";

/**
 * Plans, as configured by the operator. A plan names one Polar product; the
 * price lives on the Polar product and is never copied into this repo, so the
 * only thing here is the reference and the copy a user reads.
 *
 * `POLAR_PLANS` is a JSON array in `.env`:
 *
 *   POLAR_PLANS=[{"id":"pro","label":"Pro","productId":"<polar product id>"}]
 */
export const planSchema = z.object({
  /** Stable id used in our own URLs and rows. Never a product id. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "a plan id is lowercase letters, digits and dashes"),
  /** What a person reads. */
  label: z.string().min(1).max(80),
  /** One line on what the plan is for; optional so a one-plan setup stays short. */
  description: z.string().max(200).optional(),
  /** Polar's product id (dashboard → Products → Copy Product ID). */
  productId: z.string().min(1).max(120),
});

export const plansSchema = z.array(planSchema).min(1).max(10);

export type Plan = z.infer<typeof planSchema>;

export class PlansConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlansConfigError";
  }
}

/**
 * Parses `POLAR_PLANS`. An unset or empty value means "no plans configured",
 * which is not an error: the gate stays off and nothing about the product
 * changes.
 */
export function parsePlans(raw: string | undefined): Plan[] {
  const text = raw?.trim();
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PlansConfigError("POLAR_PLANS must be a JSON array of plans");
  }
  const parsed = plansSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new PlansConfigError(`POLAR_PLANS is invalid — ${detail}`);
  }
  const ids = new Set(parsed.data.map((plan) => plan.id));
  if (ids.size !== parsed.data.length) throw new PlansConfigError("POLAR_PLANS has two plans with the same id");
  return parsed.data;
}
