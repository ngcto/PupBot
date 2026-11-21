import { loadEnv } from "@terabot/config/load-env";
import { defineConfig } from "vitest/config";

// Load the workspace `.env` before the defaults below are evaluated, so a local
// DATABASE_URL or auth secret is honoured instead of being silently replaced by
// the CI fallback. `loadEnv` walks up from cwd and never overrides real env vars.
loadEnv();

export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://terabot:terabot@localhost:5432/terabot",
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? "ci-only-secret-ci-only-secret-ci-only-ci",
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
      API_URL: process.env.API_URL ?? "http://localhost:8787",
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787",
      CREDENTIAL_ENCRYPTION_KEY:
        process.env.CREDENTIAL_ENCRYPTION_KEY ??
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      STUB_PROVIDER: process.env.STUB_PROVIDER ?? "true",
    },
  },
});
