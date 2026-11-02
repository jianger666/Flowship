/**
 * Windows 优雅退出的最后一步：server 在退出清理**同步完成之后**，对自己整棵进程树 `taskkill /PID <自己> /T /F`（第 8 轮 R8-4）。
 *
 * 为什么需要：Windows 上 agent 子进程树（shell 里的 pnpm / dev server / git 孙进程）原来靠壳退出时的 `taskkill /T /F` 兜底。
 * 改成「壳关 server 的 stdin → server 自己 process.exit(0)」的优雅退出（R1-2）之后，壳那一侧没有任何 `/T` 了：
 * server 已死，事后再对「死 pid」发 `taskkill /T` 找不到根、补杀不可能；server 自己的清理只覆盖**登记过**的托管子进程，
 * 预览的 forceKillAllPreviewsSync 在 win32 直接 return。未登记的孙进程会成孤儿、占端口、继续改工作树。
 * 根只能在它还活着的时候由它自己（或壳）来点——所以由 server 在清理做完之后自杀整树。
 *
 * 保护（全部写在这里、都可注入，单测绝不真调 taskkill）：
 * - 只在 win32；只在调用方显式要求时才会进来（inbound.ts：仅「壳设了 FLOWSHIP_EXIT_ON_STDIN_EOF 且 stdin EOF」那一支，
 *   SIGINT / SIGTERM / 终端 Ctrl+C / 独立运行 / 测试都不走这里）；
 * - 调用方保证「退出清理已同步完成」之后才调（runExitCleanup 永不抛、其内的强杀是同步的）——这一步会终止本进程，之后什么都跑不了；
 * - 默认实现的 execFileSync 在测试环境（VITEST / NODE_ENV=test）里直接拒绝：即便哪个测试把 platform 伪造成 win32 却忘了注入，也不会真调；
 * - taskkill 失败 / 超时 / 抛错一律吞掉并返回 "failed"——调用方随后照常 process.exit(0)，最坏退回「只有 server 自己退出」的现状；
 *   这个函数本身不 exit 进程（成功时进程是被 taskkill 杀掉的、根本不会返回）。
 *
 * ⚠️ 未在 Windows 实机验证，尤其是：taskkill 自己也是树里的后代（它是 server 的子进程），`/T` 是否会先把自己终结、
 * 导致根没被杀（那样就退化为「清理后 process.exit(0)」、孤儿仍可能残留）——见汇报里的待真机项。
 */
import { execFileSync } from "node:child_process";

/**
 * 自杀整树的同步 taskkill 超时。
 * 预算账（与 electron-app/win-server-stop.mjs 的 WIN_STOP_GRACE_MS 一起看，tests/electron-win-graceful-stop.test.ts 钉死）：
 * server 侧最坏 = 退出清理上限（inbound.ts 的 EXIT_HOOK_CLEANUP_CAP_MS = 1.5s）+ 本超时 = 3.5s，
 * 必须小于壳侧优雅预算 4s——否则壳会在 server 还在清树的时候抢先发它自己的 /T /F（无害但重复、也让「优雅」失去意义）。
 */
export const WIN_SELF_TREEKILL_TIMEOUT_MS = 2000;

export interface SelfTreeKillDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  /** 同步执行 taskkill；缺省 = node:child_process 的 execFileSync（测试环境里缺省实现会拒绝执行） */
  execFileSync?: (file: string, args: string[], options: { windowsHide: boolean; timeout: number; stdio: "ignore" }) => unknown;
}

export type SelfTreeKillResult = "skipped" | "attempted" | "failed";

const isTestEnv = (): boolean => process.env.VITEST !== undefined || process.env.NODE_ENV === "test";

/**
 * 同步 `taskkill /PID <pid> /T /F`（含自己的整棵树）。成功时本进程会被杀、不会返回。
 * @returns "skipped" 非 win32 / pid 非法 / 测试环境里没注入 exec；"attempted" taskkill 正常返回（通常不会走到，说明没把自己杀掉）；"failed" taskkill 抛错 / 超时
 */
export const killOwnProcessTreeSync = (deps: SelfTreeKillDeps = {}): SelfTreeKillResult => {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return "skipped";
  const pid = deps.pid ?? process.pid;
  // 0 = System Idle、4 = System：不可能是 server，绝不对它们发 /T /F
  if (!Number.isSafeInteger(pid) || pid <= 4) return "skipped";
  const run = deps.execFileSync ?? (isTestEnv() ? null : execFileSync);
  if (!run) return "skipped";
  try {
    run("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: WIN_SELF_TREEKILL_TIMEOUT_MS,
      stdio: "ignore",
    });
    return "attempted";
  } catch {
    return "failed";
  }
};
