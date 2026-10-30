/**
 * 低磁盘预警的纯函数与「壳 ↔ 页面」契约（R14 B2-4c / Q15-10 的页面红条部分）：
 *   src/lib/low-disk.ts（前后端共用）、src/lib/server/disk-free.ts（服务端换算）
 *   A. 分级（严格小于、边界、非法值 = unknown）
 *   B. 契约对账：常量、分级边界、MB / GB 文案、字节 → MB 换算口径，与壳侧 electron-app/disk-watch.mjs / disk-space.mjs 逐点一致
 *      ——页面侧必须写一份阈值（Next 构建 import 不了 electron-app/*.mjs），所以靠这里把两边钉死：任何一边单改都会红
 *   C. 读数形状与合并（前端不信任响应体；unknown 不覆盖上一次的结论）
 *   D. 红条文案（只有「严重」有、带剩余空间、不是降级红条的事实口吻、不含 errno、分钟数与轮询常量同步）
 * 红条组件的渲染在 low-disk-bar.test.ts，调度在 low-disk-poller.test.ts，路由在 system-disk-route.test.ts，接线在 low-disk-wiring.test.ts。
 * ⚠ 纯函数 + 假数据：没有在真实 Electron / 浏览器里把盘写满、没有看过红条。
 */
import { describe, expect, it } from "vitest";

import { bytesToMB, formatMB, freeBytes, MIN_MAC_STAGE_FREE_MB, MIN_TEMP_FREE_MB } from "../electron-app/disk-space.mjs";
import * as shell from "../electron-app/disk-watch.mjs";
import {
  LOW_DISK_CRITICAL_MB,
  LOW_DISK_MIN_GAP_MS,
  LOW_DISK_POLL_INTERVAL_MS,
  LOW_DISK_WARN_MB,
  classifyDiskLevel,
  describeLowDisk,
  formatFreeMB,
  isDiskReading,
  mergeDiskReading,
  sameDiskReading,
  type DiskReading,
} from "@/lib/low-disk";
import { freeMBOf } from "@/lib/server/disk-free";

const r = (level: DiskReading["level"], freeMB: number | null): DiskReading => ({ level, freeMB });

describe("A. classifyDiskLevel：严格小于、边界、非法值", () => {
  it.each([
    [0, "critical"],
    [1, "critical"],
    [499, "critical"],
    [499.9, "critical"],
    [500, "low"],
    [501, "low"],
    [2047, "low"],
    [2047.9, "low"],
    [2048, "ok"],
    [2049, "ok"],
    [10_000_000, "ok"],
  ] as const)("%s MB → %s", (mb, level) => {
    expect(classifyDiskLevel(mb)).toBe(level);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["负数", -1],
    ["负小数", -0.5],
    ["数字字符串", "100"],
    ["null", null],
    ["undefined", undefined],
    ["对象", {}],
  ])("非法值 %s → unknown（既不报警，也不当成「没问题」）", (_name, v) => {
    expect(classifyDiskLevel(v)).toBe("unknown");
  });
});

