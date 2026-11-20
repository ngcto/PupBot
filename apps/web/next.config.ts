import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pupbot/ui", "@pupbot/avatars", "@pupbot/db", "@pupbot/config"],
  experimental: { externalDir: true },
  devIndicators: false,
};

export default nextConfig;
