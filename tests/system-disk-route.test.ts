/**
 * 数据目录剩余空间的服务端实现与路由（R14 B2-4c）：src/lib/server/disk-free.ts、GET /api/system/disk
 *   A. readDiskReading（statfs 注入）：分级边界、量不到、目录不存在逐级向上找、不死循环、只读不写
 *   B. GET 路由（真实 statfs）：形状、no-store、数据目录还没建也能量、响应里没有路径、statfs 抛了不报 500
 *   C. 路由源码契约：量的是数据根（dataRoot）不是 tasks 子目录、不接收任何输入、no-store
 * 页面怎么用它见 low-disk-poller.test.ts / low-disk-wiring.test.ts；与壳侧口径的对账见 low-disk.test.ts。
 * ⚠ 没有在真的写满的盘上跑过；「量不到」用注入 / mock 的 statfs 模拟。
 */
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只替换 statfs（默认走真实实现），好让个别用例模拟「量不到」；其余导出原样保留
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

import { GET } from "@/app/api/system/disk/route";
import { classifyDiskLevel, isDiskReading } from "@/lib/low-disk";
import { readDiskReading, type StatfsFn } from "@/lib/server/disk-free";

const MB = 1048576;
/** 构造「剩余恰好 mb MB」的 statfs 结果（块大小 4096） */
const statfsOf =
  (mb: number, extraBytes = 0): StatfsFn =>
  async () => ({ bavail: (mb * MB + extraBytes) / 4096, bsize: 4096 });
const enoent = (): Error => Object.assign(new Error("ENOENT: no such file or directory, statfs"), { code: "ENOENT" });

