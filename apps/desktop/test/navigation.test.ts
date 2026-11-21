import { describe, expect, it } from "vitest";
import { decideNavigation, decideWindowOpen, isAppOrigin } from "../src/shared/navigation.ts";

const ORIGINS = ["https://app.terabot.ai"];

describe("decideNavigation", () => {
  it("allows the product origin, whatever the path", () => {
    expect(decideNavigation("https://app.terabot.ai/", ORIGINS)).toEqual({ action: "allow" });
    expect(decideNavigation("https://app.terabot.ai/b/bot_123?tab=chat", ORIGINS)).toEqual({ action: "allow" });
    expect(decideNavigation("https://app.terabot.ai/api/auth/callback/github?code=x", ORIGINS)).toEqual({
      action: "allow",
    });
  });

  it("treats a differently-cased host as the same origin", () => {
    expect(decideNavigation("https://APP.TeraBot.ai/b/1", ORIGINS)).toEqual({ action: "allow" });
  });

  it("allows an explicitly configured second origin", () => {
    expect(decideNavigation("https://www.terabot.ai/", ["https://app.terabot.ai", "https://www.terabot.ai"])).toEqual({
      action: "allow",
    });
  });

  it("sends any other web page to the system browser", () => {
    expect(decideNavigation("https://example.com/", ORIGINS)).toEqual({
      action: "external",
      url: "https://example.com/",
    });
    expect(decideNavigation("http://localhost:8787/health", ORIGINS)).toEqual({
      action: "external",
      url: "http://localhost:8787/health",
    });
  });

  it("does not mistake a lookalike host for the product", () => {
    expect(decideNavigation("https://app.terabot.ai.evil.com/", ORIGINS).action).toBe("external");
    expect(decideNavigation("https://app.terabot.ai@evil.com/", ORIGINS).action).toBe("block");
    expect(decideNavigation("http://app.terabot.ai/", ORIGINS).action).toBe("external");
  });

  it("sends mail and telephone links to the system", () => {
    expect(decideNavigation("mailto:hello@terabot.ai", ORIGINS)).toEqual({
      action: "external",
      url: "mailto:hello@terabot.ai",
    });
    expect(decideNavigation("tel:+15551234567", ORIGINS)).toEqual({ action: "external", url: "tel:+15551234567" });
  });

  it("blocks schemes that can run code or read the disk", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "blob:https://app.terabot.ai/1234",
      "chrome://settings",
      "smb://server/share",
    ]) {
      expect(decideNavigation(url, ORIGINS), url).toEqual({ action: "block", reason: "unsupported-scheme" });
    }
  });

  it("blocks a product URL that hides credentials", () => {
    expect(decideNavigation("https://user:pass@app.terabot.ai/", ORIGINS)).toEqual({
      action: "block",
      reason: "credentials-in-url",
    });
  });

  it("blocks unparseable and oversized input", () => {
    expect(decideNavigation("not a url", ORIGINS)).toEqual({ action: "block", reason: "invalid-url" });
    expect(decideNavigation("", ORIGINS)).toEqual({ action: "block", reason: "invalid-url" });
    expect(decideNavigation(`https://app.terabot.ai/${"a".repeat(5000)}`, ORIGINS)).toEqual({
      action: "block",
      reason: "invalid-url",
    });
  });

  it("treats an empty allow-list as block-or-external, never allow", () => {
    expect(decideNavigation("https://app.terabot.ai/", []).action).toBe("external");
  });
});

describe("decideWindowOpen", () => {
  it("keeps a same-origin popup inside the shell", () => {
    expect(decideWindowOpen("https://app.terabot.ai/settings", ORIGINS)).toEqual({ action: "allow-child" });
  });

  it("refuses a foreign popup and hands web links to the browser", () => {
    expect(decideWindowOpen("https://example.com/", ORIGINS)).toEqual({
      action: "external",
      url: "https://example.com/",
    });
  });

  it("refuses popups that are not web pages", () => {
    expect(decideWindowOpen("data:text/html,hi", ORIGINS)).toEqual({ action: "block", reason: "unsupported-scheme" });
    expect(decideWindowOpen("about:blank", ORIGINS)).toEqual({ action: "block", reason: "unsupported-scheme" });
  });
});

describe("isAppOrigin", () => {
  it("is false for missing or unparseable URLs", () => {
    expect(isAppOrigin(undefined, ORIGINS)).toBe(false);
    expect(isAppOrigin("", ORIGINS)).toBe(false);
    expect(isAppOrigin("garbage", ORIGINS)).toBe(false);
  });

  it("compares origins, not strings", () => {
    expect(isAppOrigin("https://app.terabot.ai/b/1", ORIGINS)).toBe(true);
    expect(isAppOrigin("https://app.terabot.ai:8443/b/1", ORIGINS)).toBe(false);
  });
});
