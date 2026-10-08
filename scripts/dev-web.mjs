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
 *   8676 = 本脚本的 web 热更（next dev，HMR，测试数据）
 *   8677 = 本脚本 --live 的 web 热更（线上数据）
 *
 * 用法：pnpm dev:web            # 测试数据 fe-ai-flow-test（默认 8676）
 *       pnpm dev:web:live       # 线上数据 fe-ai-flow（默认 8677，避免跟 8676 撞）
 * 端口/数据目录可用专属 env 覆盖（不要用 PORT / FLOWSHIP_DATA_DIR，宿主会注入正式包的值）：
 *   DEV_WEB_PORT=8899 DEV_WEB_DATA_DIR=/path/to/data pnpm dev:web
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import open from "open";

// --live：连线上数据（正式包的 fe-ai-flow），默认端口 8677。
// 安全提醒：正式桌面包（8876）必须先退出，两边同时写同一份 sqlite 会打架。
const LIVE = process.argv.includes("--live");
// 端口：不用通用 PORT（宿主会注入 PORT=8876 跟正式包撞车），用专属 DEV_WEB_PORT。
// 默认 8676（测试数据）；--live 默认 8677，跟 8676 可同时开对照。
const PORT = process.env.DEV_WEB_PORT || (LIVE ? "8677" : "8676");
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

// 数据目录：默认走 test（fe-ai-flow-test）。--live 则连线上（fe-ai-flow）。
// 想换目录只用 DEV_WEB_DATA_DIR，别用 FLOWSHIP_DATA_DIR
const root = path.join(os.homedir(), "Library", "Application Support");
const liveDataDir = path.join(root, "fe-ai-flow", "data");
const testDataDir = path.join(root, "fe-ai-flow-test", "data");
process.env.FLOWSHIP_DATA_DIR =
  process.env.DEV_WEB_DATA_DIR || (LIVE ? liveDataDir : testDataDir);
// 标记：只有测试数据才标 test。--live 连线上时必须删掉，
// 否则桥接 / 诊断会把正式实例当 test 处理。
if (LIVE) {
  delete process.env.FLOWSHIP_TEST;
} else {
  // 跟测试桌面包同一套「这是 test」标记，避免桥接 / 诊断按正式实例处理
  process.env.FLOWSHIP_TEST = "1";
}

console.log(
  `[dev:web] ${LIVE ? "LIVE 线上数据" : "test 数据"} port=${PORT} data=${process.env.FLOWSHIP_DATA_DIR}`,
);
if (LIVE) {
  console.log(
    "[dev:web] ⚠️ 正在连线上数据：请先退出正式桌面包 Flowship（8876），两边同时写同一份数据会打架。",
  );
}

// 启动前探活（review 意见：光靠 log 提醒不够，直接拦）：
// - --live 时 8876 还在听 = 正式包没退 → 拒绝启动（双写同一份 sqlite 必打架）；
// - 目标端口已被占 → 拒绝启动（防两个 dev 互踩 / 撞正式包端口）。
const probePort = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: Number(port) });
    s.setTimeout(1500);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(false));
  });
if (LIVE && (await probePort(8876))) {
  console.error(
    "[dev:web] 拒绝启动：正式桌面包正在监听 8876（线上数据被占）。" +
      "先彻底退出 Flowship（⌘Q），确认端口释放后再重来。",
  );
  process.exit(1);
}
if (await probePort(PORT)) {
  console.error(
    `[dev:web] 拒绝启动：端口 ${PORT} 已被占用。` +
      "换 DEV_WEB_PORT 再起（不要用 8676/8776/8876，跟测试包/正式包撞车）。",
  );
  process.exit(1);
}

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
