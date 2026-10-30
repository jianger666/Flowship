/**
 * 数据目录所在盘的低空间监视（R14 B2-4b / Q15-10 壳部分）：判定与文案是纯函数，不依赖 electron——vitest 直接测。
 * 编排（量盘 / 发系统通知 / 30 分钟定时）在 main.js 的 `checkDiskOnce` / `startDiskWatch`。
 *
 * 为什么：磁盘写满时事件日志、设置、会话文件都写不进去（Q9-01 / Q15-02）。用户事先毫无察觉，等页面出现「存储降级」
 * 红条（B2-2）时已经在丢数据了。壳每 30 分钟量一次数据目录所在盘：< 2GB 发一条系统通知（提前量），< 500MB 升级为「严重」。
 * 页面红条（B2-4c，服务端读盘 + 前端）用同一组阈值——两处共用这里的数字，由契约测试对账，不各写一份。
 *
 * 取舍：
 *   - 量不到（statfs 抛 / 数值异常）= unknown：既不通知、也不清掉「已通知」记录（statfs 偶发失败不该造成重复通知）；
 *   - 每个级别 24 小时内最多通知一次（内存里记，不落盘：App 重启后再通知一次是可以接受的，比悄悄丢数据好）；
 *     从「偏低」恶化到「严重」立刻再提醒一次；刚在「严重」提醒过、空间回升到「偏低」不算新事件；空间回到正常就清零，下次再低重新提醒；
 *   - 这是 bavail（用户实际还能写多少），APFS 上不含「可清除空间」——系统自己会在写满前清理它，所以这里会偏保守（宁可多提醒一次）。
 */
import { formatMB } from "./disk-space.mjs";

/** 低于这个值：系统通知「磁盘空间偏低」（2GB） */
export const LOW_DISK_WARN_MB = 2048;
/** 低于这个值：「严重」——通知升级；页面红条（B2-4c）也从这里起（500MB） */
export const LOW_DISK_CRITICAL_MB = 500;
/** 多久量一次 */
export const DISK_CHECK_INTERVAL_MS = 30 * 60_000;
/** 同一级别两次通知的最短间隔 */
export const NOTICE_COOLDOWN_MS = 24 * 3_600_000;

/**
 * 剩余 MB → 级别。严格小于才算（恰好 2048MB 还是 ok、恰好 500MB 还是 low）；量不到 / 非数字 / 负数 = unknown。
 * @param {number | null | undefined} freeMB
 * @returns {"ok" | "low" | "critical" | "unknown"}
 */
export const classifyDiskLevel = (freeMB) => {
  if (typeof freeMB !== "number" || !Number.isFinite(freeMB) || freeMB < 0) return "unknown";
  if (freeMB < LOW_DISK_CRITICAL_MB) return "critical";
  if (freeMB < LOW_DISK_WARN_MB) return "low";
  return "ok";
};

/** 「各级别上次通知的时刻」的空记录 */
export const emptyDiskNoticeState = () => ({ low: null, critical: null });

/**
 * 这一轮要不要发通知。state 不可变地传入 / 传出（方便测）。
 * @param {{ level: "ok" | "low" | "critical" | "unknown", nowMs: number, state: { low: number | null, critical: number | null } }} input
 * @returns {{ notify: boolean, state: { low: number | null, critical: number | null } }}
 */
export const decideDiskNotice = ({ level, nowMs, state }) => {
  if (level === "unknown") return { notify: false, state };
  if (level === "ok") return { notify: false, state: emptyDiskNoticeState() };
  const within = (t) => t !== null && nowMs - t < NOTICE_COOLDOWN_MS;
  const suppressed = level === "critical" ? within(state.critical) : within(state.low) || within(state.critical);
  if (suppressed) return { notify: false, state };
  return { notify: true, state: { ...state, [level]: nowMs } };
};

/**
 * 系统通知的标题 / 正文。
 * @param {{ level: "low" | "critical", freeMB: number }} input
 */
export const buildLowDiskNotice = ({ level, freeMB }) =>
  level === "critical"
    ? {
        title: "磁盘空间严重不足",
        body: `数据所在的磁盘只剩约 ${formatMB(freeMB)}。新的对话和任务记录可能已经保存不了，自动更新也可能被拦下。请尽快清理磁盘。`,
      }
    : {
        title: "磁盘空间偏低",
        body: `数据所在的磁盘只剩约 ${formatMB(freeMB)}。空间再少下去，对话和任务记录可能保存失败，建议先清理一下。`,
      };
