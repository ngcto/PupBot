import { describe, expect, it } from "vitest";
import { DEFAULT_APP_URL, parseAllowedOrigins, parseAppUrl, parsePermissions, resolveDesktopConfig } from "../src/shared/config.ts";

describe("parseAppUrl", () => {
  it("defaults to the local dev server when nothing is set", () => {
    expect(parseAppUrl(undefined).toString()).toBe("http://localhost:3000/");
    expect(parseAppUrl("   ").toString()).toBe(`${DEFAULT_APP_URL}/`);
  });

  it("keeps a configured product URL", () => {
    expect(parseAppUrl("https://app.terabot.ai").toString()).toBe("https://app.terabot.ai/");
    expect(parseAppUrl("https://staging.terabot.ai/desktop").pathname).toBe("/desktop");
  });

  it("sends the same binary at staging or production without a rebuild", () => {
    const staging = resolveDesktopConfig({ TERABOT_APP_URL: "https://staging.terabot.ai" });
    const production = resolveDesktopConfig({ TERABOT_APP_URL: "https://app.terabot.ai" });
    expect(staging.appUrl.origin).toBe("https://staging.terabot.ai");
    expect(production.appUrl.origin).toBe("https://app.terabot.ai");
    expect(staging.allowedOrigins).toEqual(["https://staging.terabot.ai"]);
    expect(production.allowedOrigins).toEqual(["https://app.terabot.ai"]);
  });

  it("drops the fragment so two spellings of the same page share one URL", () => {
    expect(parseAppUrl("http://localhost:3000/b/1#composer").hash).toBe("");
  });

  it("refuses anything that is not an absolute http(s) page", () => {
    expect(() => parseAppUrl("localhost:3000")).toThrow(/absolute/);
    expect(() => parseAppUrl("file:///etc/passwd")).toThrow(/absolute http\(s\)/);
    expect(() => parseAppUrl("ftp://example.com")).toThrow(/absolute http\(s\)/);
    expect(() => parseAppUrl("javascript:alert(1)")).toThrow(/absolute http\(s\)/);
  });

  it("refuses credentials inside the URL", () => {
    expect(() => parseAppUrl("https://user:secret@app.terabot.ai")).toThrow(/credentials/);
  });
});

describe("parseAllowedOrigins", () => {
  const appUrl = new URL("https://app.terabot.ai");

  it("is the app origin alone by default", () => {
    expect(parseAllowedOrigins(undefined, appUrl)).toEqual(["https://app.terabot.ai"]);
    expect(parseAllowedOrigins("", appUrl)).toEqual(["https://app.terabot.ai"]);
  });

  it("normalises extra origins and de-duplicates them", () => {
    expect(
      parseAllowedOrigins("https://www.terabot.ai/path, https://www.terabot.ai,https://app.terabot.ai/", appUrl),
    ).toEqual(["https://app.terabot.ai", "https://www.terabot.ai"]);
  });

  it("refuses a malformed or non-http extra origin", () => {
    expect(() => parseAllowedOrigins("not a url", appUrl)).toThrow(/TERABOT_ALLOWED_ORIGINS/);
    expect(() => parseAllowedOrigins("file:///tmp", appUrl)).toThrow(/absolute http\(s\)/);
  });
});

describe("parsePermissions", () => {
  it("is empty by default, which denies every request", () => {
    expect(parsePermissions(undefined)).toEqual([]);
    expect(parsePermissions(" , ")).toEqual([]);
  });

  it("reads a comma separated allow-list without duplicates", () => {
    expect(parsePermissions("notifications, media,notifications")).toEqual(["notifications", "media"]);
  });

  it("refuses names that are not Electron permission strings", () => {
    expect(() => parsePermissions("Notifications!")).toThrow(/permission names/);
    expect(() => parsePermissions("../../etc")).toThrow(/permission names/);
  });
});

describe("updates", () => {
  it("keeps auto-update off unless asked for", () => {
    expect(resolveDesktopConfig({}).autoUpdate).toBe(false);
    expect(resolveDesktopConfig({ TERABOT_AUTO_UPDATE: "false" }).autoUpdate).toBe(false);
    expect(resolveDesktopConfig({ TERABOT_AUTO_UPDATE: "1" }).autoUpdate).toBe(true);
    expect(resolveDesktopConfig({ TERABOT_AUTO_UPDATE: "TRUE" }).autoUpdate).toBe(true);
  });

  it("normalises the feed URL and leaves it unset when empty", () => {
    expect(resolveDesktopConfig({}).updateFeedUrl).toBeUndefined();
    expect(resolveDesktopConfig({ TERABOT_UPDATE_FEED_URL: "  " }).updateFeedUrl).toBeUndefined();
    expect(resolveDesktopConfig({ TERABOT_UPDATE_FEED_URL: "https://updates.terabot.ai/desktop" }).updateFeedUrl).toBe(
      "https://updates.terabot.ai/desktop",
    );
    expect(() => resolveDesktopConfig({ TERABOT_UPDATE_FEED_URL: "updates.terabot.ai" })).toThrow(/TERABOT_UPDATE_FEED_URL/);
  });
});

describe("resolveDesktopConfig", () => {
  it("resolves a full environment into one frozen-by-use object", () => {
    const config = resolveDesktopConfig({
      TERABOT_APP_URL: "https://app.terabot.ai",
      TERABOT_ALLOWED_ORIGINS: "https://cdn.terabot.ai",
      TERABOT_PERMISSIONS: "notifications",
      TERABOT_AUTO_UPDATE: "1",
      TERABOT_UPDATE_FEED_URL: "https://updates.terabot.ai/desktop",
      TERABOT_REGISTER_PROTOCOL: "1",
    });

    expect(config.appUrl.origin).toBe("https://app.terabot.ai");
    expect(config.allowedOrigins).toEqual(["https://app.terabot.ai", "https://cdn.terabot.ai"]);
    expect(config.allowedPermissions).toEqual(["notifications"]);
    expect(config.autoUpdate).toBe(true);
    expect(config.updateFeedUrl).toBe("https://updates.terabot.ai/desktop");
    expect(config.registerProtocol).toBe(true);
  });

  it("does not register the protocol in a development run unless asked", () => {
    expect(resolveDesktopConfig({}).registerProtocol).toBe(false);
    expect(resolveDesktopConfig({ TERABOT_REGISTER_PROTOCOL: "yes" }).registerProtocol).toBe(true);
  });
});
