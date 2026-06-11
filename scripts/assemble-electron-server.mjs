#!/usr/bin/env node
/**
 * 组 Electron 安装包内置的 server 布局 → dist/app-server/（V0.7.0）
 *
 * 前置：`BUILD_STANDALONE=1 pnpm build`
 * 用法：`node scripts/assemble-electron-server.mjs`
 *
 * 产物被 electron-builder.yml 的 extraResources 拷进安装包 resources/app-server/；
 * 本地 `pnpm electron:dev` 验证时壳也直接从 dist/app-server 起 server。
 */
import path from "node:path";
import { assembleServerLayout } from "./lib/assemble-server.mjs";

const ROOT = process.cwd();
const dest = path.join(ROOT, "dist", "app-server");
await assembleServerLayout(ROOT, dest);
console.log(`server 布局已组好：${dest}`);
