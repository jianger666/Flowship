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

/**
 * 宿主注入、绝不允许泄进 agent shell 的变量黑名单。
 *
 * ⚠️ `FLOWSHIP_GITLAB_TOKEN`（GitLab PAT，见 git-token-env.ts）**故意不在**这个黑名单里：
 * 它是 server 专门放进 process.env、要 agent shell 继承的凭据通道（agent 命令里引用它调 GitLab API，
 * 不再去读 config.json）。别把它加进来——加了 pi provider 的 shell 工具就拿不到 token、
 * 「GitLab 访问」提示里的用法会失效（tests/git-token-env.test.ts 钉住）。
 * 旁路（非属主）的 shell 另靠 `omitGitToken` 在 pi-coding-tools 的 shellTool 里显式摘掉它。
 */
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
 * 从 NODE_OPTIONS 里剔掉宿主追加的 `--report-*` 取证旗标（含带引号的取值），其余（如 `--max-old-space-size`）原样保留。
 *
 * 为什么需要：宿主**旧版本**曾把 `--report-on-fatalerror` / `--report-uncaught-exception` /
 * `--report-directory=<数据目录>` 写进 server 的 NODE_OPTIONS。agent 的 shell 子进程继承后，任何 node 脚本异常退出
 * （路径写错、找不到模块、EPIPE…）都会往正式数据目录落一份取证报告——第二轮 review §10 实测：审查脚本一次性落了 20 份。
 * 第三轮 N3-01 起这些旗标改走 server 的 argv（不被继承，见 electron-app/node-options.mjs），NODE_OPTIONS 里不再有它们；
 * 这里保留剔除是兜底：用户自己在 NODE_OPTIONS 里设了同名旗标、或旧壳拉起的 server 仍在运行时，agent 那份环境依旧干净。
 * 分词规则与 Node 解析 NODE_OPTIONS 一致：双引号内的空格不切词（数据目录在「Application Support」下）。
 */
export function stripReportFlagsFromNodeOptions(value: string): string {
  const tokens = value.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  // 只剔宿主自己追加的那几个（不动用户自带的其它 --report-* 设置）
  return tokens
    .filter((t) => !HOST_INJECTED_REPORT_FLAGS.has(t.split("=")[0]!))
    .join(" ");
}

/** 宿主（旧版 electron-app/main.js startServer 曾写进 NODE_OPTIONS）的取证旗标名（不含取值） */
const HOST_INJECTED_REPORT_FLAGS: ReadonlySet<string> = new Set([
  "--report-on-fatalerror",
  "--report-uncaught-exception",
  "--report-directory",
  "--report-exclude-env",
]);

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
  // NODE_OPTIONS 不能整个删（用户自带的 --max-old-space-size 等要保留），只剔宿主追加的 --report-* 取证旗标
  if (typeof cleaned.NODE_OPTIONS === "string") {
    const stripped = stripReportFlagsFromNodeOptions(cleaned.NODE_OPTIONS);
    if (stripped) cleaned.NODE_OPTIONS = stripped;
    else delete cleaned.NODE_OPTIONS;
  }
  // server 自己的 NODE_ENV=production（Next standalone 的 server.js 第一批语句无条件写它，第四轮 Q1-06）：
  // 不能放进 HOST_INJECTED_ENV_KEYS（hermetic-env 据此表删键会把 vitest 的 NODE_ENV=test 一起删掉），
  // 所以在这里单独、且只剔 "production"——用户命令拿到它会让 npm / yarn 1 漏装 devDependencies（tsc / eslint / vitest 缺失）、
  // 预览 dev server 以 production 值起。用户自己设的 development / test 等值原样保留。
  if (cleaned.NODE_ENV === "production") delete (cleaned as Record<string, string | undefined>).NODE_ENV;
  // 收窄回 ProcessEnv：剔除只减不增
  return cleaned as NodeJS.ProcessEnv;
}
