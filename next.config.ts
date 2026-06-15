import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 固定 file tracing root 为项目根——home 目录下有杂散 lockfile 时 Next 会把
  // workspace root 推断到 ~、导致 standalone 产物嵌套整段 Documents/my/... 路径
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // 打包瘦身：把「运行时根本不会被 require、却被 file-tracing 保守拖进 standalone」
  // 的死重包显式排除（合计 ~26M）：
  // - sharp / @img(libvips)：next/image 的可选 native 依赖、本项目 UI 全自绘不用 next/image
  // - typescript：本是 devDep、server.js 启动用预序列化 config、不加载 next.config.ts
  // - caniuse-lite：browserslist 构建期专用、production server 不 require
  // 依据：全 standalone grep 零处 require('typescript'/'sharp'/'sqlite3')。
  outputFileTracingExcludes: {
    "*": [
      "node_modules/**/sharp/**",
      "node_modules/**/@img/**",
      "node_modules/**/typescript/**",
      "node_modules/**/caniuse-lite/**",
    ],
  },
  // @cursor/sdk 是 server-only 的大依赖、让 Next 不打进 bundle、
  // 运行时直接 require；同时回避 webpack 解析 SDK 自带的 .d.ts.map
  // 时报 "Module parse failed: Unexpected token" 的问题。
  serverExternalPackages: ["@cursor/sdk"],
  // Electron 桌面端打包：CI 设 BUILD_STANDALONE=1 产出自包含 server.js + 最小 node_modules、
  // 由 assemble-electron-server.mjs 组进安装包 resources。日常 dev / `pnpm serve`（next start）
  // 不开——standalone 模式下 next start 不可用、两条路用 env 隔开互不影响。
  output: process.env.BUILD_STANDALONE ? "standalone" : undefined,
};

export default nextConfig;
