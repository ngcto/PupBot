import { describe, expect, it } from "vitest";
import { decidePermission, originOf } from "../src/shared/permissions.ts";

const ORIGINS = ["https://app.terabot.ai"];

function ask(permission: string, requestingUrl: string | undefined, allowedPermissions: string[] = []) {
  return decidePermission({ permission, requestingUrl, allowedOrigins: ORIGINS, allowedPermissions });
}

describe("decidePermission", () => {
  it("denies everything when nothing is allow-listed", () => {
    expect(ask("notifications", "https://app.terabot.ai/")).toEqual({ granted: false, reason: "not-allowlisted" });
    expect(ask("media", "https://app.terabot.ai/")).toEqual({ granted: false, reason: "not-allowlisted" });
    expect(ask("geolocation", "https://app.terabot.ai/")).toEqual({ granted: false, reason: "not-allowlisted" });
  });

  it("grants only the named permission, only to the product origin", () => {
    expect(ask("notifications", "https://app.terabot.ai/b/1", ["notifications"])).toEqual({
      granted: true,
      reason: "allowlisted",
    });
    expect(ask("media", "https://app.terabot.ai/", ["notifications"])).toEqual({
      granted: false,
      reason: "not-allowlisted",
    });
  });

  it("denies a foreign page even when the permission is allow-listed", () => {
    for (const url of [
      "https://example.com/",
      "https://app.terabot.ai.evil.com/",
      "http://app.terabot.ai/",
      "https://cdn.terabot.ai/",
    ]) {
      expect(ask("notifications", url, ["notifications"]), url).toEqual({ granted: false, reason: "foreign-origin" });
    }
  });

  it("denies when the requesting origin is unknown or opaque", () => {
    for (const url of [undefined, "", "null", "file:///tmp/page.html", "not a url"]) {
      expect(ask("notifications", url, ["notifications"]), String(url)).toEqual({
        granted: false,
        reason: "unknown-origin",
      });
    }
  });
});

describe("originOf", () => {
  it("returns a normalised origin for web URLs", () => {
    expect(originOf("https://APP.terabot.ai/b/1")).toBe("https://app.terabot.ai");
    expect(originOf("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("returns undefined for opaque origins", () => {
    expect(originOf("file:///etc/passwd")).toBeUndefined();
    expect(originOf("null")).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
  });
});
