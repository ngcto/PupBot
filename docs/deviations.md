# Deviations from the parity spec

Where the shipped build differs from `handoffs/spec/`, and why. The drive copy of
`deviations.md` is the spec owner's; this file records our implementation side.

## Avatars

The 13 silhouettes are copied from Ng's Grok Bot screenshot (`handoffs/avatars-grok`), replacing
both earlier families. The ids are
`circle, cloud, square, star4, quatrefoil, heart, flower, drop, pill, pick, house, splat, hexagon`.

- **The set is asymmetric on purpose.** `square`, `pick` and `house` are tilted; `cloud`,
  `quatrefoil`, `heart`, `flower` and `splat` are lobed unevenly. The old "mirror exactly about the
  vertical axis" rule and its test are gone with the old family; nothing else enforced it.
- **The traced paths were re-fitted to the safe area.** The handoff normalised its polylines to a
  0.88 half-extent, but the Catmull-Rom control points it emitted bulge past the curve they shape,
  so nearly every delivered path measured outside 6..94 once flattened and `validateAvatar`
  rejected it. The silhouettes are unchanged: each curve is uniformly scaled about its own
  bounding-box centre and re-centred on (50, 50) so its long side spans 87.4 units. Nothing was
  re-traced.
- **Control points may sit outside 6..94; the curve may not.** Because of the same Catmull-Rom
  overshoot, `square` reaches x = 4.2 and x = 95.9 in control-point coordinates while its filled
  outline stays inside the window. The safe-area check is therefore the library's own flattened
  bounds check (`validateAvatar`), not a scan of the path's numbers.
- **Eye proportions are the library's.** Its eye is a fixed 4:11 pill at `scale` ≤ 1.8, so the
  reference's ~20 × 30 slots with a 16 gap cannot be matched literally: the widest slot the package
  can draw is 7.2 × 19.8. We take the maximum (`scale` 1.8) and a 16.5 spacing, which keeps the
  pair's gap-to-slot ratio as close to the reference as the cap allows, with the 90% `#121212` ink,
  level and centred at `y = 48`. Every silhouette holds the pair with more than 12 units of
  clearance, so no shape needed its own placement. Compared side by side with the screenshot at
  16/32/96px, ours reads as the same character but with visibly narrower slots — the cap, not a
  choice.
- **`open-bot-avatar` 0.2.1 → 0.3.0** (`pnpm-workspace.yaml` gains the version in
  `minimumReleaseAgeExclude`, since it shipped the day before). Same exports, same definition
  contract, same validator. 0.3.0 adds `state`/`mood` (ribbons for `working`, marks for `thinking`
  and `blocked`, a celebration for `done`) and OKLCH helpers, and keeps the deprecated `motion`
  option we pass. Rendering all 13 shapes at 64px with our fixed options (`motion: "idle"`,
  `time: 0`, `reducedMotion: true`, `depth: 5`) produces byte-identical SVG before and after: no
  geometry, eye or ink change for a resting avatar. Nothing in this app asks for a state yet.

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
