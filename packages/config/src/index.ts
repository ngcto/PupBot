import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// CLI entry points (migrate, seed, api, worker) run from a package folder, so
// look for the workspace `.env` upward as well as beside the entry point.
for (const candidate of [".env", "../../.env"]) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) config({ path, quiet: true });
}

export { serverEnv, publicEnv, resetEnvCache, isStubProviderEnabled, publicEnvSchema } from "./env.ts";
export type { ServerEnv, PublicEnv } from "./env.ts";
