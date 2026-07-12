import type { NextConfig } from "next";

// WS-022：仅声明运行时外部化包；勿在此混入 experimental/turbopack 实验项除非有明确需求
const nextConfig: NextConfig = {
  // turso 驱动是 CJS 包，Turbopack 无法 chunk，需声明 serverExternalPackages
  serverExternalPackages: ['@tursodatabase/database'],
};

export default nextConfig;
