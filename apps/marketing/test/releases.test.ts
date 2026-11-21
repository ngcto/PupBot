import { describe, expect, it } from "vitest";
import {
  invalidReleaseUrls,
  publishedAssets,
  publishedVersion,
  releaseAction,
  releases,
  releasesOfKind,
  type Release,
} from "../releases.ts";

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

describe("the URLs point at assets that were really published", () => {
  // These hold in both states: before the first release (`publishedVersion` is
  // null, every entry says "Coming soon") and after one. What must never happen
  // is a URL for a file the release does not carry, or a note for one version and
  // a URL for another.
  it("offers nothing while no version is published", () => {
    if (publishedVersion !== null) return;
    for (const release of releases) expect(release.url).toBeNull();
  });

  it("only links a platform whose file is in the published asset list", () => {
    for (const release of releases) {
      if (!release.url) continue;
      const file = decodeURIComponent(release.url.split("/").pop() as string);
      expect(publishedAssets).toContain(file);
      expect(release.url).toContain(`/releases/download/v${publishedVersion}/`);
      expect(release.note).toContain(publishedVersion as string);
    }
  });

  // Not gated on a release existing: these names are what the packager emits,
  // checked by actually running it (electron-builder --linux AppImage --x64
  // produced `Terabot-0.1.0-x86_64.AppImage`; the NSIS template is what keeps
  // the installer space-free, because GitHub stores a space as a dot).
  it("uses the exact asset names the packager produces", async () => {
    const { assetNamesForTest } = await import("../releases.ts");
    expect(assetNamesForTest.linux("1.2.3")).toBe("Terabot-1.2.3-x86_64.AppImage");
    expect(assetNamesForTest.windows("1.2.3")).toBe("Terabot-1.2.3-setup.exe");
    expect(assetNamesForTest.android("1.2.3")).toBe("terabot-1.2.3.apk");
  });

  it("uses a name with no space, which GitHub would store as a dot", async () => {
    const { assetNamesForTest } = await import("../releases.ts");
    for (const name of Object.values(assetNamesForTest)) {
      expect(name("1.2.3")).not.toMatch(/\s/);
    }
  });

  it("keeps the platforms that need a paid service honest instead of guessing", () => {
    const byId = new Map(releases.map((entry) => [entry.id, entry]));
    // macOS needs a paid runner plus an Apple certificate; iOS needs a paid Apple
    // account and Xcode. Neither is ever built, so neither may carry a link.
    expect(byId.get("macos")?.url).toBeNull();
    expect(byId.get("ios")?.url).toBeNull();
    expect(byId.get("macos")?.note).toBeNull();
    expect(byId.get("ios")?.note).toBeNull();
  });

  it("says what it is shipping: unsigned windows, debug-signed android", () => {
    const byId = new Map(releases.map((entry) => [entry.id, entry]));
    for (const id of ["windows", "android"] as const) {
      const entry = byId.get(id);
      if (!entry?.url) continue;
      expect(entry.note).toMatch(id === "windows" ? /unsigned/ : /debug-signed/);
    }
  });
});
