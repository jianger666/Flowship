/**
 * server 子进程的 Node 启动旗标（纯函数，main.js 与单测共用）。
 *
 * 为什么走 **argv** 而不是 `NODE_OPTIONS`（第三轮 review N3-01，P1）：
 * `NODE_OPTIONS` 会被 server 的所有子孙进程继承（Cursor provider 的 agent shell、hooks、preview / action-checks /
 * git hook 的 spawn……）。把 `--max-old-space-size` / `--report-*` 写进去有两个后果：
 *   1. 子孙进程里的 Node 如果比 server 内嵌的旧（用户 PATH 上的 Node 18 / 20），遇到它不认的旗标会直接
 *      `exit 9`（`--report-exclude-env is not allowed in NODE_OPTIONS`）——`pnpm / npm / npx / tsc / vitest / husky`
 *      全部起不来，而且很难归因；
 *   2. 取证旗标会让每个子孙进程的异常退出都往数据目录落一份报告。
 * argv（`execArgv`）不会被子进程继承，取证 / 堆上限只对 server 自己生效，也不再需要给含空格的路径加引号
 * （argv 是数组，一个元素就是一个参数）。
 */

/**
 * 内嵌 Node 是否认识 `--report-exclude-env`（报告不带进程环境变量）。
 *
 * 旗标 v23.3.0 引入、v22.13.0 回移；Electron 42 内嵌 Node 24.x（已实测接受）。
 * 现在它是 argv 旗标，只作用于 server 自己：门控是给「将来 Electron 降级到不认识它的 Node」兜底
 * （不认识的旗标会让 server 直接起不来），对当前 Electron 恒真。
 */
export const supportsReportExcludeEnv = (nodeVersion) => {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(nodeVersion ?? ""));
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major >= 24) return true;
  if (major === 23) return minor >= 3;
  if (major === 22) return minor >= 13;
  return false;
};

/**
 * 组装给 server 进程的 argv 旗标（放在入口脚本之前）。
 *
 * - `userNodeOptions`：宿主进程自己的 `NODE_OPTIONS`（用户手动设的）。里面已有同名设置就不再追加，
 *   避免覆盖手工值；这份 env 本身原样透传给 server，不改写。
 * - `reportDir`：取证报告落盘目录（含空格也没关系，argv 不需要引号）。
 */
export const buildServerNodeArgs = ({ userNodeOptions, nodeVersion, reportDir }) => {
  const user = String(userNodeOptions ?? "");
  const args = [];
  // OOM 止血：堆上限 4GB（只设上限、不预分配）。用户手动调过就不动。
  if (!user.includes("max-old-space-size")) args.push("--max-old-space-size=4096");
  // 崩溃取证：致命错误 / 未捕获异常落 report。
  for (const flag of ["--report-on-fatalerror", "--report-uncaught-exception"]) {
    if (!user.includes(flag)) args.push(flag);
  }
  // 报告默认带整份环境变量（可能含 token）；取证价值（堆 / 栈 / 原生栈）不受影响。
  if (supportsReportExcludeEnv(nodeVersion) && !user.includes("--report-exclude-env")) {
    args.push("--report-exclude-env");
  }
  if (reportDir && !user.includes("report-directory")) {
    args.push(`--report-directory=${reportDir}`);
  }
  return args;
};
