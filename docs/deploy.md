# Deploying Terabot

The hosted shape is one Vercel project: Next.js serves the UI and mounts the Hono API at
`/api/terabot`, so there is one origin, one first-party session cookie, and no cross-site CORS.
Postgres is Supabase. There is no separate worker, no queue, and no second service.

- **App**: <https://terabot-six.vercel.app> — deployed from `b3a3f76` (`p3/deploy`),
  deployment `dpl_9FBj2cHTnMadoqbZc67qA7ivhRsu`, 2026-11-21 05:09 UTC
- **Database**: Supabase project `glhuwrobszgnrguareic` (`ap-southeast-1`). Its display name still
  carries the pre-rename product name; only the identifier in `DATABASE_URL` matters to the app
- **Runs**: `RUN_MODE=inline` — a run executes inside the POST that started it and finishes in
  `waitUntil`, bounded by `maxDuration = 300` on the route
- **Attachments**: Postgres `attachment_blob` by default; Supabase Storage (S3) when all four
  `S3_*` variables are set — no code change either way

## Environment

Set these on the Vercel project (Production and Preview). Only `DATABASE_URL`,
`BETTER_AUTH_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` are secret.

| variable | value |
| --- | --- |
| `DATABASE_URL` | Supabase **transaction pooler** string, port 6543, ending `?sslmode=no-verify` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 32` — encrypts provider keys at rest |
| `BETTER_AUTH_URL` | the deployment origin, `https://terabot-six.vercel.app` |
| `API_URL` | the same origin **plus the mount path**: `https://terabot-six.vercel.app/api/terabot` |
| `NEXT_PUBLIC_API_URL` | same as `API_URL` |
| `RUN_MODE` | `inline` |
| `DATABASE_POOL_MAX` | `3` — one Fluid instance per concurrent request, and the free tier caps connections |
| `STUB_PROVIDER` | `false` |
| `AI_GATEWAY_MODEL` | `recursive/flint-v1.0` (default; the free tier refuses paid models with a 403) |

Do **not** set `VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY`: the platform injects the OIDC token,
and the AI Gateway endpoint is keyless because that token authenticates it. Without a Vercel
deployment, set `AI_GATEWAY_API_KEY` instead.

`sslmode=no-verify` is deliberate. node-postgres 8.23 treats `sslmode=require` as `verify-full`,
and Supabase's pooler certificate chain is not in the function's trust store, so the connection
fails with `self-signed certificate in certificate chain`. `no-verify` keeps TLS on and skips
chain verification — the trade-off of not shipping Supabase's CA bundle.

## Project settings

- Root directory `apps/web`, framework Next.js, Node 24, **Include source files outside the Root
  Directory** on (the workspace packages live in `packages/`).
- Build: `turbo run build` (auto-detected). `turbo.json` declares every variable the app reads in
  `globalEnv`; without that Turborepo strips them and the build fails validating the environment.
- The API proxy builds the Hono app on the first request rather than at import, so a build machine
  needs no database or secrets.

## Database

```bash
# from a checkout with DATABASE_URL pointing at Supabase
pnpm db:migrate     # uses MIGRATE_DATABASE_URL when set (session/direct connection)
pnpm db:seed        # demo user, bots, conversation
```

`pnpm db:migrate` takes a session-level advisory lock, so point `MIGRATE_DATABASE_URL` at the
session pooler (port 5432) or the direct connection when the transaction pooler refuses it.

## Verification

```bash
curl -s https://terabot-six.vercel.app/api/terabot/health   # {"ok":true,"service":"terabot-api"}
BASE_URL=https://terabot-six.vercel.app pnpm e2e           # deployed.spec.ts
pnpm typecheck && pnpm test                                # local, against docker Postgres
```

`pnpm e2e` with `BASE_URL` set skips the local web servers, the pg-boss worker, and the dev-only
`smoke.spec.ts`; `deployed.spec.ts` signs up, creates a bot, binds a computer, sends a message,
waits for the finished assistant bubble, reloads, and asserts the reply is still there.

The local suite needs the Docker database: `pnpm db:up`, `DATABASE_URL=postgres://terabot:terabot@localhost:5432/terabot pnpm db:migrate`, then
`DATABASE_URL=postgres://terabot:terabot@localhost:5432/terabot pnpm test`. Pointing it at the hosted
database works for reads but the integration tests time out on the round trip.

