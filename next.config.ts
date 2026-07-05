import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // turso 驱动是 CJS 包，Turbopack 无法 chunk，需声明 serverExternalPackages
  serverExternalPackages: ['@tursodatabase/database'],
};

export default nextConfig;
