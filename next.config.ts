import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @cursor/sdk 是 server-only 的大依赖、让 Next 不打进 bundle、
  // 运行时直接 require；同时回避 webpack 解析 SDK 自带的 .d.ts.map
  // 时报 "Module parse failed: Unexpected token" 的问题。
  serverExternalPackages: ["@cursor/sdk"],
};

export default nextConfig;
