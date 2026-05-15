#!/usr/bin/env node
/**
 * 起 next dev、并在 server ready 后自动开浏览器
 *
 * 使用方法：pnpm start （别名 dev:open）
 *
 * 设计：
 *   - 用 spawn 起 `next dev`、stdio 直接继承（保留 Next 全部 dev 输出）
 *   - 监听 stdout 第一次出现 "Ready in" 或类似 ready 信号、就触发 open（避免 hardcoded sleep）
 *   - 兜底：10s 内还没等到 ready 也强制 open（极端情况下用户能自己手动打开）
 *   - signal 透传（SIGINT/SIGTERM）、ctrl+c 能正常停子进程
 */

import { spawn } from "node:child_process";
import open from "open";

const PORT = process.env.PORT || "8876";
const URL = `http://localhost:${PORT}`;
// 服务起来的探测正则：Next 15 默认 "✓ Ready in" / Turbopack "✓ Ready in"
// 不依赖具体文案、宽松匹配
const READY_RE = /Ready in|started server|local:.*localhost/i;
const FALLBACK_DELAY_MS = 10_000;

const child = spawn("next", ["dev", "-p", PORT], {
  stdio: ["inherit", "pipe", "pipe"],
});

let opened = false;
const doOpen = () => {
  if (opened) return;
  opened = true;
  open(URL).catch((err) => {
    console.error(`[dev-open] 自动开浏览器失败：${err.message}\n手动打开：${URL}`);
  });
};

// 兜底定时器：10s 还没看到 ready、强制开
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
