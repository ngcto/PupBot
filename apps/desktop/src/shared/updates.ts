/**
 * Where an update check gets its feed from.
 *
 * A release build embeds the feed in `<resources>/app-update.yml` (electron-builder
 * writes it whenever `TERABOT_UPDATE_FEED_URL` was set at build time), so the
 * installed app must use that without anyone exporting the variable again at
 * launch. A runtime `TERABOT_UPDATE_FEED_URL` overrides it, which is what a
 * staging binary pointed at a test feed needs.
 */
export type UpdateSource =
  | { readonly kind: "runtime"; readonly feedUrl: string }
  | { readonly kind: "bundled" }
  | { readonly kind: "none" };

export type UpdateSourceInput = {
  readonly runtimeFeedUrl: string | undefined;
  readonly isPackaged: boolean;
  readonly bundledFeedPath: string | undefined;
  readonly fileExists: (path: string) => boolean;
};

export function resolveUpdateSource(input: UpdateSourceInput): UpdateSource {
  if (input.runtimeFeedUrl) return { kind: "runtime", feedUrl: input.runtimeFeedUrl };
  if (input.isPackaged && input.bundledFeedPath && input.fileExists(input.bundledFeedPath)) {
    return { kind: "bundled" };
  }
  return { kind: "none" };
}
