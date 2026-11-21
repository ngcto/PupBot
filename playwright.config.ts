import { defineConfig } from "@playwright/test";

// `BASE_URL` points the suite at an existing deployment. There is nothing to
// boot in that case: the API runs inside the web app (RUN_MODE=inline), so the
// dev servers and the pg-boss worker are both local-only.
const deployed = process.env.BASE_URL;
const baseURL = deployed ?? "http://localhost:3000";

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
        {
          command: "pnpm --filter @pupbot/api dev",
          url: "http://localhost:8787/health",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: "pnpm --filter @pupbot/web dev",
          url: "http://localhost:3000/sign-in",
          reuseExistingServer: true,
          timeout: 180_000,
        },
      ],
  globalSetup: deployed ? undefined : "./e2e/global-setup.ts",
  globalTeardown: deployed ? undefined : "./e2e/global-teardown.ts",
});
