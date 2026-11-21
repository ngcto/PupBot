# Deviations from the parity spec

Where the shipped build differs from `handoffs/spec/`, and why. The drive copy of
`deviations.md` is the spec owner's; this file records our implementation side.

## Avatars

Avatars are `open-bot-avatar`'s own objects, nothing of ours. `packages/avatars` exposes 14 of them:
five starter avatars taken from the package with `getExample` (`mug`, `lightbulb`, `chat`, `sprout`,
`watering-can`) and nine gallery avatars vendored as data (`bull`, `bunny`, `camera`, `cat`, `cloud`,
`ghost`, `rocket`, `star`, `witch-hat`). No silhouette is copied into our source and we author none.

- **Ids, in order, are API**: `mug, lightbulb, chat, sprout, watering-can, bull, bunny, camera, cat,
  cloud, ghost, rocket, star, witch-hat`. Any other id — an old family (`orb`, `crest`, …), the
  traced Grok Bot set (`circle`, `star4`, …), a starter or gallery object we do not ship
  (`controller`, `barbell`, `book`, `egg`, …) — renders `mug`, the first id.
- **The gallery nine are vendored, the rest imported.** The package ships only its 7 starter avatars;
  the gallery files live in the upstream repository and are not on npm. They are copied in unchanged
  (MIT, Copyright (c) 2026 Dominik Scholz) with `gallery/NOTICE.md` recording provenance and how to
  re-vendor.
- **Eyes, depth and ink are the definition's.** Each definition carries its own eye placement; we pass
  only colour, size, `motion: "idle"`, `time: 0` and `reducedMotion: true`, so nothing of ours
  overrides the package's geometry, depth (its default 6) or `#151515` ink.
- **Colour is ours.** The eleven palette ids and `deriveAccent()` are unchanged; the default colour is
  `ember` (`#f9670e`), the palette's nearest entry to the package's starter orange `#ff6a1a`, and the
  contact sheet shows all 14 in both.
- **`open-bot-avatar` 0.2.1 → 0.3.0** (`pnpm-workspace.yaml` gains the version in
  `minimumReleaseAgeExclude`, since it shipped the day before). Same exports and same definition
  contract; 0.3.0 adds `state`/`mood` (ribbons for `working`, marks for `thinking` and `blocked`, a
  celebration for `done`), OKLCH helpers and its starter set. Rendering all 14 at 64px with our
  options produces byte-identical SVG before and after: no geometry, eye or ink change for a resting
  avatar. Nothing in this app asks for a state yet.
- **The traced silhouettes are gone**, along with the crest/horns family, the abandoned soft set and
  the four shapes we briefly authored: no path data from any of them is left in the repository.

## Colour

- **The user bubble is the accent × 0.81 in sRGB, not OKLCH L × 0.81.** The four measured pairs fit
  sRGB channel scaling much better: OKLCH drifts `#1884fc` to `#005ed3`, sRGB lands on `#136bcc`
  against a measured `#136ed2`. `#fc2c3e` still lands 7/255 off the measured `#cf2b35`; the
  remaining error is in the reference's own gamut mapping, not in the model. Near-white accents
  (chroma < 12, min channel > 200) return the measured `#3b3b3b`.

## Chat and content

- **Mermaid is not rendered.** Diagrams arrive as fenced code blocks with a copy control. Mermaid
  needs its own renderer and a lazy chunk; it lands with the library/diagram work.
- **Code blocks use `rehype-highlight`, not shiki.** A three-grey + accent theme on the existing
  classes. Shiki would be the better long-term fit (spec G21) but pulls a large bundle for a surface
  the reference never captured.
- **No emoji reactions on messages.** The hover toolbar has copy, reply and the "…" menu (copy
  request ID); reactions need somewhere to persist them (the activity feed).
- **No scroll-to-bottom disc.** The transcript stays pinned while a run streams; the disc arrives
  with the longer-transcript work.
- **Attachment cards render, uploads do not.** A message with file parts shows name, size and the
  type bar; the composer's "+" explains that uploads arrive with storage in P2.
- **New bots inherit the workspace's first endpoint.** P1 has no per-bot endpoint creation flow
  beyond the Settings › Model select; the endpoint form itself is there and matches models.dev.

## Shell

- **Rename Bot opens the bot settings dialog** on Identity rather than an inline field.
- **Delete bot uses the browser confirm** rather than the styled dialog with a typed name. The
  dialog copy from the spec is in the settings Danger group; the menu shortcut is the quick path.
- **The search palette is 640px wide** and covers the chat column rather than exactly filling it,
  and searches bots, actions and settings — not the current conversation (spec §8 additive feature).
- **Unread dot colour = the bot's accent** (spec G20 is unresolved; this is the documented default).
- **The rail is open with Activity by default**, per the decided deviations.
- **Settings nav**: General and Computer are built; Permissions, Vault, Usage & Billing and Updates
  are honest placeholders (Vault and Usage fill in with P2/P3).
- **Theme is dark only**; the row is disabled with `Light mode is coming.`
- **Voice, routines, Teach a task, Connect apps, Share → Create a copy** are visible and explain that
  they land in a later phase instead of pretending to work.

## Transport and operations

- **The browser talks to the API on a second origin** (`localhost:8787` in dev). It works because a
  cookie is host-scoped, not port-scoped, and the API sends CORS credentials for the web origin. In
  production, mount both on one site or set the cookie domain.
- **One run at a time per worker process** (`batchSize: 1`). Correctness of interrupt-then-next comes
  from that; horizontal scaling needs a per-conversation lock, which lands with the full harness.
- **`bot.unread` is an extra column** not in the spec's table — the sidebar's unread dot needs it.
