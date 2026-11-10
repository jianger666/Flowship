/**
 * e2e 启动器的纯逻辑部分（run.mjs 用、tests/browser-e2e-launcher.test.ts 也直接测它）。
 *
 * 背景（2026-11-07 事故）：agent 跑无头 Electron 脚本时，脚本有语法错误 / 主进程抛未捕获异常，
 * Electron 默认会弹一个**原生模态错误框**（"A JavaScript error occurred in the main process"）并一直挂着
 * 等人点「好」——弹在用户屏幕上、进程也不退出。所以所有 e2e 脚本必须经启动器起：
 *   1) 起 Electron 之前先用 `node --check` 做语法预检，语法错误只在终端报、根本不起 Electron；
 *   2) 经 electron-bootstrap.cjs 兜住未捕获异常 / dialog，改成打印 + 非零退出；
 *   3) 超时看门狗，卡死的脚本会被整组杀掉。
 */
import { spawnSync } from "node:child_process";

/**
 * 宿主（Electron）注入、会让 `next dev/build` / 裸启动 Electron 异常的变量（见 AGENTS.md「agent shell 环境坑」）。
 * 跑 Electron 前必须剔掉，否则 ELECTRON_RUN_AS_NODE=1 会让 Electron 二进制被当纯 node 跑、静默秒退。
 */
export const HOST_INJECTED_ENV_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "FLOWSHIP_DATA_DIR",
  "FLOWSHIP_PORT",
  "PORT",
  "HOSTNAME",
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
  "__NEXT_PRIVATE_ORIGIN",
  "NEXT_DEPLOYMENT_ID",
];

/** 返回剔除宿主注入变量后的 env 副本（不改入参） */
export const cleanEnv = (env = process.env) => {
  const out = { ...env };
  for (const k of HOST_INJECTED_ENV_KEYS) delete out[k];
  return out;
};

/**
 * 用 `node --check` 预检语法（.cjs 按 CJS、.mjs 按 ESM）。
 * 返回 { ok: true } 或 { ok: false, message }；message 是 node 给出的「文件:行 + 源码行 + ^ + 错误」原文。
 * 用 `process.execPath`（运行启动器的那个 node）而不是 Electron 二进制，且 env 先清洗，避免 ELECTRON_RUN_AS_NODE 干扰。
 */
export const checkSyntax = (file, nodeBin = process.execPath) => {
  const r = spawnSync(nodeBin, ["--check", file], {
    encoding: "utf8",
    env: cleanEnv(),
    timeout: 30_000,
  });
  if (r.error) return { ok: false, message: `语法预检没跑起来：${r.error.message}` };
  if (r.status === 0) return { ok: true };
  return { ok: false, message: (r.stderr || r.stdout || `node --check 退出码 ${r.status}`).trim() };
};

/**
 * 解析启动器命令行：`<script> [--timeout <秒>] [-- 透传给脚本的参数…]`。
 * 脚本路径之后、`--` 之前只认 --timeout，其余未知 flag 报错（避免拼错参数被悄悄当成脚本参数）。
 */
export const parseArgs = (argv) => {
  let script = null;
  let timeoutSec = 180;
  const forward = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      forward.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--timeout") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: "--timeout 需要一个正数（秒）" };
      timeoutSec = n;
      continue;
    }
    if (a.startsWith("--")) return { error: `未知参数 ${a}` };
    if (script === null) script = a;
    else return { error: `多余的参数 ${a}（要给脚本传参请放在 -- 之后）` };
  }
  if (script === null) return { error: "用法：node scripts/browser-e2e/run.mjs <脚本.cjs> [--timeout 秒] [-- 脚本参数…]" };
  return { script, timeoutSec, forward };
};
