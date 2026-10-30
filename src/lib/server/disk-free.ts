/**
 * 数据目录所在盘的剩余空间（R14 B2-4c，`GET /api/system/disk` 的实现）。statfs 可注入，边界全能单测。
 *
 * 口径与壳侧（electron-app/disk-space.mjs 的 freeBytes / bytesToMB）一致，契约测试对账：
 *  - 用 bavail 不用 bfree：bfree 含非特权用户用不了的保留块，要的是「我这个用户实际还能写多少」；
 *  - 字节 → MB 向下取整（1MB = 1024²）；
 *  - 数值异常（NaN / 负数 / 非有限）= 量不到。
 *
 * 量哪个目录：调用方传 `dataRoot()`——桌面端是壳注入的 FLOWSHIP_DATA_DIR（= `userData/data`，与壳侧量的是同一个目录），
 * 开发模式是 `cwd/data`。不要传 `DATA_DIR`：那是 `<数据根>/tasks` 子目录，首次建任务之前并不存在。
 * 与壳侧的差别：壳侧目录不存在就回退量 `userData`；这里（全新安装、目录还没建）逐级向上找，最多 MAX_UP_LEVELS 级——
 * 父目录与它同盘（嵌套挂载点的极端情况下会量成上层盘，与壳侧回退同一个假设）。
 */
import { statfs as nodeStatfs } from "node:fs/promises";
import path from "node:path";

import { classifyDiskLevel, type DiskReading } from "@/lib/low-disk";

const BYTES_PER_MB = 1048576;
/** 逐级向上找存在的目录的最大层数（够从 <userData>/data 找到 <userData> 和它的父目录；防止异常路径下无限爬） */
const MAX_UP_LEVELS = 8;

export type StatfsFn = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/** 目录所在盘「对当前用户可用」的 MB（向下取整）；量不到（不存在 / 无权限 / 数值异常）→ null。永不抛。 */
export const freeMBOf = async (dir: string, statfsFn: StatfsFn = nodeStatfs): Promise<number | null> => {
  try {
    const s = await statfsFn(dir);
    const bytes = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / BYTES_PER_MB) : null;
  } catch {
    return null;
  }
};

/** 量数据目录所在盘并分级；量不到 = { unknown, null }。永不抛。 */
export const readDiskReading = async (
  dataDir: string,
  statfsFn: StatfsFn = nodeStatfs,
): Promise<DiskReading> => {
  let dir = dataDir;
  for (let i = 0; i <= MAX_UP_LEVELS; i++) {
    const freeMB = await freeMBOf(dir, statfsFn);
    if (freeMB !== null) return { level: classifyDiskLevel(freeMB), freeMB };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { level: "unknown", freeMB: null };
};
