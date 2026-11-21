import { applyWebhookEvent, verifyWebhook } from "@terabot/billing";
import { serverEnv } from "@terabot/config";

/**
 * Polar's webhook endpoint.
 *
 * Public by design — it is authenticated by the signature, not by a session.
 * The raw body is read before any parsing because the signature covers exactly
 * those bytes.
 *
 * Answers 2xx for anything it accepts, including events it ignores: Polar
 * disables an endpoint after 10 consecutive non-2xx responses, and a redelivery
 * of an event we do not use would otherwise count against us.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const env = serverEnv();
  if (!env.POLAR_WEBHOOK_SECRET) {
    // Not configured: there is nothing this deployment could verify against.
    return Response.json({ error: "billing_not_configured" }, { status: 404 });
  }

  const rawBody = await request.text();
  const verdict = verifyWebhook(
    rawBody,
    {
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    },
    env.POLAR_WEBHOOK_SECRET,
  );
  if (!verdict.ok) {
    // 403 tells Polar the delivery failed loudly, which is what a forged or
    // replayed request deserves. The reason is logged, never returned.
    console.warn(`[billing] webhook rejected: ${verdict.reason}`);
    return Response.json({ error: "invalid_signature" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const outcome = await applyWebhookEvent(payload, env);
  return Response.json({ ok: true, handled: outcome.handled, reason: outcome.reason ?? null }, { status: 202 });
}
