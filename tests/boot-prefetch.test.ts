/** 首次启动并行预读：门禁 / 清单校验 / 并发上限 / 时限 / 失败隔离 / 统计。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BOOT_MANIFEST_FILENAME,
  PREFETCH_CONCURRENCY,
  PREFETCH_DEADLINE_MS,
  PREFETCH_MAX_FILES,
  READ_PROBE_CAP_MS,
  READ_PROBE_SAMPLE,
  formatPrefetchSummary,
  formatReadProbe,
  parseBootManifest,
  runPrefetch,
  runReadProbe,
  shouldPrefetch,
} from "../electron-app/boot-prefetch.mjs";

const manifest = (files: unknown) => JSON.stringify({ version: 1, files });

describe("shouldPrefetch：只有 Windows + 首次启动才预读", () => {
  it("四种组合只有 win32 && firstBoot 为真", () => {
    expect(shouldPrefetch({ platform: "win32", firstBoot: true })).toBe(true);
    expect(shouldPrefetch({ platform: "win32", firstBoot: false })).toBe(false);
    expect(shouldPrefetch({ platform: "darwin", firstBoot: true })).toBe(false);
    expect(shouldPrefetch({ platform: "linux", firstBoot: true })).toBe(false);
  });

  it("FLOWSHIP_NO_PREFETCH=1 是关闭开关；其它取值不算", () => {
    expect(
      shouldPrefetch({ platform: "win32", firstBoot: true, env: { FLOWSHIP_NO_PREFETCH: "1" } }),
    ).toBe(false);
    expect(
      shouldPrefetch({ platform: "win32", firstBoot: true, env: { FLOWSHIP_NO_PREFETCH: "0" } }),
    ).toBe(true);
    expect(shouldPrefetch({ platform: "win32", firstBoot: true, env: {} })).toBe(true);
  });

  it("firstBoot 必须严格为 true（truthy 的字符串 / 数字不算）", () => {
    expect(shouldPrefetch({ platform: "win32", firstBoot: "yes" as unknown as boolean })).toBe(false);
    expect(shouldPrefetch({ platform: "win32", firstBoot: 1 as unknown as boolean })).toBe(false);
  });
});

describe("parseBootManifest：清单是数据，不信任", () => {
  it("合法清单：保序、去重", () => {
    const m = parseBootManifest(manifest(["server.js", "node_modules/next/dist/a.js", "server.js"]));
    expect(m?.files).toEqual(["server.js", "node_modules/next/dist/a.js"]);
  });

  it("没有文件 / 空 / 非 JSON / 形状不对 → null（调用方当没有清单）", () => {
    expect(parseBootManifest(null)).toBeNull();
    expect(parseBootManifest(undefined)).toBeNull();
    expect(parseBootManifest("")).toBeNull();
    expect(parseBootManifest("{not json")).toBeNull();
    expect(parseBootManifest("null")).toBeNull();
    expect(parseBootManifest(JSON.stringify({ files: "server.js" }))).toBeNull();
    expect(parseBootManifest(manifest([]))).toBeNull();
  });

  it("危险条目整条丢弃（不是整份报废）：绝对路径 / .. / 反斜杠 / 盘符 / 空段 / 非字符串", () => {
    const m = parseBootManifest(
      manifest([
        "ok/a.js",
        "/etc/passwd",
        "../outside.js",
        "a/../../b.js",
        "a\\b.js",
        "C:/Windows/x.dll",
        "C:x",
        "a//b.js",
        "",
        42,
        null,
        "ok/b.js",
      ]),
    );
    expect(m?.files).toEqual(["ok/a.js", "ok/b.js"]);
  });

  it("条数有上限（坏清单不能让我们读一辈子）", () => {
    const many = Array.from({ length: PREFETCH_MAX_FILES + 50 }, (_, i) => `f/${i}.js`);
    expect(parseBootManifest(manifest(many))?.files).toHaveLength(PREFETCH_MAX_FILES);
  });

  it("清单文件名与默认并发 / 时限是约定值（改动要同步 gen-boot-manifest 与 main.js）", () => {
    expect(BOOT_MANIFEST_FILENAME).toBe("boot-manifest.json");
    expect(PREFETCH_CONCURRENCY).toBe(8);
    expect(PREFETCH_DEADLINE_MS).toBe(90_000);
  });
});

describe("runPrefetch", () => {
  const files = Array.from({ length: 40 }, (_, i) => `d/${i}.js`);

  it("读完清单里每个文件、字节数累加、永不抛错", async () => {
    const seen: string[] = [];
    const stats = await runPrefetch({
      serverDir: "/srv",
      files,
      readFile: async (abs) => {
        seen.push(abs);
        return 10;
      },
    });
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    expect(stats).toMatchObject({ total: 40, ok: 40, failed: 0, skipped: 0, notReached: 0, bytes: 400, timedOut: false });
  });

  it("并发有上限：任何时刻在途读取数不超过 concurrency（线程池是进程共享的，不能把主进程饿死）", async () => {
    let inflight = 0;
    let peak = 0;
    await runPrefetch({
      serverDir: "/srv",
      files,
      concurrency: 5,
      readFile: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return 1;
      },
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1); // 真的并行了，不是串行
  });

  it("并发取值兜底：0 / 负数 / NaN 当 1，文件数少于并发时不多开", async () => {
    for (const c of [0, -3, Number.NaN]) {
      const stats = await runPrefetch({ serverDir: "/srv", files: ["a.js", "b.js"], concurrency: c, readFile: async () => 1 });
      expect(stats.ok).toBe(2);
      expect(stats.concurrency).toBeGreaterThanOrEqual(1);
    }
    const few = await runPrefetch({ serverDir: "/srv", files: ["a.js", "b.js"], concurrency: 8, readFile: async () => 1 });
    expect(few.concurrency).toBe(2);
  });

  it("单个文件失败不影响其它文件：计入 failed、整体照常完成", async () => {
    const stats = await runPrefetch({
      serverDir: "/srv",
      files,
      readFile: async (abs) => {
        if (abs.endsWith(`${path.sep}3.js`) || abs.endsWith(`${path.sep}7.js`)) throw new Error("EPERM");
        return 1;
      },
    });
    expect(stats.failed).toBe(2);
    expect(stats.ok).toBe(38);
    expect(stats.notReached).toBe(0);
  });

  it("读取返回 -1 表示跳过（超大文件），计入 skipped、不计字节", async () => {
    const stats = await runPrefetch({
      serverDir: "/srv",
      files: ["a.js", "big.bin", "b.js"],
      readFile: async (abs) => (abs.endsWith("big.bin") ? -1 : 5),
    });
    expect(stats).toMatchObject({ ok: 2, skipped: 1, bytes: 10 });
  });

  it("总时限：到点不再派新文件（在途的自然结束），notReached 记下没读到的", async () => {
    let clock = 0;
    const stats = await runPrefetch({
      serverDir: "/srv",
      files,
      concurrency: 1,
      deadlineMs: 100,
      now: () => clock,
      readFile: async () => {
        clock += 30; // 每个文件「花」30ms：第 4 个读完时已 120ms > 100ms
        return 1;
      },
    });
    expect(stats.timedOut).toBe(true);
    expect(stats.ok).toBe(4);
    expect(stats.notReached).toBe(36);
  });

  it("越界路径二次防线：解析后跳出 server 目录的条目不读（即便绕过了 parseBootManifest）", async () => {
    const calls: string[] = [];
    const stats = await runPrefetch({
      serverDir: "/srv/app",
      files: ["../evil.js", "ok.js", "a/../../evil2.js"],
      readFile: async (abs) => {
        calls.push(abs);
        return 1;
      },
    });
    expect(calls).toEqual([path.resolve("/srv/app", "ok.js")]);
    expect(stats.skipped).toBe(2);
    expect(stats.ok).toBe(1);
  });

  it("统计：avgPerFile 是单文件耗时均值（= 这台机器冷读一个文件的延迟 L 的上界）、p95 / max", async () => {
    let clock = 0;
    const durations = [10, 10, 10, 10, 10, 10, 10, 10, 10, 100];
    let i = 0;
    const stats = await runPrefetch({
      serverDir: "/srv",
      files: durations.map((_, k) => `f${k}.js`),
      concurrency: 1,
      now: () => clock,
      readFile: async () => {
        clock += durations[i++];
        return 1;
      },
    });
    expect(stats.avgMs).toBeCloseTo(19, 5);
    expect(stats.maxMs).toBe(100);
    expect(stats.p95Ms).toBe(100);
    expect(stats.elapsedMs).toBe(190);
  });

  it("空清单不抛错、全是 0", async () => {
    const stats = await runPrefetch({ serverDir: "/srv", files: [], readFile: async () => 1 });
    expect(stats).toMatchObject({ total: 0, ok: 0, failed: 0, avgMs: 0, p95Ms: 0, maxMs: 0 });
  });

  it("默认读取走真实文件系统：读到真实字节数；不存在的文件计 failed；超过体积上限的跳过", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prefetch-test-"));
    try {
      mkdirSync(path.join(root, "sub"), { recursive: true });
      writeFileSync(path.join(root, "a.js"), "x".repeat(100));
      writeFileSync(path.join(root, "sub", "b.js"), "y".repeat(50));
      const stats = await runPrefetch({ serverDir: root, files: ["a.js", "sub/b.js", "missing.js"] });
      expect(stats).toMatchObject({ ok: 2, failed: 1, bytes: 150 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("formatPrefetchSummary", () => {
  it("一行日志含全部关键数字（事后 grep / 对比用）", async () => {
    const stats = await runPrefetch({ serverDir: "/srv", files: ["a.js"], readFile: async () => 2 * 1048576 });
    const line = formatPrefetchSummary(stats);
    for (const key of ["files=1/1", "failed=0", "skipped=0", "notReached=0", "bytes=2.0MB", "elapsed=", "avgPerFile=", "p95=", "max=", "concurrency=1", "timedOut=false"]) {
      expect(line, key).toContain(key);
    }
  });
});

describe("runReadProbe：串行冷读 + 同一批热读，量出「首次读一个文件到底多久」", () => {
  const files = Array.from({ length: 100 }, (_, i) => `f${i}.js`);

  it("采样点在清单里均匀分布（不是前 N 个）、数量 = sample", async () => {
    const seen: string[] = [];
    await runReadProbe({
      serverDir: "/srv",
      files,
      sample: 10,
      readFile: async (abs: string) => {
        seen.push(path.basename(abs));
        return 1;
      },
    });
    // 冷读 10 个 + 热读同样 10 个
    expect(seen).toHaveLength(20);
    const cold = seen.slice(0, 10);
    expect(new Set(cold).size).toBe(10);
    const idx = cold.map((n) => Number(n.slice(1, -3)));
    expect(idx[0]).toBeLessThan(10);
    expect(idx[9]).toBeGreaterThanOrEqual(90);
    // 间隔大致均匀（每步约 10）
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(9);
  });

  it("清单比 sample 短时全部读；热读读的恰好是冷读成功的那一批", async () => {
    const calls: string[] = [];
    const r = await runReadProbe({
      serverDir: "/srv",
      files: ["a.js", "b.js", "c.js"],
      sample: 16,
      readFile: async (abs: string) => {
        calls.push(path.basename(abs));
        return 5;
      },
    });
    expect(calls).toEqual(["a.js", "b.js", "c.js", "a.js", "b.js", "c.js"]);
    expect(r.requested).toBe(3);
    expect(r.cold.n).toBe(3);
    expect(r.warm.n).toBe(3);
    expect(r.failed).toBe(0);
  });

  it("冷 / 热耗时分开统计：注入时钟，冷读每个 40ms、热读每个 1ms", async () => {
    let t = 0;
    let phase: "cold" | "warm" = "cold";
    const seen = new Set<string>();
    const r = await runReadProbe({
      serverDir: "/srv",
      files: ["a.js", "b.js", "c.js", "d.js"],
      sample: 4,
      now: () => t,
      readFile: async (abs: string) => {
        phase = seen.has(abs) ? "warm" : "cold";
        seen.add(abs);
        t += phase === "cold" ? 40 : 1;
        return 1;
      },
    });
    expect(r.cold.avgMs).toBe(40);
    expect(r.cold.maxMs).toBe(40);
    expect(r.warm.avgMs).toBe(1);
    expect(r.capped).toBe(false);
  });

  it("总时限：冷读很慢时到点就停、不再读新文件（探针不能把启动拖住），热读只读已读成功的", async () => {
    let t = 0;
    const r = await runReadProbe({
      serverDir: "/srv",
      files,
      sample: 16,
      capMs: 100,
      now: () => t,
      readFile: async () => {
        t += 60;
        return 1;
      },
    });
    expect(r.capped).toBe(true);
    // 60ms 一个、100ms 的时限：读完第 2 个时已超 100 → 第 3 个不再读
    expect(r.cold.n).toBe(2);
    expect(r.warm.n).toBe(2);
  });

  it("失败隔离：读失败的计入 failed、不抛错、不进热读；skipped(-1) 不算失败也不进热读", async () => {
    const r = await runReadProbe({
      serverDir: "/srv",
      files: ["ok.js", "boom.js", "big.bin"],
      sample: 3,
      readFile: async (abs: string) => {
        if (abs.endsWith("boom.js")) throw new Error("EPERM");
        if (abs.endsWith("big.bin")) return -1;
        return 3;
      },
    });
    expect(r.failed).toBe(1);
    expect(r.cold.n).toBe(1);
    expect(r.warm.n).toBe(1);
  });

  it("清单里越出 server 目录的条目不读（二次防线）", async () => {
    const calls: string[] = [];
    await runReadProbe({
      serverDir: "/srv/app",
      files: ["../escape.js", "in.js"],
      sample: 2,
      readFile: async (abs: string) => {
        calls.push(abs);
        return 1;
      },
    });
    expect(calls.every((c) => c.startsWith(path.resolve("/srv/app") + path.sep))).toBe(true);
    expect(calls.some((c) => c.endsWith("escape.js"))).toBe(false);
  });

  it("默认参数：采样 16、冷读时限 1.5s", () => {
    expect(READ_PROBE_SAMPLE).toBe(16);
    expect(READ_PROBE_CAP_MS).toBe(1500);
  });

  it("formatReadProbe 一行里同时有冷 / 热两组数", () => {
    const line = formatReadProbe({
      requested: 16,
      failed: 0,
      capped: false,
      cold: { n: 16, avgMs: 41.25, p95Ms: 90, maxMs: 120.5 },
      warm: { n: 16, avgMs: 0.123, p95Ms: 0.4, maxMs: 0.9 },
      elapsedMs: 1234,
    });
    expect(line).toContain("cold n=16/16 avg=41.3ms p95=90.0ms max=120.5ms");
    expect(line).toContain("warm n=16 avg=0.12ms");
    expect(line).toContain("capped=false elapsed=1.2s");
  });
});
