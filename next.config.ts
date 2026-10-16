import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SQLite driver (node:sqlite) and the Anthropic SDK only run on the server.
  serverExternalPackages: ["@anthropic-ai/sdk"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
