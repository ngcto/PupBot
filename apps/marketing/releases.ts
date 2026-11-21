/**
 * Every download the site offers, in one place.
 *
 * `url: null` means no build is published yet: the button renders as
 * "Coming soon" instead of pointing at a file that is not there. Publishing a
 * build is one edit — drop the real URL in and the button becomes a link.
 * A URL that is set must be absolute http(s); `test/releases.test.ts` fails the
 * suite if one is not.
 *
 * Where the URLs come from: nothing here hardcodes a tag or a file name.
 * `released.version.json` holds what the release workflow actually published —
 * the version and the list of asset file names it uploaded — and every URL is
 * derived from that. A platform whose file is not in that list stays "Coming
 * soon", so a release where the Windows job failed cannot leave a dead link on
 * the page. Before the first release the version is `null` and everything is
 * "Coming soon".
 */

import released from "./released.version.json" with { type: "json" };

export type PlatformId = "macos" | "windows" | "linux" | "ios" | "android";
export type ReleaseKind = "desktop" | "mobile";

export interface Release {
  readonly id: PlatformId;
  readonly kind: ReleaseKind;
  readonly name: string;
  /** Where the button goes. `null` until a build exists. */
  readonly url: string | null;
  /** Version, size or requirement printed beside the name once a build exists. */
  readonly note: string | null;
}

/** The published version, or `null` when nothing has been released. */
export const publishedVersion: string | null = released.version;

/**
 * The asset file names the release actually carries. `version` alone is not
 * enough to promise a download: a release can finish with one platform's job
 * failed, and this list is what stops the page offering the missing file.
 */
export const publishedAssets: readonly string[] = released.assets;

/** Where the release workflow publishes assets. One place, so it cannot drift. */
export const RELEASE_REPO = "ngcto/Terabot";

export function releaseAssetUrl(version: string, asset: string): string {
  // The Windows installer's real name contains a space ("Terabot Setup 0.1.0.exe"),
  // so the path segment is encoded here rather than left to each browser.
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${encodeURIComponent(asset)}`;
}

/**
 * The asset file names the release workflow produces. Kept in one object so the
 * URL derivation and the tests read from the same place.
 */
const assetNames = {
  // Every name here was produced by running the packager, not by reading its
  // docs: `electron-builder --linux AppImage --x64` emits
  // `Terabot-<version>-x86_64.AppImage`, and `${arch}` is `amd64` for the .deb.
  // The installer is space-free on purpose (see electron-builder.config.cjs):
  // a space in an asset name is stored as a dot by GitHub, which is a name the
  // site could never match.
  linux: (version: string) => `Terabot-${version}-x86_64.AppImage`,
  windows: (version: string) => `Terabot-${version}-setup.exe`,
  android: (version: string) => `terabot-${version}.apk`,
  // electron-builder emits a .dmg per arch; nothing publishes one yet.
  macos: (version: string) => `Terabot-${version}-arm64.dmg`,
} as const;

/**
 * Exposed for the test that holds these names to what the packager actually
 * emits. Not part of the page's contract.
 */
export const assetNamesForTest = assetNames;

/**
 * Derive the button for one platform from a version and the assets a release
 * really carries. Pure so the tests can feed it a full release, a partial one,
 * and the empty state instead of only ever seeing whatever is checked in — a
 * suite that only runs against `version: null` passes no matter what this does.
 */
function entryFor(
  version: string | null,
  assets: readonly string[],
  platform: keyof typeof assetNames,
  note: (version: string) => string,
): { url: string | null; note: string | null } {
  if (version === null) return { url: null, note: null };
  const asset = assetNames[platform](version);
  if (!assets.includes(asset)) return { url: null, note: null };
  return { url: releaseAssetUrl(version, asset), note: note(version) };
}

/**
 * The builds that exist for a given release.
 *
 * `macos` and `ios` are always `null` because producing them needs a paid
 * service: a macOS runner plus an Apple Developer certificate to sign and
 * notarise the app, and an Apple account with Xcode for iOS. Claiming otherwise
 * would ship a link that 404s, which is what this file exists to prevent.
 *
 * `windows` is a real asset and is unsigned; `android` is a real asset and is
 * debug-signed. Both notes say so, because a download that surprises someone is
 * worse than one that explains itself.
 */
export function releasesFor(version: string | null, assets: readonly string[]): readonly Release[] {
  return [
    { id: "macos", kind: "desktop", name: "macOS", url: null, note: null },
    {
      id: "windows",
      kind: "desktop",
      name: "Windows",
      ...entryFor(version, assets, "windows", (v) => `${v} · 64-bit installer · unsigned`),
    },
    {
      id: "linux",
      kind: "desktop",
      name: "Linux",
      ...entryFor(version, assets, "linux", (v) => `${v} · portable AppImage · x64`),
    },
    { id: "ios", kind: "mobile", name: "iPhone and iPad", url: null, note: null },
    {
      id: "android",
      kind: "mobile",
      name: "Android",
      ...entryFor(version, assets, "android", (v) => `${v} · APK · test build, debug-signed`),
    },
  ];
}

/** The builds that exist right now, from the committed released.version.json. */
export const releases: readonly Release[] = releasesFor(publishedVersion, publishedAssets);

export type ReleaseAction = { readonly state: "available"; readonly href: string } | { readonly state: "coming-soon" };

export function releaseAction(release: Release): ReleaseAction {
  const href = release.url?.trim();
  return href ? { state: "available", href } : { state: "coming-soon" };
}

export function releasesOfKind(kind: ReleaseKind): readonly Release[] {
  return releases.filter((release) => release.kind === kind);
}

/** Any configured URL that is missing a base or a web protocol. Empty means the list is publishable. */
export function invalidReleaseUrls(list: readonly Release[] = releases): string[] {
  const invalid: string[] = [];
  for (const release of list) {
    const url = release.url?.trim();
    if (!url) continue;
    try {
      const { protocol } = new URL(url);
      if (protocol !== "https:" && protocol !== "http:") invalid.push(`${release.id}: ${url}`);
    } catch {
      invalid.push(`${release.id}: ${url}`);
    }
  }
  return invalid;
}
