/**
 * Every download the site offers, in one place.
 *
 * `url: null` means no build is published yet: the button renders as
 * "Coming soon" instead of pointing at a file that is not there. Publishing a
 * build is one edit — drop the real URL in and the button becomes a link.
 * A URL that is set must be absolute http(s); `test/releases.test.ts` fails the
 * suite if one is not.
 */

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

export const releases: readonly Release[] = [
  { id: "macos", kind: "desktop", name: "macOS", url: null, note: null },
  { id: "windows", kind: "desktop", name: "Windows", url: null, note: null },
  { id: "linux", kind: "desktop", name: "Linux", url: null, note: null },
  { id: "ios", kind: "mobile", name: "iPhone and iPad", url: null, note: null },
  { id: "android", kind: "mobile", name: "Android", url: null, note: null },
];

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
