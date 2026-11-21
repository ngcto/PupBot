import { describe, expect, it } from "vitest";
import { resolveDeepLink } from "../src/shared/deeplink.ts";

const APP_URL = new URL("https://app.terabot.ai");

function target(raw: string, appUrl = APP_URL): string | undefined {
  const result = resolveDeepLink(raw, appUrl);
  return result.ok ? result.link.target.toString() : undefined;
}

describe("resolveDeepLink", () => {
  it("maps a sign-in return onto the product's own callback route", () => {
    const result = resolveDeepLink("terabot://auth/callback?code=abc&state=xyz", APP_URL);
    expect(result.ok && result.link.kind).toBe("auth");
    expect(target("terabot://auth/callback?code=abc&state=xyz")).toBe(
      "https://app.terabot.ai/auth/callback?code=abc&state=xyz",
    );
  });

  it("maps better-auth's provider callback, which the product already serves", () => {
    expect(target("terabot://api/auth/callback/github?code=abc&state=xyz")).toBe(
      "https://app.terabot.ai/api/auth/callback/github?code=abc&state=xyz",
    );
  });

  it("keeps the fragment, for flows that carry the result there", () => {
    expect(target("terabot://auth/callback#access_token=abc")).toBe(
      "https://app.terabot.ai/auth/callback#access_token=abc",
    );
  });

  it("opens a product path for non-auth links", () => {
    const result = resolveDeepLink("terabot://b/bot_123?tab=chat", APP_URL);
    expect(result.ok && result.link.kind).toBe("path");
    expect(target("terabot://b/bot_123?tab=chat")).toBe("https://app.terabot.ai/b/bot_123?tab=chat");
  });

  it("keeps a product served under a path prefix", () => {
    expect(target("terabot://auth/callback?code=abc", new URL("https://terabot.ai/desktop"))).toBe(
      "https://terabot.ai/desktop/auth/callback?code=abc",
    );
  });

  it("is case-insensitive about the scheme and segment", () => {
    expect(target("TERABOT://AUTH/callback")).toBe("https://app.terabot.ai/auth/callback");
  });

  it("never leaves the product origin", () => {
    for (const raw of [
      "terabot://auth/../../../etc/passwd",
      "terabot://auth/%2e%2e/%2e%2e/evil",
      "terabot://auth//evil.com/callback",
      "terabot://auth/callback?next=https://evil.com",
    ]) {
      const resolved = target(raw);
      expect(resolved, raw).toBeDefined();
      expect(new URL(resolved as string).origin, raw).toBe(APP_URL.origin);
    }
  });

  it("refuses a host that is not a single safe path segment", () => {
    for (const raw of [
      "terabot://evil.com/callback",
      "terabot://user:pass@auth/callback",
      "terabot://auth:8443/callback",
      "terabot://-auth/callback",
      "terabot://auth!/callback",
    ]) {
      expect(resolveDeepLink(raw, APP_URL), raw).toMatchObject({ ok: false, reason: "unsafe-segment" });
    }
  });

  it("refuses other protocols, opaque links and junk", () => {
    expect(resolveDeepLink("https://app.terabot.ai/auth/callback", APP_URL)).toEqual({
      ok: false,
      reason: "not-our-protocol",
    });
    expect(resolveDeepLink("javascript:alert(1)", APP_URL)).toEqual({ ok: false, reason: "not-our-protocol" });
    expect(resolveDeepLink("terabot:auth/callback", APP_URL)).toEqual({ ok: false, reason: "opaque" });
    expect(resolveDeepLink("", APP_URL)).toEqual({ ok: false, reason: "empty" });
    expect(resolveDeepLink("   ", APP_URL)).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses an oversized link", () => {
    expect(resolveDeepLink(`terabot://auth/callback?code=${"a".repeat(4096)}`, APP_URL)).toEqual({
      ok: false,
      reason: "too-long",
    });
  });
});
