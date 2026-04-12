import type { NextConfig } from "next";

// Derive allowed origin from NEXT_PUBLIC_APP_URL so Server Actions work
// on both local dev and Vercel (set NEXT_PUBLIC_APP_URL=https://your-app.vercel.app)
const productionOrigin = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).host
  : null;

const allowedOrigins = [
  "localhost:3000",
  "localhost:3001",
  "localhost:3002",
  ...(productionOrigin ? [productionOrigin] : []),
];

const nextConfig: NextConfig = {
  transpilePackages: ["lightweight-charts", "fancy-canvas"],
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
