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
- **Depth, body and ink are the definition's; the eye pair is ours.** We pass colour, size,
  `motion: "idle"`, `time: 0` and `reducedMotion: true`, so the body and its depth (the package's
  default 6) are untouched, and the ink stays `#151515`. The package draws two level vertical ovals;
  Ng's reference draws a different pair, so `render.ts` takes those two groups out and draws the pair
  itself in the same place, under the same matrix, in `eyes.ts`. **The definitions are still exactly
  the package's**, which is what matters for a re-vendor.
- **The eye pair carries the gaze.** The body lean is half of the reference's look; the other half is
  the pair: a fat, low near capsule and a thin, high far one, both slanted from upper-left to
  lower-right, receding up and right. Measured off the Grok picker cells and the chat
  mascot: capsules 0.52R and 0.50R long (R = the glyph's inscribed radius), 0.27R and 0.21R thick,
  60° below horizontal, near eye's centre 0.21R left and 0.05R below the pair's midpoint, far eye
  mirrored. Placed with the pair's midpoint 0.52R right of the definition's own eye anchor and 0.06R
  below it, which reproduces the reference's proportions across our 14: pair box 0.344 of the body's
  width by 0.255 of its height against the reference's 0.350 by 0.252, at 0.337 from the body's top
  against 0.339, 6.4% of body area against 6.6%. With the body leaning, `rocket` (0.18R), `star` (0.06R)
  and `witch-hat` (0.12R) carry the pair left to stay inside their own outline; no glyph needed a
  smaller pair.
- **The body leans 12°, the pair does not.** `render.ts` turns the drawn body counter-clockwise about
  the middle of the 0..100 box — the definitions stay as written, so a re-vendor is mechanical — and
  adds the eye layer *after* that transform, so the pair keeps the screen angle it was fitted with and
  the body leans under it. The angle is measured two ways that agree: the screenshot's trace
  rotation-matched against its levelled revision gives 12° (median of the clean-edged shapes, 11.6°),
  and silhouette IoU against the reference cells at matched size gives a plateau from −12° to −16°
  (0.7101 at −12, 0.7106 at −14, 0.7100 at −16) against 0.6856 level and 0.6733 for the old clockwise
  turn. The peak is inside that plateau's noise, so 12° stands. Bounds re-checked at 16–256 px with the
  lean: the widest drawn extent is `witch-hat` at 48.44 units of the 50-unit half box, then `bull`
  47.5, `sprout` 46.9, `camera` 45; nothing clips and no glyph needed shrinking.
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

## Mobile (apps/mobile, v1)

The phone is a client of the same API, and v1 only claims what a phone is good for.

- **Replies render as plain text.** The web app's markdown pipeline (`react-markdown` + GFM +
  syntax highlighting) has no mobile counterpart in this phase, so a table or code fence arrives as
  its source. Every other part of the message model (quote, file, image parts) is carried by the
  shared client and rendered by the quote block only.
- **No bot creation, instructions editing or endpoint form.** Those are web actions; the phone
  shows what is configured and edits the avatar (shape from the registry, colour from the 11-swatch
  palette). The accent is recomputed from the colour on the server, so the bubble tint still follows
  the product rule.
- **No computer provisioning.** A bot without a computer opens with the reason and a link to its
  details; binding one stays on the web app. The "one-click fix" from the web composer is not
  duplicated here yet.
- **Liveness is polling on the list, streaming in the chat.** The bots list re-reads `/m/bots` every
  5 s while it is focused (a phone list has no SSE fan-out), while a chat reply is read off
  `GET /runs/:id/events` through `expo/fetch` and the shared SSE reader — no `EventSource`, which
  React Native does not have.
- **Untested on a device.** No iOS or Android simulator is available on the build machine
  (no KVM), so the app is verified by typecheck, unit tests, a live Node run of the shared client
  against the real API + worker, and `expo export` bundles for both platforms. Touch behaviour and
  layout on a real screen remain unverified.
## Model gateway

- **`ModelGateway` cannot receive a raw key from the browser.** Endpoint keys are decrypted inside the
  server action or the run loop, then handed to an adapter. The endpoint config never round-trips
  through a client component.
- **Adapters emit each delta exactly once.** They parse `run_event`-free: a resuming client replays
  the run log by `seq`, and abort cancels the fetch and the reader, so a reconnect cannot duplicate a
  delta inside one run. Partial text on abort is the run loop's existing behaviour; the adapters prove
  they stop yielding after the signal.
- **Wire fixtures are docs-derived, not recorded.** No provider key exists on the build machine; every
  payload in `packages/providers/test/fixtures/` follows the provider's published streaming reference
  and is labelled as such in its README. They must not be presented as live recordings.
- **Only the test paths police where a request lands.** A saved provider may point at a private host — a
  local gateway is a legitimate BYO endpoint, and chat reaches it — but Test connection resolves the
  hostname, refuses a private address and follows only same-host redirects, so a probe cannot be steered
  at an internal service.
- **A provider lives in Settings, a bot only picks from it.** `model_endpoint` is still the storage row, but
  it is presented as a *provider*: kind, key and base URL are set once under Settings → Providers, and
  creating a bot is a name, a provider and one of that provider's models. No bot dialog takes a key, a base
  URL or an "add endpoint" affordance; with no provider configured, bot creation says so and links to the
  settings section. A provider's own default model is chosen once (first id it lists, else the catalogue's
  newest tool-capable model) so a bot created without touching the picker still answers.
- **A ChatGPT subscription is not a supported endpoint kind.** The device-flow sign-in, token storage,
  refresh and subscription model catalog were built and then removed on the product owner's
  instruction: a free plan's catalog answers with zero models, so the kind bought nothing a key does
  not. Endpoints are API-key only — OpenAI chat, OpenAI Responses, Anthropic Messages, or a custom
  base URL.
- **The Responses input uses `output_text` parts for assistant history and `input_text` elsewhere**,
  with prior tool calls as `function_call` items and results as `function_call_output`. That matches
  the documented input-item union.
- **Anthropic `max_tokens` defaults to 4096** when a caller does not set one, because the API requires
  the field. A `max_tokens`/`refusal` stop reason surfaces as our `max_tokens`/`content_filter` error
  event instead of looking like a complete answer.
- **Cache tokens are priced separately.** Usage events carry `cacheReadTokens`/`cacheWriteTokens`
  internally; models.dev's `cache_read`/`cache_write` rates are applied when present and fall back to
  the input rate. The stored event keeps total prompt tokens in `input_tokens`, because the table has
  no cache columns yet.
- **An unknown model stores a null cost, not zero.** `usage_event.cost` became nullable in migration
  `0003`; the Settings usage row says "cost unknown" and names the unpriced call count, so the number
  never reads as free.
- **A tool with no parameters is canonicalised to `{type:"object",properties:{}}`** on every wire
  format, because a missing `parameters`/`input_schema` is rejected by some providers.
- **The model picker is Base UI's Combobox** wrapped in `packages/ui`; it searches `model_catalog`
  through a server action, shows the model name by default and adds context window plus per-million
  prices only when Details/Advanced is enabled (the sign-in picker, when there was one, never showed them), and
  allows an id outside the catalogue with a warning rather than a block.

