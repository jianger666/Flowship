#!/usr/bin/env node
/**
 * 日常迭代的「网页热更新」通道（AGENTS：默认改 UI 走这个，秒级 HMR，不打包壳）
 *
 * 解决的问题（踩过坑才抽出来的）：
 * 1. 宿主/CI 环境会注入 `__NEXT_PRIVATE_STANDALONE_CONFIG`（JSON 序列化配置）——
 *    Next 一看到就直接 JSON.parse 当配置用、函数字段（generateBuildId）被剥光，
 *    `next build/dev` 直接报 "generate is not a function"。这里显式剔除。
 * 2. `next dev` 默认 -p 8876 与正式桌面包（Flowship）抢端口 → 固定用 8676。
 * 3. 数据目录指向测试数据（fe-ai-flow-test，不动正式/测试各自 userData）。
 *
 * 三端口约定：
 *   8776 = FlowshipTest 桌面包（内嵌 server）
 *   8876 = Flowship 正式桌面包（内嵌 server）
 *   8676 = 本脚本的 web 热更（next dev，HMR）
 *
 * 用法：pnpm dev:web
 * 端口/数据目录可用专属 env 覆盖（不要用 PORT / FLOWSHIP_DATA_DIR，宿主会注入正式包的值）：
 *   DEV_WEB_PORT=8899 DEV_WEB_DATA_DIR=/path/to/data pnpm dev:web
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import open from "open";

// 端口：不用通用 PORT（宿主会注入 PORT=8876 跟正式包撞车），用专属 DEV_WEB_PORT，默认 8676
const PORT = process.env.DEV_WEB_PORT || "8676";
const URL = `http://localhost:${PORT}`;
const READY_RE = /Ready in|started server|local:.*localhost/i;
const FALLBACK_DELAY_MS = 10_000;

// 剔除宿主注入的变量（见文件头说明）——本地 web 热更不需要：
//   - __NEXT_PRIVATE_STANDALONE_CONFIG：JSON 序列化 config，函数字段被剥光 → next 必炸
//   - NEXT_DEPLOYMENT_ID / PORT / NODE_ENV：宿主注入的「打包/生产」残留，会把 dev 带偏
//   - FLOWSHIP_DATA_DIR：正式桌面包 / 宿主常注入成 fe-ai-flow（线上数据），这里必须丢掉再指 test
for (const key of [
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
  "NEXT_DEPLOYMENT_ID",
  "PORT",
  "NODE_ENV",
  "FLOWSHIP_DATA_DIR",
]) {
  delete process.env[key];
}

// 数据目录：永远走 test（fe-ai-flow-test）。想换目录只用 DEV_WEB_DATA_DIR，别用 FLOWSHIP_DATA_DIR
const root = path.join(os.homedir(), "Library", "Application Support");
process.env.FLOWSHIP_DATA_DIR =
  process.env.DEV_WEB_DATA_DIR || path.join(root, "fe-ai-flow-test", "data");
// 跟测试桌面包同一套「这是 test」标记，避免桥接 / 诊断按正式实例处理
process.env.FLOWSHIP_TEST = "1";

console.log(
  `[dev:web] port=${PORT} data=${process.env.FLOWSHIP_DATA_DIR}`,
);

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
// -H 127.0.0.1：只绑 loopback（CR-01，无鉴权 API 不能暴露给局域网）
const child = spawn(
  path.join(repoRoot, "node_modules/.bin/next"),
  // --turbo：所有 next dev 入口统一（webpack-dev 会把 Streamdown/Shiki 全语言编译图
  // 挂在进程里，16GB 机器开久了 10GB+ GC 卡死）。生产 `next build` 仍走 webpack。
  ["dev", "-p", PORT, "-H", "127.0.0.1", "--turbo"],
  {
    cwd: repoRoot,
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  },
);

let opened = false;
const doOpen = () => {
  if (opened) return;
  opened = true;
  open(URL).catch((err) => {
    console.error(`[dev:web] 自动开浏览器失败：${err.message}\n手动打开：${URL}`);
  });
};

const fallbackTimer = setTimeout(doOpen, FALLBACK_DELAY_MS);

const pipe = (stream, dest) => {
  stream.on("data", (chunk) => {
    dest.write(chunk);
    if (!opened && READY_RE.test(chunk.toString())) {
      clearTimeout(fallbackTimer);
      doOpen();
    }
  });
};
pipe(child.stdout, process.stdout);
pipe(child.stderr, process.stderr);

const forward = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", (code) => {
  clearTimeout(fallbackTimer);
  process.exit(code ?? 0);
});
