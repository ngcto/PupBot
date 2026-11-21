# `@pupbot/marketing` — terabot's shop window

The public site: what Terabot is, what it costs, and where to download it. The product itself is
not usable here; this app is landing, pricing, download, docs and the links across to sign-in.

Built on the same stack as the rest of the repo (Next.js App Router, Tailwind v4, pnpm + Turborepo)
and on the same design tokens: `app/globals.css` imports `@pupbot/ui/styles.css`, so the palette,
hairlines, radii and easings are the app's own, not a copy of them. Dark only.

## Run it

```bash
pnpm install
pnpm --filter @pupbot/marketing dev     # http://localhost:3001
pnpm --filter @pupbot/marketing typecheck
pnpm --filter @pupbot/marketing test
pnpm --filter @pupbot/marketing build
```

From the repo root, `pnpm build` / `pnpm typecheck` / `pnpm test` include this app through Turbo.

## Environment

Two public URLs, both with development defaults so a clean clone builds. They are documented in the
root `.env.example`:

| variable | default | what it is |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3001` | Canonical origin of this site. Used for `metadataBase`, the sitemap and OG tags. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | The product's origin. The nav and footer "Sign in" and "Create an account" links point here. |

There are no secrets in this app and nothing server-side: every route is statically prerendered.

## Deploying

The deployable root is **`apps/marketing`**. Build command `pnpm build` from the repo root (or
`pnpm --filter @pupbot/marketing build` from the root, with the output directory set to
`apps/marketing/.next`); start with `pnpm --filter @pupbot/marketing start`. Set the two variables
above to the real origins. Deployment itself belongs to `NGS-59`.

## Release URLs

The download buttons are driven by `releases.ts`. That file is the only place a build URL lives:

```ts
export const releases: readonly Release[] = [
  { id: "macos", kind: "desktop", name: "macOS", url: null, note: null },
  // ...
];
```

- `url: null` means no build is published. The button renders as a non-interactive **Coming soon**
  and is not a link, so the page cannot send anyone to a missing file.
- Set `url` to the absolute `https://` URL of the artifact and the button becomes a real download.
- `note` is optional and printed under the platform name once a build exists — a version, a size,
  a minimum OS. Leave it `null` until you know the value.
- Add a platform by adding an entry and an id to `PlatformId`; the icon lives in
  `components/release-row.tsx`.

`test/releases.test.ts` fails if a configured URL is not absolute `http(s)`, or if two entries share
an id. Publishing a build is a one-line edit, and the test refuses the half-finished version.

Share cards live in `public/og` (generated, checked in). Regenerate them after a copy change:

```bash
pnpm --filter @pupbot/marketing build
node apps/marketing/scripts/make-og.mjs
```

## Content

Pricing tiers, the questions and the steps are data in `content.ts`, not markup, and
`test/content.test.ts` holds them to the product's rules: one available plan, no invented numeric
limits, no hype words. Screenshots in `public/shots` were rendered from the app itself (1440×900 at
2×) — do not add a picture of a feature that does not exist.
