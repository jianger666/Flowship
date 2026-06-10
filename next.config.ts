import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 固定 file tracing root 为项目根——home 目录下有杂散 lockfile 时 Next 会把
  // workspace root 推断到 ~、导致 standalone 产物嵌套整段 Documents/my/... 路径
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // @cursor/sdk 是 server-only 的大依赖、让 Next 不打进 bundle、
  // 运行时直接 require；同时回避 webpack 解析 SDK 自带的 .d.ts.map
  // 时报 "Module parse failed: Unexpected token" 的问题。
  serverExternalPackages: ["@cursor/sdk"],
  // V0.6.30 绿色包发版：CI 设 BUILD_STANDALONE=1 时产出自包含 server.js + 最小 node_modules、
  // 给零 node 环境的同事解压即用。日常 dev / `pnpm serve`（next start）不开——
  // standalone 模式下 next start 不可用、两条路用 env 隔开互不影响。
  output: process.env.BUILD_STANDALONE ? "standalone" : undefined,
};

export default nextConfig;
