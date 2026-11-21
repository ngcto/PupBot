import { describe, expect, it } from "vitest";
import {
  invalidReleaseUrls,
  publishedAssets,
  publishedVersion,
  releaseAction,
  releases,
  releasesFor,
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

// The checked-in `released.version.json` is `{ version: null }`, so every test
// above runs against the empty state. These drive the derivation with a real
// release, which is the only way a regression in the linking path can fail.
describe("a real release produces real links", () => {
  const version = "2.5.1";
  const full = [`Terabot-${version}-x86_64.AppImage`, `Terabot-${version}-setup.exe`, `terabot-${version}.apk`];

  it("links exactly the platforms whose file the release carries", () => {
    const byId = new Map(releasesFor(version, full).map((entry) => [entry.id, entry]));
    expect(byId.get("linux")?.url).toBe(
      `https://github.com/ngcto/Terabot/releases/download/v${version}/Terabot-${version}-x86_64.AppImage`,
    );
    expect(byId.get("windows")?.url).toBe(
      `https://github.com/ngcto/Terabot/releases/download/v${version}/Terabot-${version}-setup.exe`,
    );
    expect(byId.get("android")?.url).toBe(
      `https://github.com/ngcto/Terabot/releases/download/v${version}/terabot-${version}.apk`,
    );
    for (const id of ["linux", "windows", "android"] as const) {
      expect(releaseAction(byId.get(id) as Release).state).toBe("available");
      expect(byId.get(id)?.note).toContain(version);
    }
  });

  it("leaves a platform disabled when the release finished without it", () => {
    // A run where the Android job failed publishes the two desktop installers.
    const byId = new Map(releasesFor(version, full.slice(0, 2)).map((entry) => [entry.id, entry]));
    expect(byId.get("linux")?.url).not.toBeNull();
    expect(byId.get("windows")?.url).not.toBeNull();
    expect(byId.get("android")?.url).toBeNull();
    expect(releaseAction(byId.get("android") as Release).state).toBe("coming-soon");
  });

  it("offers nothing at all when the version is stamped with no assets", () => {
    for (const entry of releasesFor(version, [])) {
      expect(entry.url).toBeNull();
      expect(entry.note).toBeNull();
    }
  });

  it("never links a file from a different version", () => {
    // Assets from 2.5.0 must not satisfy a 2.5.1 release: that URL 404s.
    const stale = full.map((name) => name.replace(version, "2.5.0"));
    for (const entry of releasesFor(version, stale)) {
      expect(entry.url).toBeNull();
    }
  });

  it("holds macOS and iOS to no link even in a full release", () => {
    const byId = new Map(releasesFor(version, [...full, `Terabot-${version}-arm64.dmg`]).map((e) => [e.id, e]));
    expect(byId.get("macos")?.url).toBeNull();
    expect(byId.get("ios")?.url).toBeNull();
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