## What that build is behind on

That deployment predates everything merged into `main` since, so **the live URL still serves the
product under its pre-rename name**: no real computers (#2), no avatar set from main (#3), no
desktop shell (#5), no mobile client (#6), no model gateway or usage pricing (#1), and not the
rename (#4). Marketing (#7) is a separate app by design and does not belong in this deployment
either way.

The hosted database needs its migrations run before or with that redeploy, and one entry there is a
repair rather than a feature: `0007_model_gateway_backfill` completes the three migrations whose
timestamps put them behind rows the database had already recorded, so a plain `pnpm db:migrate`
against it leaves the schema complete. Run it with the session-mode connection string, since
migrations take advisory locks:

```bash
MIGRATE_DATABASE_URL='<session-mode connection string>' pnpm db:migrate
```

The most visible consequence is the API mount. The live build answers on a mount path this branch
no longer serves — `curl` the health line in [Verification](#verification) at each path to see
which one is live — while this branch mounts the API at `/api/terabot`.
`API_URL` and `NEXT_PUBLIC_API_URL` therefore have to move with the redeploy: a build of this
branch left on the old value 404s every API call.

Compare before redeploying:

```bash
git log b3a3f76..origin/main --stat -- . ':(exclude)docs'
```

## Redeploying

There is no push-to-deploy: `ngcto/Terabot` is not visible to the team's Vercel GitHub integration
(`repo_not_found`; the integration's own endpoints answer `403 github_response_error`). Until that is
fixed, a redeploy is a manual step, so the URL is only ever as new as the last deployment.

**What unblocks push-to-deploy** (a person, with access to the GitHub account that owns the repo and
to the `roldzai` Vercel team):

1. Install the Vercel GitHub App on the account that owns `ngcto/Terabot` and grant it that
   repository.
2. In the Vercel project `terabot` → Settings → Git, connect `ngcto/Terabot` with the production
   branch `main`.

**Redeploy by hand** (needs a Vercel token; no token lives on the build machine):

```bash
# once, from the repo root: links apps/web to the `terabot` project
pnpm dlx vercel@latest link --repo --yes

# every time: build remotely, then promote the build to production
pnpm dlx vercel@latest build --prod
pnpm dlx vercel@latest deploy --prebuilt --prod
```

`vercel deploy --prod` alone also works and builds on Vercel; the two-step form is what CI-style
runs use and prints the URL on stdout. Project settings (root directory `apps/web`, the
environment) already live on the project, so nothing else needs to be repeated.

**After any redeploy**, re-run the hosted check, because green CI is not the same as a working URL:

```bash
BASE_URL=https://terabot-six.vercel.app pnpm e2e
```

## Testing without touching the hosted database

`loadEnv()` reads the workspace `.env`, and the file kept for this deployment points
`DATABASE_URL` at the hosted Supabase pooler. `pnpm test` therefore writes its fixtures —
users, workspaces, attachments — into the hosted database unless you override it:

```bash
pnpm db:up                                     # Docker Postgres on 127.0.0.1:5432
DATABASE_URL=postgres://terabot:terabot@127.0.0.1:5432/terabot pnpm db:migrate
DATABASE_URL=postgres://terabot:terabot@127.0.0.1:5432/terabot pnpm test
```

The tests clean up after themselves, but they are several times slower through the pooler
(a round trip is ~1 s from a build machine against ~1 ms locally), and the hosted row
counts are what the product shows.

## Limits of this shape

- A run is capped by the function's `maxDuration` (300s on Hobby). Longer work needs the queue
  deployment: `RUN_MODE=queue` plus a host that runs `apps/worker`.
- The `pg-boss` catalogue sync job does not run here. `model_catalog` stays empty until
  `pnpm catalog:sync` is run against the hosted database.
- Each signup gets an AI Gateway endpoint with `AI_GATEWAY_MODEL`; on a team without paid credits
  that model must be one the free tier serves (`recursive/flint-v1.0`,
  `nvidia/nemotron-3.5-lightning-free` — free too, but it reasons for about a minute before
  answering). Users can
  still add their own endpoint in Settings › Models.
- Deploys currently come from an upload of the branch tree (the deployment API, the same files
  `vercel deploy` sends). Push-to-deploy needs the Vercel GitHub App installed on `ngcto/Terabot`;
  the project has no Git connection yet.
