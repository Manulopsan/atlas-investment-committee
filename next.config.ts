import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The SQLite driver (node:sqlite) and the Anthropic SDKs only run on the server (the Agent SDK spawns Claude Code).
  serverExternalPackages: ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"],
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
