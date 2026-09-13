import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.SYNIXIR_NEXT_DIST_DIR ?? ".next",
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
  transpilePackages: ["@synixir/client"],
};
export default config;
