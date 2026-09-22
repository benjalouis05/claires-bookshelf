import type { NextConfig } from "next";

// e.g. "/claires-bookshelf" when deployed as a GitHub Pages project site.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: "export",
  // Static export goes to dist/; the dev server keeps its own .next/ so a
  // build never clobbers a running `npm run dev`.
  distDir: process.env.NODE_ENV === "production" ? "dist" : ".next",
  basePath,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
