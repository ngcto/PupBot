import { loadEnv } from "@terabot/config/load-env";
import type { NextConfig } from "next";

// The workspace keeps one `.env` at the repo root; Next would otherwise only
// look beside this app. Loaded here so `pnpm dev` picks up the two public URLs.
loadEnv();

const nextConfig: NextConfig = {
  transpilePackages: ["@terabot/ui"],
  experimental: { externalDir: true },
  devIndicators: false,
};

export default nextConfig;
