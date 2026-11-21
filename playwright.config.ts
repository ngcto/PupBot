import { defineConfig } from "@playwright/test";

// `BASE_URL` points the suite at an existing deployment. There is nothing to
// boot in that case: the API runs inside the web app (RUN_MODE=inline), so the
// dev servers and the pg-boss worker are both local-only.
const deployed = process.env.BASE_URL;
const baseURL = deployed ?? "http://localhost:3000";
// With COMPOSIO_LIVE=1 the marketplace specs run against the real Composio project
// on the key already in the environment; every other run uses the local stub, which
// is on its own fake key so the suite never spends the project's quota.
const live = process.env.COMPOSIO_LIVE === "1";
/*
 * The suite's Owner. `OWNER_EMAILS` matches by exact address, so this is one
 * address rather than a domain, unique per run so a second run does not collide
 * with the account the first one left behind. It travels in the environment
 * because this file is evaluated more than once per run — in the runner and in
 * each worker — and a spec that re-derived the address would name a different
 * one than the server was given.
 */
const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? `owner-${Date.now()}@terabot.dev`;
process.env.E2E_OWNER_EMAIL = OWNER_EMAIL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  // The local spec asserts the dev stub endpoint's copy, which production does
  // not serve; `deployed.spec.ts` covers the hosted flow instead.
  testIgnore: deployed ? ["**/smoke.spec.ts"] : [],
  webServer: deployed
    ? undefined
    : [
        ...(live
          ? []
          : [
              {
                // The real client talks to this; the marketplace flow never leaves the machine.
                command: "tsx e2e/composio-stub-server.ts",
                url: "http://127.0.0.1:8799/_health",
                reuseExistingServer: false,
                timeout: 60_000,
              },
            ]),
        {
          command: "pnpm --filter @terabot/api dev",
          url: "http://localhost:8787/health",
          reuseExistingServer: true,
          timeout: 120_000,
          // The suite's computer is the fake pool, not a live provider: a real
          // INSTABOX_API_KEY in a developer's .env would spend quota and its capacity
          // limit would make the smoke test flaky.
          env: { INSTABOX_API_KEY: "" },
        },
        {
          command: "pnpm --filter @terabot/web dev",
          url: "http://localhost:3000/sign-in",
          reuseExistingServer: true,
          timeout: 180_000,
          // A stub run points the app at the stub on the stub's own fake key, so a real
          // project key in the developer's .env is never spent by the suite. A live run
          // keeps the environment's key and base URL, which is the point of it.
          env: {
            ...(live
              ? {}
              : {
                  COMPOSIO_PROJECT_API_KEY: "e2e-fake-key",
                  COMPOSIO_BASE_URL: "http://127.0.0.1:8799/api/v3.1",
                }),
            // Same reason as the api server: the suite's pool is the fake provider.
            INSTABOX_API_KEY: "",
            /*
             * Owner is established by email, so the suite names one: the computer
             * specs sign up as this address to configure a provider, and every other
             * spec signs up as anyone else and is therefore a member. Two roles, one
             * run, no way for a test account to promote itself.
             */
            OWNER_EMAILS: OWNER_EMAIL,
          },
        },
      ],
  globalSetup: deployed ? undefined : "./e2e/global-setup.ts",
  globalTeardown: deployed ? undefined : "./e2e/global-teardown.ts",
});
