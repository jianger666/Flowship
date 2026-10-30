/**
 * 低磁盘预警（R14 B2-4c / Q15-10 的页面红条部分）——前后端共用的纯函数模块（无 server-only 依赖）。
 *
 * 壳侧（electron-app/disk-watch.mjs）每 30 分钟量一次数据目录所在盘：< 2GB 发系统通知、< 500MB 升级成「严重」。
 * 页面侧补一条常驻红条：剩余 < 500MB（critical）时画在事件流顶部——系统通知可能被用户关掉 / 被勿扰模式吞掉，
 * 红条不依赖它；而且是「正在看着的页面」上的提示，比一闪而过的通知更不容易漏。
 *
 * 阈值与壳侧是同一组数，但 Next 构建不能 import electron-app/*.mjs（打包后两边是两个包），所以这里写一份；
 * `tests/low-disk.test.ts` 的契约测试把常量、分级边界、MB / GB 文案逐点对账——任何一边单改都会红。
 *
 * 与 B2-2 的存储降级红条（`storage-degraded.ts`）语义不冲突：那条是「已经写失败」（事实），这条是「快写不下了」（预警）；
 * 同时成立时只画前者（`LowDiskBanner` 的 `suppressed`），免得两条红的说同一件事。
 */

/** 低于它算「偏低」（壳侧发系统通知；页面不画条——只有「严重」才常驻打扰） */
export const LOW_DISK_WARN_MB = 2048;
/** 低于它算「严重」：页面画红条。比 mac 暂存预检（600MB）与 Windows 静默更新预检（800MB）都低，所以文案说「自动更新也可能被拦下」成立 */
export const LOW_DISK_CRITICAL_MB = 500;

/** 页面轮询间隔：腾出空间后红条最慢这么久自己消失（切回窗口时更快，见 LOW_DISK_MIN_GAP_MS） */
export const LOW_DISK_POLL_INTERVAL_MS = 5 * 60_000;
/** 窗口重新聚焦 / 变可见时，距上次开始取数不足这个间隔就不重复取（防抖：来回切窗口不该每次都打一个请求） */
export const LOW_DISK_MIN_GAP_MS = 30_000;

export type DiskLevel = "ok" | "low" | "critical" | "unknown";

/** 服务端 `GET /api/system/disk` 的响应；freeMB 是 MB 向下取整，量不到 = null（此时 level 必为 unknown） */
export interface DiskReading {
  level: DiskLevel;
  freeMB: number | null;
}

/**
 * 剩余 MB → 级别。严格小于才算：恰好 500MB 不是 critical、恰好 2048MB 不是 low（与壳侧同口径）。
 * 非数 / 非有限 / 负数（statfs 异常值）= unknown——既不报警也不当成「没问题」。
 */
export const classifyDiskLevel = (freeMB: unknown): DiskLevel => {
  if (typeof freeMB !== "number" || !Number.isFinite(freeMB) || freeMB < 0) return "unknown";
  if (freeMB < LOW_DISK_CRITICAL_MB) return "critical";
  if (freeMB < LOW_DISK_WARN_MB) return "low";
  return "ok";
};

/** 空间文案：≥ 1GB 用 GB（一位小数），否则 MB。与壳侧 disk-space.mjs 的 formatMB 同口径（契约测试对账）。 */
export const formatFreeMB = (mb: number): string =>
  mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

const LEVELS: ReadonlySet<string> = new Set(["ok", "low", "critical", "unknown"]);

/** 前端不信任响应体：形状不对（被代理改写 / 版本不一致 / 报错页）一律当「没取到」 */
export const isDiskReading = (v: unknown): v is DiskReading => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.level !== "string" || !LEVELS.has(r.level)) return false;
  return r.freeMB === null || (typeof r.freeMB === "number" && Number.isFinite(r.freeMB) && r.freeMB >= 0);
};

/** 两次读数是否等价——相同就别 setState（省一次重渲染）；null 只和 null 相同 */
export const sameDiskReading = (a: DiskReading | null, b: DiskReading | null): boolean =>
  a === null || b === null ? a === b : a.level === b.level && a.freeMB === b.freeMB;

/**
 * 新读数并入当前状态。unknown（这次没量到）不覆盖上一次的结论：偶发的 statfs 失败不该让红条一闪而没，
 * 也不该把「其实还是满的」当成恢复；确实恢复了的话，下一次量得到时自然会被 ok / low 覆盖。
 */
export const mergeDiskReading = (
  prev: DiskReading | null,
  next: DiskReading,
): DiskReading | null => {
  if (next.level === "unknown") return prev;
  return sameDiskReading(prev, next) ? prev : next;
};

export interface LowDiskCopy {
  /** 一句话标题：带剩余空间 */
  title: string;
  /** 红条里的补充说明：会怎样、该做什么、什么时候自己消失 */
  detail: string;
}

const POLL_MINUTES = Math.round(LOW_DISK_POLL_INTERVAL_MS / 60_000);

/**
 * 红条文案。只有「严重」且读得到剩余空间才有；其它级别 / 没读到 = null（调用方不画条）。
 * 面向普通用户：不写 errno / statfs，讲清「会怎样、该做什么、提示何时消失」。
 */
export const describeLowDisk = (reading: DiskReading | null): LowDiskCopy | null => {
  if (!reading || reading.level !== "critical" || reading.freeMB === null) return null;
  return {
    title: `磁盘空间严重不足，只剩约 ${formatFreeMB(reading.freeMB)}`,
    detail: `新的对话和任务记录随时可能保存不了，自动更新也可能被拦下。请尽快清理磁盘；腾出空间后这条提示会自动消失（最长约 ${POLL_MINUTES} 分钟，切回本窗口时会更快）。`,
  };
};
