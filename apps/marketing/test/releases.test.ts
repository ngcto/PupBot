import { describe, expect, it } from "vitest";
import { invalidReleaseUrls, releaseAction, releases, releasesOfKind, type Release } from "../releases.ts";

function release(overrides: Partial<Release> = {}): Release {
  return { id: "macos", kind: "desktop", name: "macOS", url: null, note: null, ...overrides };
}

describe("what a download button does", () => {
  it("says coming soon when there is no build", () => {
    expect(releaseAction(release())).toEqual({ state: "coming-soon" });
  });

  it("treats an empty or whitespace url as no build, so a stray edit cannot ship a dead link", () => {
    expect(releaseAction(release({ url: "" }))).toEqual({ state: "coming-soon" });
    expect(releaseAction(release({ url: "   " }))).toEqual({ state: "coming-soon" });
  });

  it("becomes a link as soon as a url is set", () => {
    const url = "https://downloads.terabot.dev/mac/Terabot-1.0.0.dmg";
    expect(releaseAction(release({ url }))).toEqual({ state: "available", href: url });
  });

  it("keeps the configured url as written, minus surrounding space", () => {
    expect(releaseAction(release({ url: " https://example.com/a.dmg " }))).toEqual({
      state: "available",
      href: "https://example.com/a.dmg",
    });
  });
});

describe("the release list", () => {
  it("offers both desktop and mobile platforms", () => {
    expect(releasesOfKind("desktop").length).toBeGreaterThanOrEqual(3);
    expect(releasesOfKind("mobile").length).toBeGreaterThanOrEqual(2);
  });

  it("names each platform once", () => {
    const ids = releases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only carries absolute http(s) urls", () => {
    expect(invalidReleaseUrls()).toEqual([]);
  });

  it("rejects a url with no scheme, which is what a half-finished edit looks like", () => {
    expect(invalidReleaseUrls([release({ url: "downloads/mac.dmg" })])).toHaveLength(1);
    expect(invalidReleaseUrls([release({ url: "mailto:someone@example.com" })])).toHaveLength(1);
  });
});
