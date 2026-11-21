# apps/mobile — Terabot for iOS and Android

An Expo (SDK 58) client with expo-router. Native screens against the same API the
web app uses — no webview. Every HTTP call goes through `@terabot/api-client`, and
every avatar is drawn by `@terabot/avatars`, so the phone cannot drift from the
product's contracts.

## Screens

| Screen | Route | What it does |
| --- | --- | --- |
| Sign in | `/sign-in` | Email + password against `POST /m/auth/sign-in`; the session cookie is kept in `expo-secure-store`. |
| Bots | `/(tabs)` | The workspace's bots with avatar, live status line (replying / awake / sleeping / no computer) and the last message. Polls every 5 s while focused, pull to refresh. |
| Chat | `/chat/[botId]` | History, a streamed reply read off `GET /runs/:id/events` over `expo/fetch`, and an interrupt when you send while it is still answering. |
| Bot details | `/bot/[botId]` | Avatar shape + colour from the registry, the configured provider and model, and the bound computer's state. |
| Settings | `/(tabs)/settings` | Account, API origin, app version, sign out. |

## Run it

```bash
# from the repo root, once
pnpm install

# the API and worker the phone talks to
docker compose up -d postgres && pnpm db:migrate && pnpm db:seed
pnpm --filter @terabot/api dev
pnpm --filter @terabot/worker dev

# the app
pnpm --filter @terabot/mobile start
```

A phone cannot reach `localhost`. Point the app at your machine's LAN address
before bundling:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 pnpm --filter @terabot/mobile start
```

Sign in with the seeded account (`demo@terabot.dev` / `terabot-demo`) or your own.

## Checks

```bash
pnpm --filter @terabot/mobile typecheck
pnpm --filter @terabot/mobile export:ios      # bundles with Metro, writes dist/
pnpm --filter @terabot/mobile export:android
npx expo-doctor
```

Unit tests for the request/stream layer and the chat reducer live in
`packages/api-client`.

## Deliberately not in v1

- Creating bots, editing instructions, and choosing a model endpoint stay on the
  web app; the phone shows what is configured and picks avatars.
- Binding a computer is a web action too: without one, chat is blocked with the
  reason and a pointer to the bot's details.
- Replies render as plain text; the web app's markdown pipeline is not on the
  phone yet.
