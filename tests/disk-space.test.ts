/**
 * 磁盘剩余空间换算（electron-app/disk-space.mjs）的纯函数单测。
 *
 * 动机（合并前评审指出）：预检的单位换算原先**零测试保护**，而它是存量用户升级时的唯一防线——
 * NSIS 写成 `/ 1073741824`（GB）几乎所有人被静默拦截，写成 `/ 1024`（KB）预检形同虚设，
 * main.js 的 `diskFreeGB` 单位写错则日志数字错误、误导排障——这些改动当时全部让测试保持绿色。
 * 现在换算是可注入 statfs 的纯函数，边界在 Mac 上就能测掉。
 */
import { describe, expect, it } from "vitest";

import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  bytesToMB,
  formatFreeGB,
  formatGB,
  freeBytes,
} from "../electron-app/disk-space.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 造一个假 statfs：bavail 个可用块、每块 bsize 字节；bfree 故意给个不一样的大数来证明没被用到 */
const fakeStatfs =
  (bavail: number | bigint, bsize: number | bigint = 4096) =>
  () => ({ bavail, bsize, bfree: 999_999_999 });

describe("单位常量", () => {
  it("1MB = 1024², 1GB = 1024³（不是 1000 进制）", () => {
    expect(BYTES_PER_MB).toBe(1_048_576);
    expect(BYTES_PER_GB).toBe(1_073_741_824);
    expect(BYTES_PER_GB).toBe(BYTES_PER_MB * 1024);
  });
});

describe("freeBytes", () => {
  it("可用字节 = bavail × bsize（不用 bfree：它含非特权用户用不了的保留块）", () => {
    expect(freeBytes("/x", fakeStatfs(100, 4096))).toBe(409_600);
    expect(freeBytes("/x", fakeStatfs(0, 4096))).toBe(0);
  });

  it("statfs 抛错（目录不存在 / UNC / 无权限）→ null，不抛", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(freeBytes("/nope", boom)).toBeNull();
  });

  it("数值异常（NaN / 负数 / 缺字段）→ null，绝不当成 0 去误拦", () => {
    expect(freeBytes("/x", fakeStatfs(Number.NaN))).toBeNull();
    expect(freeBytes("/x", fakeStatfs(-1))).toBeNull();
    expect(freeBytes("/x", () => ({}) as never)).toBeNull();
  });

  it("把目录原样交给 statfs（Windows 上传 os.tmpdir() 就量 TEMP 所在盘）", () => {
    const seen: string[] = [];
    freeBytes("C:\\Users\\me\\AppData\\Local\\Temp", (d) => {
      seen.push(d);
      return { bavail: 1, bsize: 1 };
    });
    expect(seen).toEqual(["C:\\Users\\me\\AppData\\Local\\Temp"]);
  });
});

describe("bytesToMB：向下取整，与 NSIS 的 Int64Op 整除一致", () => {
  it("恰好 1MB → 1；差 1 字节 → 0", () => {
    expect(bytesToMB(MB)).toBe(1);
    expect(bytesToMB(MB - 1)).toBe(0);
  });

  it("800MB 边界：799.99MB 取 799、800MB 取 800", () => {
    expect(bytesToMB(800 * MB - 1)).toBe(799);
    expect(bytesToMB(800 * MB)).toBe(800);
    expect(bytesToMB(800 * MB + 1)).toBe(800);
  });

  it("1GB = 1024MB（量级对：差 1024 倍就是这里写错）", () => {
    expect(bytesToMB(GB)).toBe(1024);
    expect(bytesToMB(512 * GB)).toBe(524_288);
  });
});

describe("formatGB / formatFreeGB：给人看的日志数字", () => {
  it("一位小数、1024 进制", () => {
    expect(formatGB(GB)).toBe("1.0");
    expect(formatGB(1.5 * GB)).toBe("1.5");
    expect(formatGB(512 * MB)).toBe("0.5");
    expect(formatGB(0)).toBe("0.0");
  });

  it("formatFreeGB：取到 → GB 文案；取不到 → \"?\"", () => {
    // 262144 块 × 4096 = 1GB
    expect(formatFreeGB("/x", fakeStatfs(262_144, 4096))).toBe("1.0");
    expect(formatFreeGB("/x", fakeStatfs(Number.NaN))).toBe("?");
    expect(
      formatFreeGB("/x", () => {
        throw new Error("EACCES");
      }),
    ).toBe("?");
  });

  it("bigint 入参也能算（statfsSync 带 bigint:true 时）", () => {
    expect(formatFreeGB("/x", fakeStatfs(262_144n, 4096n))).toBe("1.0");
  });
});