describe("B. 壳 ↔ 页面契约：同一组阈值、同一套分级、同一套文案、同一个换算口径", () => {
  it("两个阈值与壳侧 disk-watch.mjs 相等", () => {
    expect(LOW_DISK_WARN_MB).toBe(shell.LOW_DISK_WARN_MB);
    expect(LOW_DISK_CRITICAL_MB).toBe(shell.LOW_DISK_CRITICAL_MB);
  });

  it("分级逐点与壳侧一致（含边界与非法值）", () => {
    const inputs: unknown[] = [
      0, 1, 499, 499.9, 500, 500.1, 1999, 2047, 2047.9, 2048, 2049, 1e6, -1, Number.NaN, Number.POSITIVE_INFINITY, "9", null, undefined, {},
    ];
    for (const x of inputs) {
      // 壳侧的 JSDoc 参数类型是 number | null | undefined；这里故意喂非法值，断言绕开类型
      expect(classifyDiskLevel(x), `输入 ${String(x)}`).toBe(shell.classifyDiskLevel(x as number | null | undefined));
    }
  });

  it("MB / GB 文案逐点与壳侧 formatMB 一致（1023 → MB，1024 → GB，一位小数）", () => {
    for (const mb of [0, 1, 499, 500, 1023, 1024, 1025, 1536, 2047, 2048, 10_240]) {
      expect(formatFreeMB(mb), `${mb}MB`).toBe(formatMB(mb));
    }
    expect(formatFreeMB(1023)).toBe("1023 MB");
    expect(formatFreeMB(1024)).toBe("1.0 GB");
  });

  it("字节 → MB 的换算口径与壳侧 freeBytes + bytesToMB 一致：bavail 不是 bfree、向下取整、异常值 = 量不到", async () => {
    const cases: Array<[string, number | bigint, number | bigint]> = [
      ["恰好 0 字节", 0, 4096],
      ["不足 1MB（1048575 字节）→ 0", 1_048_575, 1],
      ["恰好 1MB", 1_048_576, 1],
      ["255 块 × 4096 = 1044480 字节 → 0", 255, 4096],
      ["256 块 × 4096 = 1MB", 256, 4096],
      ["bigint（Windows / 大盘上 statfs 可能给 bigint）", BigInt(512_000), BigInt(4096)],
      ["很大的盘", 4_000_000_000, 4096],
      ["NaN 块数", Number.NaN, 4096],
      ["负块数", -1, 4096],
      ["NaN 块大小", 10, Number.NaN],
    ];
    for (const [name, bavail, bsize] of cases) {
      // 带一个诱饵 bfree（含保留块、远大于 bavail）：两边都只能认 bavail——任何一边偷偷改用 bfree，这里就对不上
      const result = { bavail, bsize, bfree: 99_999_999 };
      const sync = freeBytes("/x", () => result);
      const expected = sync === null ? null : bytesToMB(sync);
      const got = await freeMBOf("/x", async () => result);
      expect(got, name).toBe(expected);
    }
  });

  it("只用 bavail、不用 bfree：statfs 同时给了 bfree 时也只认 bavail（保留块用不了）", async () => {
    const statfs = async () => ({ bavail: 256, bsize: 4096, bfree: 99_999_999 });
    expect(await freeMBOf("/x", statfs)).toBe(1);
  });

  it("阈值与更新预检线的大小关系（文案「自动更新也可能被拦下」成立的前提）：严重线低于两条更新线，偏低线高于它们", () => {
    expect(LOW_DISK_CRITICAL_MB).toBeLessThan(MIN_MAC_STAGE_FREE_MB);
    expect(LOW_DISK_CRITICAL_MB).toBeLessThan(MIN_TEMP_FREE_MB);
    expect(LOW_DISK_WARN_MB).toBeGreaterThan(MIN_MAC_STAGE_FREE_MB);
    expect(LOW_DISK_WARN_MB).toBeGreaterThan(MIN_TEMP_FREE_MB);
  });

  it("页面轮询比壳侧通知检查勤（红条消失得比下一次系统通知快）；防抖间隔小于轮询间隔", () => {
    expect(LOW_DISK_POLL_INTERVAL_MS).toBeLessThan(shell.DISK_CHECK_INTERVAL_MS);
    expect(LOW_DISK_MIN_GAP_MS).toBeLessThan(LOW_DISK_POLL_INTERVAL_MS);
  });
});

