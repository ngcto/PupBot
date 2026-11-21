import { describe, expect, it } from "vitest";
import { verifyWebhook, signWebhook } from "../src/webhook.ts";

const SECRET = `whsec_${Buffer.from("a-test-webhook-key-32-bytes-long!").toString("base64")}`;
const BODY = JSON.stringify({ type: "subscription.active", data: { id: "sub_1", status: "active" } });
const NOW = 1_800_000_000;

function headers(id = "msg_1", timestamp = String(NOW)) {
  return { id, timestamp, signature: signWebhook(BODY, { id, timestamp }, SECRET) };
}

describe("polar webhook verification", () => {
  it("accepts a correctly signed Standard Webhooks delivery", () => {
    expect(verifyWebhook(BODY, headers(), SECRET, NOW)).toEqual({ ok: true });
  });

  it("accepts the legacy Polar HMAC key for deliveries signed before the cutover", () => {
    const id = "msg_legacy";
    const timestamp = String(NOW);
    const signature = signWebhook(BODY, { id, timestamp }, SECRET, "legacy");
    expect(verifyWebhook(BODY, { id, timestamp, signature }, SECRET, NOW)).toEqual({ ok: true });
  });

  it("rejects a body that changed after signing", () => {
    const signed = headers();
    const tampered = BODY.replace("active", "revoked");
    expect(verifyWebhook(tampered, signed, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with another secret", () => {
    const other = `whsec_${Buffer.from("a-different-key-that-is-also-32-bytes").toString("base64")}`;
    const id = "msg_2";
    const timestamp = String(NOW);
    const signature = signWebhook(BODY, { id, timestamp }, other);
    expect(verifyWebhook(BODY, { id, timestamp, signature }, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a replayed delivery whose timestamp is too old", () => {
    const id = "msg_3";
    const timestamp = String(NOW - 3600);
    const signature = signWebhook(BODY, { id, timestamp }, SECRET);
    expect(verifyWebhook(BODY, { id, timestamp, signature }, SECRET, NOW)).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("reports missing headers rather than throwing", () => {
    expect(verifyWebhook(BODY, { id: null, timestamp: null, signature: null }, SECRET, NOW)).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("accepts a versioned v1 signature prefix", () => {
    const id = "msg_4";
    const timestamp = String(NOW);
    const signature = `v1,${signWebhook(BODY, { id, timestamp }, SECRET)}`;
    expect(verifyWebhook(BODY, { id, timestamp, signature }, SECRET, NOW)).toEqual({ ok: true });
  });
});

describe("plans", () => {
  it("round-trips a valid plan list", async () => {
    const { parsePlans } = await import("../src/plans.ts");
    const plans = parsePlans(JSON.stringify([{ id: "pro", label: "Pro", productId: "prod_1" }]));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe("pro");
  });

  it("treats an unset value as no plans instead of an error", async () => {
    const { parsePlans } = await import("../src/plans.ts");
    expect(parsePlans(undefined)).toEqual([]);
    expect(parsePlans("   ")).toEqual([]);
  });

  it("refuses malformed JSON with a message naming the variable", async () => {
    const { parsePlans, PlansConfigError } = await import("../src/plans.ts");
    expect(() => parsePlans("{not json")).toThrow(PlansConfigError);
  });

  it("refuses two plans sharing an id", async () => {
    const { parsePlans, PlansConfigError } = await import("../src/plans.ts");
    const raw = JSON.stringify([
      { id: "pro", label: "Pro", productId: "prod_1" },
      { id: "pro", label: "Pro again", productId: "prod_2" },
    ]);
    expect(() => parsePlans(raw)).toThrow(PlansConfigError);
  });
});
