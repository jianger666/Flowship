/**
 * agent shell 环境清洗（对齐 VS Code / Cursor / Windsurf 的做法）
 *
 * 背景：Flowship 宿主是 Electron——内嵌 app-server 是用「Helper 二进制 +
 * ELECTRON_RUN_AS_NODE=1」当 node 拉起来的，PORT / HOSTNAME / FLOWSHIP_DATA_DIR /
 * __NEXT_PRIVATE_STANDALONE_CONFIG 等启动变量也留在 server 的 process.env 里。
 * agent 的 shell 工具如果原样继承这份 env，会出现两类事故：
 *   1. ELECTRON_RUN_AS_NODE=1 泄进用户命令 → 在 agent shell 里启动任何 Electron
 *      二进制（如 FlowshipTest.app）会被当成纯 node 跑 → 静默秒退、无报错极难排查；
 *   2. PORT=8876 / FLOWSHIP_DATA_DIR=<正式数据目录> / __NEXT_PRIVATE_STANDALONE_CONFIG
 *      泄进去 → next dev/build、本地起服务等命令拿错端口 / 数据目录 / 直接报
 *      "generate is not a function"。
 *
 * 业界标准（实测 Cursor & Windsurf 的 main.js getUnixShellEnvironment）：
 * 在把环境交给用户子进程的边界上，黑名单剔除宿主专属变量（VS Code 同款逻辑：
 * delete ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE / VSCODE_RESOLVING_ENVIRONMENT
 * / XDG_RUNTIME_DIR）。本模块即该边界的 Flowship 实现：只清洗「交给 agent shell」
 * 的这一份拷贝，不动 server 自身 process.env。
 */

/** 宿主注入、绝不允许泄进 agent shell 的变量黑名单 */
export const HOST_INJECTED_ENV_KEYS = [
  // Electron 语义开关：带上它任何 Electron 二进制都会被当纯 node 执行
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  // Electron 主进程拉起 server 时注入的启动参数
  "FLOWSHIP_DATA_DIR",
  "FLOWSHIP_PORT",
  "PORT",
  "HOSTNAME",
  // Next standalone 构建链注入：会让 next build/dev 把函数字段剥光
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
  "__NEXT_PRIVATE_ORIGIN",
  "NEXT_DEPLOYMENT_ID",
] as const;

/**
 * 返回一份剔除宿主注入变量的浅拷贝 env（不修改传入对象 / process.env）。
 * 给 agent shell 工具 spawn 子进程时传 `env: stripHostInjectedEnv()` 用。
 */
export function stripHostInjectedEnv(
  base: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const cleaned = { ...base };
  for (const key of HOST_INJECTED_ENV_KEYS) {
    delete cleaned[key];
  }
  // 收窄回 ProcessEnv：剔除只减不增，NODE_ENV 等必填键语义不变
  return cleaned as NodeJS.ProcessEnv;
}
