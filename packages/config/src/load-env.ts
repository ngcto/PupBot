import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "dotenv";

/**
 * Loads the nearest workspace `.env` without overriding variables already set in
 * the environment. Entry points may run from package or deeper script dirs, so
 * walk up from cwd.
 */
export function loadEnv(): void {
  let dir = resolve(process.cwd());
  for (;;) {
    const path = resolve(dir, ".env");
    if (existsSync(path)) {
      config({ path, override: false, quiet: true });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export const deliberatelyBroken: number = "this is not a number";
