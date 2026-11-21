import { loadEnv } from "@terabot/config/load-env";
import { defineConfig } from "vitest/config";

// The vault's encryption helpers go through `serverEnv()`, so the suite needs the
// same environment shape the app has. Values here are obvious fakes.
loadEnv();

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://terabot:terabot@localhost:5432/terabot",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "ci-only-secret-ci-only-secret-ci-only-ci",
      CREDENTIAL_ENCRYPTION_KEY:
        process.env.CREDENTIAL_ENCRYPTION_KEY ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      STUB_PROVIDER: "false",
    },
  },
});
