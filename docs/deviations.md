# Deviations from the parity spec

Where the shipped build differs from `handoffs/spec/`, and why. The drive copy of
`deviations.md` is the spec owner's; this file records our implementation side.

## Avatars

Symmetric silhouettes only (`avatars.json`, home-44): no dog heads, no lopsided detail. The ids are
`orb, squircle, drop, bell, arch, hexa, pill, gem, crest, horns, antennae, scallop, shoulder`.

- **Silhouettes fill 0.88 of the box; features cannot reach 0.96.** `open-bot-avatar` rejects
  geometry outside 6..94 (its error message says 8..92, but 6..94 validates), so the widest a
  silhouette *or* a horn can be is 0.88. Everything is fitted to that box.
- **Eye proportions are the library's.** Its eye is a fixed 4:11 pill at `scale` ≤ 1.8, so the
  contract's 0.22 × 0.34 slots with a 0.18 gap cannot be matched literally. We keep the reference's
  visual weight (`scale` ≈ 1.36, spacing ≈ 20) and the 90% `#121212` ink.
- **`arch` and `gem` are polyline approximations.** The renderer's path parser accepts `M/L/C/Q/Z`
  only — no elliptical arcs — so the arch's semicircular top is 48 straight segments.
- **Symmetry is enforced by a test, not by construction.** `shapes.test.ts` samples every path point
  and asserts a mirrored partner exists within 0.35 units, plus a bounding-box check that the shape
  is centred on x = 50. That is the thing that drifts when someone tweaks a control point.

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
