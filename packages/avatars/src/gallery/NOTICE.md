# Vendored avatars: open-bot-avatar gallery

The 16 JSON files in this folder are copied unchanged from
[`open-bot-avatar`](https://github.com/DominikScholz/open-bot-avatar) `gallery/`, fetched 2026-11-21.
They are not published to npm — the package ships only its 7 starter avatars, which we import from
`open-bot-avatar` directly.

MIT License, Copyright (c) 2026 Dominik Scholz. The package itself is MIT (see
`node_modules/open-bot-avatar/LICENSE`).

Re-vendoring: drop in the upstream JSON files with the same `version` / `id` / `name` / `body` /
`eyes` shape and list any new file in `index.ts`, alphabetical by id.
