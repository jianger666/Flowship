import { NextResponse } from "next/server";

import { dataRoot } from "@/lib/server/data-root";
import { readDiskReading } from "@/lib/server/disk-free";

export const runtime = "nodejs";

/**
 * GET /api/system/disk（R14 B2-4c / Q15-10 的页面红条部分）
 *
 * 返回数据目录所在盘的剩余空间与级别：`{ level: "ok" | "low" | "critical" | "unknown", freeMB: number | null }`。
 * 页面（`useLowDisk`）启动时取一次、之后每 5 分钟 / 窗口回到前台时取，剩余 < 500MB（critical）时画红条。
 *
 * - 只做一次 statfs，很便宜，每次现量、不缓存（`Cache-Control: no-store`）；
 * - 量不到（statfs 抛 / 数值异常）不报错：200 + `{ unknown, null }`，页面保持上一次的结论；
 * - 响应里没有路径等任何环境信息，只有两个数；
 * - 阈值 / 分级在 `lib/low-disk.ts`，与壳侧 `electron-app/disk-watch.mjs` 的同一组数由契约测试对账。
 */
export const GET = async () =>
  NextResponse.json(await readDiskReading(dataRoot()), {
    headers: { "Cache-Control": "no-store" },
  });