describe("C. 读数形状与合并", () => {
  it.each([
    [r("ok", 10_000)],
    [r("low", 1000)],
    [r("critical", 0)],
    [r("unknown", null)],
  ])("合法读数 %j", (v) => {
    expect(isDiskReading(v)).toBe(true);
  });

  it.each([
    ["null", null],
    ["字符串", "critical"],
    ["数组", []],
    ["缺 level", { freeMB: 10 }],
    ["未知 level", { level: "full", freeMB: 10 }],
    ["level 不是字符串", { level: 1, freeMB: 10 }],
    ["缺 freeMB", { level: "ok" }],
    ["freeMB 是字符串", { level: "ok", freeMB: "10" }],
    ["freeMB 是 NaN", { level: "ok", freeMB: Number.NaN }],
    ["freeMB 是 Infinity", { level: "ok", freeMB: Number.POSITIVE_INFINITY }],
    ["freeMB 是负数", { level: "critical", freeMB: -5 }],
    ["报错页的 JSON", { error: "仅允许本机访问（Host/Origin 校验失败）" }],
  ])("形状不对 %s → 当成没取到", (_name, v) => {
    expect(isDiskReading(v)).toBe(false);
  });

  it("sameDiskReading：null 只和 null 相同；有值时 level 与 freeMB 都相同才算相同", () => {
    expect(sameDiskReading(null, null)).toBe(true);
    expect(sameDiskReading(null, r("ok", 1))).toBe(false);
    expect(sameDiskReading(r("ok", 1), null)).toBe(false);
    expect(sameDiskReading(r("critical", 300), r("critical", 300))).toBe(true);
    expect(sameDiskReading(r("critical", 300), r("critical", 299))).toBe(false);
    expect(sameDiskReading(r("critical", 300), r("low", 300))).toBe(false);
  });

  it("mergeDiskReading：第一次读数直接采用；相同读数保持原引用（setState 会跳过重渲染）", () => {
    const first = r("critical", 300);
    expect(mergeDiskReading(null, first)).toBe(first);
    const prev = r("critical", 300);
    expect(mergeDiskReading(prev, r("critical", 300))).toBe(prev);
  });

  it("mergeDiskReading：数值变了就采用新的（红条标题里的剩余空间要跟着变）", () => {
    const next = r("critical", 120);
    expect(mergeDiskReading(r("critical", 300), next)).toBe(next);
  });

  it("mergeDiskReading：恢复（critical → ok / low）与恶化（ok → critical）都采用新读数", () => {
    const ok = r("ok", 5000);
    expect(mergeDiskReading(r("critical", 300), ok)).toBe(ok);
    const low = r("low", 1000);
    expect(mergeDiskReading(r("critical", 300), low)).toBe(low);
    const bad = r("critical", 200);
    expect(mergeDiskReading(ok, bad)).toBe(bad);
  });

  it("mergeDiskReading：这次没量到（unknown）不覆盖上一次的结论——红条不闪、也不把「其实还是满的」当成恢复", () => {
    const prev = r("critical", 300);
    expect(mergeDiskReading(prev, r("unknown", null))).toBe(prev);
    expect(mergeDiskReading(null, r("unknown", null))).toBeNull();
  });
});

describe("D. describeLowDisk：红条文案", () => {
  it.each([
    ["null", null],
    ["ok", r("ok", 5000)],
    ["low（500MB–2GB 只有壳侧系统通知，页面不画常驻条）", r("low", 1000)],
    ["unknown", r("unknown", null)],
    ["critical 但没有剩余空间数值（不该出现，防御）", r("critical", null)],
  ])("%s → 没有文案（调用方不画条）", (_name, reading) => {
    expect(describeLowDisk(reading)).toBeNull();
  });

  it.each([
    [0, "0 MB"],
    [1, "1 MB"],
    [300, "300 MB"],
    [499, "499 MB"],
  ])("critical %s MB → 标题带「只剩约 %s」", (mb, text) => {
    const copy = describeLowDisk(r("critical", mb));
    expect(copy?.title).toBe(`磁盘空间严重不足，只剩约 ${text}`);
  });

  it("补充说明：讲清会怎样、该做什么、何时消失；不是降级红条的「没能保存」口吻；不含 errno", () => {
    const copy = describeLowDisk(r("critical", 300));
    expect(copy).not.toBeNull();
    const text = `${copy!.title}${copy!.detail}`;
    expect(copy!.detail).toContain("随时可能保存不了");
    expect(copy!.detail).toContain("自动更新也可能被拦下");
    expect(copy!.detail).toContain("清理磁盘");
    expect(copy!.detail).toContain("自动消失");
    // 预警 ≠ 已发生：B2-2 的降级红条才说「没能保存」，这里不能让用户误以为数据已经丢了
    expect(text).not.toContain("没能保存");
    expect(text).not.toMatch(/ENOSPC|EDQUOT|EROFS|EIO|errno|statfs/i);
    expect(text).not.toMatch(/undefined|NaN|null/);
  });

  it("文案里的「最长约 N 分钟」与页面轮询间隔同步（改了常量文案会跟着变，不会说谎）", () => {
    const copy = describeLowDisk(r("critical", 300));
    expect(copy!.detail).toContain(`最长约 ${LOW_DISK_POLL_INTERVAL_MS / 60_000} 分钟`);
  });
});
