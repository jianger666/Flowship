#!/usr/bin/env node
/**
 * 起 next（dev 或 start）、并在 server ready 后自动开浏览器
 *
 * 使用方法：
 *   - `pnpm start`：起 next dev（热更、改 ai-flow 代码时用、但按需编译会抖 chat-mcp globalThis 状态）
 *   - `pnpm serve`：先 next build 再起 next start（生产、跑真实大需求用、单一模块树、状态稳）
 *
 * 参数：argv[2] = "start" → 生产模式（next start）；其它 / 缺省 → dev 模式（next dev）
 *
 * 设计：
 *   - 用 spawn 起 `next <mode>`、stdio 直接继承（保留 Next 全部输出）
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

// argv[2]：start → 生产模式（需先 next build、由 package.json serve 串好）；缺省 → dev 热更
const MODE = process.argv[2] === "start" ? "start" : "dev";
// -H 127.0.0.1：只绑 loopback——next 默认 0.0.0.0 会把无鉴权 API（含密钥读取 /
// shell 执行能力）暴露给整个局域网（CR-01）、源码运行也必须钉死本机
const child = spawn("next", [MODE, "-p", PORT, "-H", "127.0.0.1"], {
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
