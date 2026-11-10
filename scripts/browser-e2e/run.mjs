#!/usr/bin/env node
/**
 * 无头 Electron e2e 统一启动器——**所有** scripts/browser-e2e/*.cjs 都用它起，不要直接起 Electron 二进制：
 *
 *   node scripts/browser-e2e/run.mjs scripts/browser-e2e/page-scripts.cjs [--timeout 180] [-- 脚本参数…]
 *
 * 它替你做：清洗宿主注入的环境变量（AGENTS.md「agent shell 环境坑」）、语法预检（有语法错误只在终端报、
 * 根本不起 Electron，避免弹原生错误框挂死）、经 electron-bootstrap.cjs 兜住未捕获异常 / dialog、
 * 超时整组杀进程。退出码：0 = 脚本自己 app.exit(0)；2 = 参数 / 语法预检失败；124 = 超时；其它 = 脚本或 Electron 的退出码。
 *
 * 不碰 Flowship / FlowshipTest 桌面包与 8676 / 8776 / 8876 端口——只起 node_modules 里那份 Electron、
 * 且脚本自己应把 userData 指向临时目录。
 *
 * # 两种用法（行为互不影响）
 * 1. 命令行（上面那样）：stdio 继承终端，行为与以前完全一致。
 * 2. 可编程 API（vitest / 其它 node 脚本 import）：`runElectronScript({ script, timeoutSec, ipc, env, args })`，
 *    返回 `{ child, exit, stdout(), stderr(), kill() }`。`ipc: true` 时给 Electron 子进程多开一路 `"ipc"` stdio，
 *    父进程用 `child.send` / `child.on("message")`，Electron 主进程里对应 `process.send` / `process.on("message")`
 *    （e2e 的 bridge-peer.cjs 就靠它模拟「server 进程 ⇄ 主进程」的 Node ipc 通道）。
 *    import 本模块**不会**触发命令行逻辑（只有被直接运行时才会）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkSyntax, cleanEnv, parseArgs } from "./launcher-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 预检失败（脚本不存在 / 语法错误）：不起 Electron，`exitCode` 对应命令行的退出码（2） */
export class LauncherError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "LauncherError";
    this.exitCode = exitCode;
  }
}

/** 收集子进程输出的上限（防止异常刷屏撑爆内存）；超出后丢弃新内容 */
const OUTPUT_CAP = 4 * 1024 * 1024;

/** API 模式下拉起的全部 Electron 进程组：本进程退出时兜底整组杀，避免 vitest 被中断后留孤儿 */
const liveTrees = new Set();
let exitHookInstalled = false;
const installExitHook = () => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const kill of [...liveTrees]) kill("SIGKILL");
  });
};

/**
 * 起一个受保护的无头 Electron 脚本（预检 + bootstrap + 超时整组杀）。
 *
 * @param {{
 *   script: string,                 // 目标 .cjs（相对 cwd 或绝对路径）
 *   timeoutSec?: number,            // 默认 180；到点 bootstrap 以 124 退出，外层看门狗再多等 10s 硬杀
 *   ipc?: boolean,                  // true：stdio 末尾加 "ipc"，child.send / child.on("message") 可用
 *   env?: Record<string,string>,    // 额外环境变量（叠在清洗后的 process.env 上）
 *   args?: string[],                // 透传给脚本的 argv
 *   cwd?: string,                   // 解析 script 的基准目录，默认 process.cwd()
 *   stdio?: "pipe" | "inherit",     // pipe（默认）：收集 stdout/stderr；inherit：直通终端（命令行用）
 * }} opts
 * @returns {{
 *   child: import("node:child_process").ChildProcess,
 *   exit: Promise<{ code: number | null, signal: NodeJS.Signals | null }>,
 *   stdout: () => string,
 *   stderr: () => string,
 *   kill: (signal?: NodeJS.Signals) => void,
 * }}
 * @throws {LauncherError} 脚本不存在 / 语法错误（此时 Electron 根本没起）
 */
