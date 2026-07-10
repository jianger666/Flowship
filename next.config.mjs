import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Next 配置（v1.0：从 next.config.ts 转 .mjs）
 *
 * 为什么用 .mjs 不用 .ts（踩坑记账）：Next 15.5.20 起（CR-06 依赖升级引入）、`.ts` 配置
 * 在 **standalone server 启动时**会走 next-config-ts 转译路径、require `next/dist/lib/typescript/*`；
 * 而本文件的 outputFileTracingExcludes 里 `node_modules/**​/typescript/**` 这条（本意排 typescript 包）
 * 把 Next 自己的 `dist/lib/typescript/` 也一并删了 → 打包态启动 `Cannot find module
 * required-packages` 崩溃（dev/build 不复现、只 standalone 挂）。改 .mjs 后 Next 原生加载、
 * 不再转译配置、彻底绕开该路径。
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // 固定 file tracing root 为项目根——home 目录下有杂散 lockfile 时 Next 会把
  // workspace root 推断到 ~、导致 standalone 产物嵌套整段 Documents/my/... 路径
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  // 打包瘦身：把「运行时根本不会被 require、却被 file-tracing 保守拖进 standalone」
  // 的死重包显式排除（合计 ~26M）：
  // - sharp / @img(libvips)：next/image 的可选 native 依赖、本项目 UI 全自绘不用 next/image
  // - typescript：本是 devDep、server.js 启动用预序列化 config、不加载配置源
  //   ⚠️ 精确到 .pnpm/typescript@* + 顶层 typescript 包、**别用 `**​/typescript/**`**——
  //   那会连 Next 自己的 next/dist/lib/typescript 一起删、15.5.20+ standalone 启动崩
  // - caniuse-lite：browserslist 构建期专用、production server 不 require
  outputFileTracingExcludes: {
    "*": [
      "node_modules/**/sharp/**",
      "node_modules/**/@img/**",
      "node_modules/.pnpm/typescript@*/**",
      "node_modules/typescript/**",
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