describe("A. readDiskReading（statfs 注入）", () => {
  it.each([
    [0, "critical"],
    [499, "critical"],
    [500, "low"],
    [2047, "low"],
    [2048, "ok"],
    [100_000, "ok"],
  ] as const)("剩余 %s MB → %s，freeMB 原样带回", async (mb, level) => {
    expect(await readDiskReading("/data", statfsOf(mb))).toEqual({ level, freeMB: mb });
  });

  it("向下取整：499MB 多出半 MB 多（150 个 4K 块 ≈ 0.59MB）仍是 499，不会四舍五入成 500 而躲过「严重」", async () => {
    expect(await readDiskReading("/data", statfsOf(499, 150 * 4096))).toEqual({ level: "critical", freeMB: 499 });
    // 反过来：不足 1MB 的零头不会被丢成「少一档」——恰好 500MB 少一个块（4096 字节）→ 499
    expect(await readDiskReading("/data", async () => ({ bavail: 500 * 256 - 1, bsize: 4096 }))).toEqual({
      level: "critical",
      freeMB: 499,
    });
  });

  it("量不到（statfs 抛）→ unknown / null，不外抛", async () => {
    const statfs: StatfsFn = async () => {
      throw enoent();
    };
    expect(await readDiskReading(path.resolve("/data/x"), statfs)).toEqual({ level: "unknown", freeMB: null });
  });

  it("数值异常（NaN / 负数）也算量不到，不会被当成 0MB 误报「严重」", async () => {
    expect(await readDiskReading("/data", async () => ({ bavail: Number.NaN, bsize: 4096 }))).toEqual({
      level: "unknown",
      freeMB: null,
    });
    expect(await readDiskReading("/data", async () => ({ bavail: -1, bsize: 4096 }))).toEqual({
      level: "unknown",
      freeMB: null,
    });
    expect(await readDiskReading("/data", async () => ({ bavail: Number.POSITIVE_INFINITY, bsize: 4096 }))).toEqual({
      level: "unknown",
      freeMB: null,
    });
  });

  it("数据目录还没建（全新安装）：逐级向上找到存在的目录，找到就停", async () => {
    const leaf = path.resolve(os.tmpdir(), "flowship-x", "data", "tasks");
    const calls: string[] = [];
    const statfs: StatfsFn = async (dir) => {
      calls.push(dir);
      if (dir === path.dirname(path.dirname(leaf))) return { bavail: (300 * MB) / 4096, bsize: 4096 }; // 往上两级才存在
      throw enoent();
    };
    expect(await readDiskReading(leaf, statfs)).toEqual({ level: "critical", freeMB: 300 });
    expect(calls).toEqual([leaf, path.dirname(leaf), path.dirname(path.dirname(leaf))]);
  });

  it("一路都量不到：爬到文件系统根就停（不死循环）", async () => {
    const calls: string[] = [];
    const statfs: StatfsFn = async (dir) => {
      calls.push(dir);
      throw enoent();
    };
    const shallow = path.resolve(path.parse(process.cwd()).root, "only-one-level");
    expect(await readDiskReading(shallow, statfs)).toEqual({ level: "unknown", freeMB: null });
    expect(calls).toEqual([shallow, path.parse(shallow).root]);
  });

  it("路径很深时最多向上找有限几级（防异常路径下空转）：本身 + 向上 8 级 = 恰好 9 次 statfs", async () => {
    let n = 0;
    const statfs: StatfsFn = async () => {
      n++;
      throw enoent();
    };
    const deep = path.resolve(os.tmpdir(), ...Array.from({ length: 40 }, (_, i) => `d${i}`));
    expect(await readDiskReading(deep, statfs)).toEqual({ level: "unknown", freeMB: null });
    // 常量 MAX_UP_LEVELS = 8（够从 <userData>/data 往上找到 userData 和它的父目录）；改它要同步改这里
    expect(n).toBe(9);
  });

  it("只读：整个过程只调用 statfs（没有 mkdir / 写文件）——量盘不能在盘快满时再往里写东西", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-disk-readonly-"));
    try {
      const target = path.join(dir, "not", "yet");
      await readDiskReading(target);
      expect(fs.existsSync(path.join(dir, "not"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("B. GET /api/system/disk（真实 statfs）", () => {
  let tmp = "";
  const saved = process.env.FLOWSHIP_DATA_DIR;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fe-disk-route-"));
    process.env.FLOWSHIP_DATA_DIR = tmp;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.mocked(fsp.statfs).mockClear();
  });

  it("200 + 合法读数；level 与 freeMB 自洽；no-store", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await res.json();
    expect(isDiskReading(body)).toBe(true);
    const reading = body as { level: string; freeMB: number | null };
    expect(reading.freeMB).not.toBeNull();
    expect(reading.freeMB!).toBeGreaterThan(0);
    expect(reading.level).toBe(classifyDiskLevel(reading.freeMB));
  });

  it("量的是 FLOWSHIP_DATA_DIR（数据根）本身：数据根存在时只量它一次（不是 tasks 子目录——那个不存在会靠「向上回退」绕回来，量对了也掩盖了量错）", async () => {
    await GET();
    expect(vi.mocked(fsp.statfs).mock.calls.map((c) => c[0])).toEqual([tmp]);
  });

  it("数据根还没建（全新安装首次打开页面）：仍量得到", async () => {
    process.env.FLOWSHIP_DATA_DIR = path.join(tmp, "not", "created", "yet");
    const body = (await (await GET()).json()) as { level: string; freeMB: number | null };
    expect(isDiskReading(body)).toBe(true);
    expect(body.level).not.toBe("unknown");
    expect(body.freeMB).not.toBeNull();
    expect(fs.existsSync(path.join(tmp, "not"))).toBe(false); // GET 不建目录
  });

  it("响应里只有 level 与 freeMB 两个字段，没有路径等环境信息", async () => {
    const text = JSON.stringify(await (await GET()).json());
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["freeMB", "level"]);
    expect(text).not.toContain(tmp);
    expect(text).not.toContain(os.tmpdir());
  });

  it("statfs 抛错：仍是 200 + { unknown, null }（页面保持上一次的结论），不报 500", async () => {
    vi.mocked(fsp.statfs).mockRejectedValue(enoent());
    try {
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ level: "unknown", freeMB: null });
    } finally {
      vi.mocked(fsp.statfs).mockReset();
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fsp.statfs).mockImplementation(actual.statfs);
    }
  });
});

describe("C. 路由源码契约", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/app/api/system/disk/route.ts"), "utf-8");
  /** 剥掉注释，只看代码（注释里会解释为什么不用 DATA_DIR，不剥会误判） */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("跑在 nodejs runtime（statfs 是 node:fs）", () => {
    expect(code).toMatch(/export const runtime = "nodejs"/);
  });

  it("量数据根 dataRoot()，不是 DATA_DIR（那是 <数据根>/tasks 子目录；壳侧量的是 userData/data）", () => {
    expect(code).toMatch(/\bdataRoot\(\)/);
    expect(code).not.toMatch(/\bDATA_DIR\b/);
  });

  it("不接收任何输入（没有 req 参数 / searchParams / 路径入参）——没有输入就没有路径遍历面", () => {
    expect(code).toMatch(/export const GET = async \(\) =>/);
    expect(code).not.toMatch(/searchParams|req\.|request\./);
  });

  it("响应带 Cache-Control: no-store", () => {
    expect(code).toMatch(/"Cache-Control":\s*"no-store"/);
  });
});
