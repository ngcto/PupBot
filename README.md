# Terabot

Bots with their own cloud computers, in a chat window. Each bot is a named avatar with a
conversation, a set of instructions, a model endpoint and a computer; you talk to it like a
teammate, and it keeps working when you look away.

This is our own rebuild of the "bot with a computer" product shape. The harness, the model
gateway and the computer allocation are ours; the UI follows a measured reference spec
(`handoffs/spec/` in the crew drive) so it feels like the product people already know.

## Run it

Requirements: Node 26, pnpm 12, Docker.

```bash
pnpm install
cp .env.example .env          # then fill BETTER_AUTH_SECRET + CREDENTIAL_ENCRYPTION_KEY
pnpm db:up                    # Postgres 17 on :5432
pnpm db:migrate
pnpm db:seed                  # demo user, three bots, one conversation
pnpm dev                      # web :3000 · api :8787 · worker (pg-boss)
```

Sign in at http://localhost:3000 with `demo@terabot.dev` / `terabot-demo`. New accounts work too:
sign up, and the first bot dialog opens. In development a fresh workspace gets a local stub model
endpoint, so chat streams with no API key at all.

Generate the two secrets with `openssl rand -base64 32`.

### Scripts

| command | what it does |
| --- | --- |
| `pnpm dev` | all three apps through Turborepo |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | the same checks CI runs |
| `pnpm e2e` | Playwright: sign up → bot → computer → streamed reply → blocked composer |
| `scripts/rename-product.sh` | one mechanical product-rename sweep across the tree; pass `--check` to list what it would rewrite |
| `pnpm db:generate` / `db:migrate` / `db:seed` | Drizzle schema and data |
| `pnpm catalog:sync` | fetch models.dev and upsert `model_catalog` |
| `pnpm --filter @terabot/mobile start` | Expo dev server for the phone app |

## Mobile app

`apps/mobile` is the iOS/Android client: Expo SDK 58 with expo-router, native screens against the
same API — no webview. The HTTP client, the SSE reader and the chat reducer it uses live in
`packages/api-client`, so the phone and the web app share one contract. See
`apps/mobile/README.md` for the LAN address a device needs and what v1 deliberately leaves to the
web app.

## Marketing site

`apps/marketing` is the public site: the landing page, pricing, the download page, a short docs page
and the links across to sign-in. It is not the product. It runs on :3001 in development
(`pnpm --filter @terabot/marketing dev`) and is included in `pnpm dev`, `pnpm build`, `pnpm typecheck`
and `pnpm test` from the root.

Download buttons are driven by `apps/marketing/releases.ts`: a `null` URL renders "Coming soon"
instead of a dead link. Deploy root, environment variables and the release config are documented in
[`apps/marketing/README.md`](apps/marketing/README.md).

## Shape

```
apps/web        Next.js App Router — the shell, bots, chat, settings; server actions for mutations
apps/marketing  Next.js — the public site: landing, pricing, download, docs (:3001 in dev)
apps/api        Hono — conversations, runs, SSE replay, the dev stub endpoint, better-auth
apps/worker     pg-boss consumers — the run loop, models.dev sync
packages/db     Drizzle schema, migrations, auth, crypto, the Postgres queue
packages/agent  the harness: context assembly, the run loop, interrupt handling, step labels
packages/providers  ModelGateway + the openai-chat adapter (one normalized event stream)
packages/computers  the provider contract from the spike + an in-memory stub + the allocator
packages/integrations  Composio connectors and the skills catalogue (shell only)
packages/avatars  symmetric silhouettes on open-bot-avatar, identical on server and client
packages/ui     Tailwind v4 theme from the measured tokens + shadcn-style primitives on Base UI
packages/config zod-validated environment, loaded once
```

**Architecture in a paragraph.** Postgres is the only stateful dependency: it holds the product
tables, better-auth's sessions, the pg-boss queue and every run's event log. A message is written
by the API and a `run` row is enqueued; the worker loads the bot's instructions and recent
transcript, calls the model through `ModelGateway.stream()`, and appends each delta to `run_event`
with a per-run sequence number. The browser subscribes to `GET /runs/:id/events?after=<seq>` and
replays exactly what it missed, so a reload or a dropped connection loses nothing. A new message
during a run sets `abort_requested`; the worker cancels the in-flight fetch, keeps the partial
assistant text as a finished message, and the next run starts with the new message in context.
Model metadata (context window, pricing, modalities) is never hardcoded: it comes from models.dev
into `model_catalog` and is matched when an endpoint is added.

## What is real in this phase

- Bots: create, rename, delete, hide/show, pin, sections, accent colour, instructions, primary bot,
  copy conversation ID.
- Conversations: markdown (GFM tables, lists, code with a copy control), attachment cards, timestamps,
  streaming step labels and a blocked composer for a bot with no computer.
- Streaming chat end to end against the built-in stub endpoint, with SSE replay and
  interrupt-on-new-message (covered by an integration test).
- Endpoints: base URL + key + model, with the models.dev catalogue matched automatically and an
  honest warning when it is not; keys encrypted at rest with AES-256-GCM.
- avatars: 13 symmetric silhouettes × 11 colours, rendered from one SVG string on both sides.

Stubbed behind their interfaces, arriving next: real computer providers (Instabox, Boat) and
allocation, tools and the full harness, attachments upload, voice, routines, group chats, Composio,
the app marketplace, light theme, sharing. `docs/deviations.md` records every place the shipped UI
differs from the spec, and why.
