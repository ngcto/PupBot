import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// One .env lives at the workspace root; Next only reads the package directory.
for (const candidate of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, quiet: true });
    break;
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ["@pupbot/ui", "@pupbot/avatars", "@pupbot/db", "@pupbot/config"],
  experimental: { externalDir: true },
  devIndicators: false,
};

export default nextConfig;
