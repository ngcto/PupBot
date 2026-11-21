import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Polar webhook signature verification.
 *
 * Polar signs deliveries with Standard Webhooks (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`). The signed content is
 * `${id}.${timestamp}.${body}` and the key is the base64-decoded `whsec_…`
 * secret. Deliveries signed before the 2026-09-08 cutover use the older Polar
 * HMAC scheme, where the key is the UTF-8 bytes of the whole `whsec_…` string.
 * Both are tried, newest first, which is what Polar's own SDKs do.
 *
 * https://polar.sh/docs/integrate/webhooks/delivery
 */

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export type VerifyFailure = "missing_headers" | "bad_signature" | "stale_timestamp";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

/** Five minutes, matching Standard Webhooks' recommended tolerance. */
const TOLERANCE_SECONDS = 300;

function keyFromSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  const bare = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  return Buffer.from(bare, "base64");
}

function legacyKey(secret: string): Buffer {
  return Buffer.from(secret.trim(), "utf8");
}

function sign(key: Buffer, content: string): string {
  return createHmac("sha256", key).update(content).digest("base64");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifies one delivery. `nowSeconds` is injectable so the staleness rule can be
 * tested without waiting.
 */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "bad_signature" };
  if (Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const content = `${id}.${timestamp}.${rawBody}`;
  // A delivery carries one `webhook-signature` header, but Standard Webhooks
  // allows a space-separated set of versioned signatures.
  const candidates = signature
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("v1,") ? entry.slice(3) : entry));

  for (const candidate of candidates) {
    if (equal(candidate, sign(keyFromSecret(secret), content))) return { ok: true };
    if (equal(candidate, sign(legacyKey(secret), content))) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

/** Builds a valid signature, for tests and for a local `polar webhook trigger` replay. */
export function signWebhook(
  rawBody: string,
  headers: { id: string; timestamp: string },
  secret: string,
  scheme: "standard" | "legacy" = "standard",
): string {
  const key = scheme === "standard" ? keyFromSecret(secret) : legacyKey(secret);
  return sign(key, `${headers.id}.${headers.timestamp}.${rawBody}`);
}
