import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

/**
 * CLI and server entry points run from a package folder, so look for the
 * workspace `.env` beside the entry point and one level up from the package.
 * Kept out of the main entry so the bundler never sees a dynamic file read.
 */
export function loadEnv(): void {
  for (const candidate of [".env", "../../.env"]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      config({ path, quiet: true });
      return;
    }
  }
}
