import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@pupbot/api",
    "@pupbot/agent",
    "@pupbot/avatars",
    "@pupbot/computers",
    "@pupbot/config",
    "@pupbot/db",
    "@pupbot/providers",
    "@pupbot/storage",
    "@pupbot/ui",
  ],
  experimental: { externalDir: true },
  serverExternalPackages: ["pg", "pg-boss"],
  devIndicators: false,
};

export default nextConfig;
