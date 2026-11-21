import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // The real client talks to this; the marketplace flow never leaves the machine.
      command: "tsx e2e/composio-stub-server.ts",
      url: "http://127.0.0.1:8799/_health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
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
      // The marketplace runs against the stub on the stub's own fake key, so a
      // real project key in the developer's .env is never spent by the suite.
      env: {
        COMPOSIO_PROJECT_API_KEY: "e2e-fake-key",
        COMPOSIO_BASE_URL: "http://127.0.0.1:8799/api/v3.1",
        // Same reason as the api server: the suite's pool is the fake provider.
        INSTABOX_API_KEY: "",
      },
    },
  ],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
});