export const runElectronScript = ({
  script,
  timeoutSec = 180,
  ipc = false,
  env = {},
  args = [],
  cwd = process.cwd(),
  stdio = "pipe",
} = {}) => {
  if (!script) throw new LauncherError(2, "缺少 script");
  const target = path.resolve(cwd, script);
  if (!fs.existsSync(target)) throw new LauncherError(2, `找不到脚本：${target}`);

  const syntax = checkSyntax(target);
  if (!syntax.ok) {
    throw new LauncherError(2, `语法错误（未启动 Electron，避免弹原生错误框）：\n${syntax.message}`);
  }

  // `require("electron")` 在纯 node 里返回的就是 Electron 二进制的绝对路径
  const electronBin = createRequire(import.meta.url)("electron");
  const timeoutMs = Math.round(timeoutSec * 1000);

  const stdioCfg = stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"];
  if (ipc) stdioCfg.push("ipc");

  const child = spawn(electronBin, [path.join(here, "electron-bootstrap.cjs"), ...args], {
    env: { ...cleanEnv(), ...env, FS_E2E_TARGET: target, FS_E2E_TIMEOUT_MS: String(timeoutMs) },
    stdio: stdioCfg,
    // 自成进程组：超时 / 收尾时整组杀，不留 GPU / Renderer Helper 孤儿（win32 没有进程组语义，走 child.kill）
    detached: process.platform !== "win32",
  });

  const killTree = (signal) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* 已经退了 */
    }
  };

  let out = "";
  let err = "";
  if (stdio !== "inherit") {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      if (out.length < OUTPUT_CAP) out += d;
    });
    child.stderr?.on("data", (d) => {
      if (err.length < OUTPUT_CAP) err += d;
    });
  }

  // 外层看门狗比 bootstrap 内的多 10 秒：主进程事件循环被堵死时 bootstrap 的定时器也不会触发，只能靠这里硬杀
  const hardTimer = setTimeout(() => {
    console.error(`[e2e] 外层看门狗：超过 ${timeoutSec + 10}s，强制结束进程组`);
    killTree("SIGKILL");
  }, timeoutMs + 10_000);

  installExitHook();
  liveTrees.add(killTree);

  const exit = new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      liveTrees.delete(killTree);
      resolve({ code, signal });
    };
    child.once("error", (e) => {
      console.error(`[e2e] 启动 Electron 失败：${e.message}`);
      finish(1, null);
    });
    child.once("exit", (code, signal) => {
      // 主进程退了之后扫一遍进程组，收掉没跟着退的 Helper
      killTree("SIGKILL");
      // 给 stdout / stderr 一个排空的机会再 resolve（'close' 在流关闭后触发）
      const t = setTimeout(() => finish(code, signal), 1000);
      t.unref?.();
      child.once("close", () => {
        clearTimeout(t);
        finish(code, signal);
      });
    });
  });

  return { child, exit, stdout: () => out, stderr: () => err, kill: killTree };
};

// ----------------- 命令行入口（只有被直接运行时才执行；被 import 时不触发） -----------------

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

const main = () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[e2e] ${parsed.error}`);
    process.exit(2);
  }

  let handle;
  try {
    handle = runElectronScript({
      script: parsed.script,
      timeoutSec: parsed.timeoutSec,
      args: parsed.forward,
      stdio: "inherit",
    });
  } catch (e) {
    if (e instanceof LauncherError) {
      console.error(`[e2e] ${e.message}`);
      process.exit(e.exitCode);
    }
    throw e;
  }

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      handle.kill("SIGKILL");
      process.exit(130);
    });
  }

  handle.exit.then(({ code, signal }) => {
    if (signal) {
      console.error(`[e2e] Electron 被信号 ${signal} 结束`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
};

if (isMain) main();
