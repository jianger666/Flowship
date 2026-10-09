/**
 * 防后台节流实验开关（v1.9.28，默认关）——纯函数，main.js 与单测共用。
 *
 * 假设：窗口被遮挡 / 最小化 / 系统判定空闲时，macOS App Nap 与 Chromium 后台节流会拖慢
 * 渲染进程的定时器 / rAF（流式渲染追赶）以及主进程定时器，造成「切回来第一条消息」偏慢。
 * 这只是假设、没有数据证明——所以做成默认关的实验开关，由 run-perf.jsonl 里的 appNap 字段
 * 做 A/B 对比（开 vs 关的 ttftMs / 空闲后首发耗时），数据说话再决定要不要默认开。
 *
 * 开启方式（重启生效）：
 * - userData 目录下建一个空文件 PREVENT_APP_NAP（用户最顺手：touch 一下）
 * - 或环境变量 FLOWSHIP_PREVENT_APP_NAP=1
 * 环境变量显式值优先于标记文件：=0 强制关、=1 强制开；其余（含拼写错误）看标记文件。
 *
 * 实验开启时 main.js 做两件事：渲染进程 backgroundThrottling=false，
 * 以及 powerSaveBlocker('prevent-app-suspension')（阻止系统挂起 App；不阻止显示器休眠，代价是后台耗电略增）。
 */

export const APP_NAP_ENV = "FLOWSHIP_PREVENT_APP_NAP";
export const APP_NAP_MARKER = "PREVENT_APP_NAP";

/**
 * @param {Record<string, string | undefined> | undefined} env
 * @param {boolean} markerExists userData 下是否存在 APP_NAP_MARKER 文件
 * @returns {{ enabled: boolean, source: "env" | "marker" | "default" }}
 */
export const resolveAppNapMode = (env, markerExists) => {
  const v = String(env?.[APP_NAP_ENV] ?? "").trim();
  if (v === "1") return { enabled: true, source: "env" };
  if (v === "0") return { enabled: false, source: "env" };
  if (markerExists) return { enabled: true, source: "marker" };
  return { enabled: false, source: "default" };
};
