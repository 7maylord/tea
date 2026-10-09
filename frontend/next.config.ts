import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /ox\/_esm\/tempo\/internal\/virtualMasterPool/, message: /Critical dependency/ },
    ];
    config.resolve.alias["@farcaster/mini-app-solana"] = false;
    return config;
  },
  async headers() {
    return [
      {
        source: "/claim/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
