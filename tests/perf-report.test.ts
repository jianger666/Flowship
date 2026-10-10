/**
 * scripts/lib/perf-report.mjs：观测日志 → 分布 / 对比报告。
 *
 * 这份报告是「持续优化」的读数工具，所以数字本身必须可信——这里钉死：
 * 分位算法、分桶边界、哪些 run 参与哪类统计、预热效果的对比口径、
 * 前端「卡顿窗口占比」的估算口径、日志读取（轮转 / 坏行）与 CLI 行为。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_EVERY,
} from "@/lib/ui-perf-collector";
import {
  UI_HEARTBEAT_EVERY,
  buildReport,
  defaultLogsDir,
  dist,
  fmtDelta,
  idleBucket,
  loadLogs,
  padW,
  parseSince,
  pctl,
  readJsonl,
  renderText,
  scaleBucket,
  wlen,
} from "../scripts/lib/perf-report.mjs";

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const run = (over: Record<string, unknown> = {}) => ({
  v: 1,
  ts: iso(0),
  taskId: "t_1",
  kind: "chat",
  agentId: "a1",
  outcome: "ok",
  acceptMs: 300,
  ttftMs: 1200,
  totalMs: 8000,
  steps: 1,
  stepMsSum: 0,
  stepMsMax: 0,
  toolCount: 0,
  toolErrors: 0,
  tools: {},
  platform: "darwin",
  ...over,
});

const ui = (over: Record<string, unknown> = {}) => ({
  v: 1,
  ts: iso(0),
  reason: "interval",
  windowMs: 30_000,
  visibleMs: 30_000,
  longTasks: { n: 2, sumMs: 500, maxMs: 300, n100: 2, n250: 1 },
  inputs: { n: 3, p50Ms: 50, maxMs: 250, n200: 1 },
  ...over,
});

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const mkTmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), "perf-report-"));
  tmpDirs.push(d);
  return d;
};
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("统计基础", () => {
  it("线性插值分位：1..100 → p50 50.5 / p90 90.1 / p99 99.01", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(pctl(xs, 0.5)).toBeCloseTo(50.5);
    expect(pctl(xs, 0.9)).toBeCloseTo(90.1);
    expect(pctl(xs, 0.99)).toBeCloseTo(99.01);
    expect(pctl([], 0.5)).toBeUndefined();
    expect(pctl([7], 0.99)).toBe(7);
  });

  it("dist：丢弃非有限值；空 → { n: 0 }", () => {
    const d = dist([3, 1, 2, Number.NaN, undefined as unknown as number, "x" as unknown as number, Infinity]);
    expect(d.n).toBe(3);
    expect(d.p50).toBe(2);
    expect(d.max).toBe(3);
    expect(d.mean).toBe(2);
    expect(dist([])).toEqual({ n: 0 });
  });

  it("空闲分桶边界（1 分钟 / 5 分钟 / 30 分钟）", () => {
    expect(idleBucket(0)).toBe("<1m");
    expect(idleBucket(59_999)).toBe("<1m");
    expect(idleBucket(60_000)).toBe("1–5m");
    expect(idleBucket(299_999)).toBe("1–5m");
    expect(idleBucket(300_000)).toBe("5–30m");
    expect(idleBucket(1_799_999)).toBe("5–30m");
    expect(idleBucket(1_800_000)).toBe(">30m");
    expect(idleBucket(undefined)).toBe("未知");
    expect(idleBucket(Number.NaN)).toBe("未知");
  });

  it("会话规模分桶边界", () => {
    expect(scaleBucket(0.5)).toBe("<1MB");
    expect(scaleBucket(1)).toBe("1–5MB");
    expect(scaleBucket(5)).toBe("5–20MB");
    expect(scaleBucket(20)).toBe("≥20MB");
    expect(scaleBucket(undefined)).toBe("未知");
  });
});

describe("整体延迟：哪些 run 参与哪类统计", () => {
  it("受理统计所有已受理的 run；ttft / total 只统计成功收口的（失败的时序没有可比性）", () => {
    const r = buildReport({
      run: [
        run({ outcome: "ok", acceptMs: 100, ttftMs: 1000, totalMs: 5000 }),
        run({ outcome: "finished", acceptMs: 300, ttftMs: 3000, totalMs: 9000 }),
        run({ outcome: "error", acceptMs: 500, ttftMs: 99_999, totalMs: 99_999 }),
        run({ outcome: "cancelled", acceptMs: 700, ttftMs: 88_888, totalMs: 88_888 }),
      ],
    });
    expect(r.latency.acceptMs.n).toBe(4);
    expect(r.latency.ttftMs.n).toBe(2);
    expect(r.latency.ttftMs.max).toBe(3000);
    expect(r.latency.totalMs.max).toBe(9000);
    expect(r.outcomes).toEqual({ ok: 1, finished: 1, error: 1, cancelled: 1 });
  });

  it("按空闲时长分桶：每桶 n / ttft 中位数；缺失 idleBeforeMs 归「未知」", () => {
    const r = buildReport({
      run: [
        run({ idleBeforeMs: 30_000, ttftMs: 1000 }),
        run({ idleBeforeMs: 40_000, ttftMs: 1200 }),
        run({ idleBeforeMs: 600_000, ttftMs: 3000 }),
        run({ idleBeforeMs: 3_600_000, ttftMs: 8000 }),
        run({ ttftMs: 2000 }),
      ],
    });
    const by = Object.fromEntries(r.byIdle.map((g) => [g.key, g]));
    expect(by["<1m"].n).toBe(2);
    expect(by["<1m"].ttftMs.p50).toBe(1100);
    expect(by["5–30m"].ttftMs.p50).toBe(3000);
    expect(by[">30m"].ttftMs.p50).toBe(8000);
    expect(by["未知"].n).toBe(1);
    expect(by["1–5m"]).toBeUndefined(); // 空桶不输出
    // 顺序固定：由热到冷
    expect(r.byIdle.map((g) => g.key)).toEqual(["<1m", "5–30m", ">30m", "未知"]);
  });

  it("按发送路径（tags.path）分组", () => {
    const r = buildReport({
      run: [
        run({ tags: { path: "create" }, acceptMs: 2000 }),
        run({ tags: { path: "resume" }, acceptMs: 900 }),
        run({ tags: { path: "resume" }, acceptMs: 1100 }),
        run({}),
      ],
    });
    const by = Object.fromEntries(r.byPath.map((g) => [g.key, g]));
    expect(by.resume.n).toBe(2);
    expect(by.resume.acceptMs.p50).toBe(1000);
    expect(by.create.n).toBe(1);
    expect(by["未知"].n).toBe(1);
  });
});

describe("受理阶段与 MCP 探活", () => {
  it("prep 各阶段按 p90 降序", () => {
    const r = buildReport({
      run: [
        run({ prep: { mcp: 1500, create: 100, prompt: 10 } }),
        run({ prep: { mcp: 20, create: 120, prompt: 12 } }),
        run({ prep: { mcp: 30, create: 90 } }),
      ],
    });
    expect(r.prep.map((s) => s.stage)).toEqual(["mcp", "create", "prompt"]);
    expect(r.prep[0].n).toBe(3);
    expect(r.prep[2].n).toBe(2);
  });

  it("MCP 汇总：命中率 / fresh / stale / 同步探测占比按 server 次数加权", () => {
    const r = buildReport({
      run: [
        run({ mcp: { total: 2, cacheHits: 2, fresh: 1, stale: 1, probedSync: 0, staleRefreshedInGrace: 1, waitMs: 10 } }),
        run({ mcp: { total: 2, cacheHits: 0, fresh: 0, stale: 0, probedSync: 2, staleRefreshedInGrace: 0, waitMs: 800 } }),
        run({}), // 没有 mcp 字段的 run 不参与
      ],
    });
    expect(r.mcp.runs).toBe(2);
    expect(r.mcp.servers).toBe(4);
    expect(r.mcp.hitRate).toBe(0.5);
    expect(r.mcp.freshShare).toBe(0.25);
    expect(r.mcp.staleShare).toBe(0.25);
    expect(r.mcp.syncProbeShare).toBe(0.5);
    expect(r.mcp.graceHits).toBe(1);
    expect(r.mcp.runsWithSyncProbe).toBe(1);
    expect(r.mcp.waitMs.max).toBe(800);
  });
});

describe("预热效果对比", () => {
  const warmedRun = () =>
    run({
      idleBeforeMs: 600_000,
      warmedAgoMs: 30_000,
      acceptMs: 500,
      ttftMs: 1500,
      prep: { mcp: 20 },
      mcp: { total: 1, cacheHits: 1, fresh: 1, stale: 0, probedSync: 0, staleRefreshedInGrace: 0, waitMs: 0 },
    });
  const coldRun = () =>
    run({
      idleBeforeMs: 600_000,
      acceptMs: 2000,
      ttftMs: 4000,
      prep: { mcp: 1500 },
      mcp: { total: 1, cacheHits: 0, fresh: 0, stale: 0, probedSync: 1, staleRefreshedInGrace: 0, waitMs: 1500 },
    });

  it("只比较空闲 ≥5 分钟或未知的 run；预热超过 2 分钟的算没享受到", () => {
    const r = buildReport({
      run: [
        ...Array.from({ length: 6 }, warmedRun),
        ...Array.from({ length: 6 }, coldRun),
        // 预热过但已超过 2 分钟 → 归 cold
        run({ idleBeforeMs: 600_000, warmedAgoMs: 600_000, acceptMs: 1800, ttftMs: 1200 }),
        // 空闲只有 30s（本来就热）→ 不进对比，哪怕刚预热过
        run({ idleBeforeMs: 30_000, warmedAgoMs: 10_000, acceptMs: 100 }),
      ],
    });
    const e = r.warmup.effect;
    expect(e.warmed.n).toBe(6);
    expect(e.cold.n).toBe(7);
    expect(e.warmed.acceptMs.p50).toBe(500);
    expect(e.cold.acceptMs.p50).toBe(2000);
    expect(e.warmed.mcpStageMs.p50).toBe(20);
    expect(e.cold.mcpStageMs.p50).toBe(1500);
    expect(e.deltaP50.acceptMs).toBe(-1500);
    expect(e.deltaP50.mcpStageMs).toBe(-1480);
    expect(e.deltaP50.ttftMs).toBe(-2500);
  });

  it("预热调用汇总：状态 / 跳过原因 / 耗时 / 刷新探活数 / 预读 store 量", () => {
    const r = buildReport({
      warmup: [
        { ts: iso(0), taskId: "t_1", status: "warmed", sessionHot: false, totalMs: 120, mcp: { total: 3, refreshed: 2, skippedFresh: 1, waitMs: 100 }, store: { blobs: 3, bytes: 2 * 1048576 } },
        { ts: iso(1), taskId: "t_1", status: "warmed", sessionHot: true, totalMs: 40, mcp: { total: 3, refreshed: 0, skippedFresh: 3, waitMs: 0 } },
        { ts: iso(2), taskId: "t_1", status: "skipped", reason: "run_active", totalMs: 1 },
        { ts: iso(3), taskId: "t_1", status: "skipped", reason: "run_active", totalMs: 1 },
        { ts: iso(4), taskId: "t_1", status: "error", error: "x", totalMs: 5 },
      ],
    });
    expect(r.warmup.calls).toBe(5);
    expect(r.warmup.byStatus).toEqual({ warmed: 2, skipped: 2, error: 1 });
    expect(r.warmup.bySkip).toEqual({ run_active: 2 });
    expect(r.warmup.totalMs.n).toBe(2); // 只统计 warmed 的耗时
    expect(r.warmup.mcpRefreshed).toBe(2);
    expect(r.warmup.storePrefetchBlobs).toBe(3);
    expect(r.warmup.storePrefetchMB).toBe(2);
  });

  it("对比组某侧没有样本：差值为 undefined，不抛", () => {
    const r = buildReport({ run: [coldRun()] });
    expect(r.warmup.effect.warmed.n).toBe(0);
    expect(r.warmup.effect.deltaP50.acceptMs).toBeUndefined();
  });
});

describe("工具聚合", () => {
  it("n / 失败率 / 平均 / 最大 / 总计；shell 的平台开销 = (wall − SDK 自报执行) / n；按总耗时降序", () => {
    const r = buildReport({
      run: [
        run({
          tools: {
            shell: { n: 2, errors: 1, wallSum: 2000, wallMax: 1500, sdkExecSum: 1200 },
            read: { n: 3, errors: 0, wallSum: 900, wallMax: 400 },
          },
        }),
        run({ tools: { shell: { n: 1, errors: 0, wallSum: 400, wallMax: 400, sdkExecSum: 100 } } }),
      ],
    });
    expect(r.tools.map((t) => t.name)).toEqual(["shell", "read"]);
    const shell = r.tools[0];
    expect(shell.n).toBe(3);
    expect(shell.errors).toBe(1);
    expect(shell.errorRate).toBeCloseTo(1 / 3);
    expect(shell.totalMs).toBe(2400);
    expect(shell.avgMs).toBe(800);
    expect(shell.maxMs).toBe(1500);
    expect(shell.sdkOverheadAvgMs).toBeCloseTo((2400 - 1300) / 3);
    expect(r.tools[1].sdkOverheadAvgMs).toBeUndefined();
  });

  it("平台开销只用带 sdkExecSum 的 run 计算（混入不带的 run 不能稀释分母）", () => {
    const r = buildReport({
      run: [
        run({ tools: { shell: { n: 1, errors: 0, wallSum: 500, wallMax: 500, sdkExecSum: 200 } } }),
        run({ tools: { shell: { n: 9, errors: 0, wallSum: 9000, wallMax: 1000 } } }), // 老版本记录、没有 sdkExecSum
      ],
    });
    expect(r.tools[0].n).toBe(10);
    expect(r.tools[0].sdkOverheadAvgMs).toBe(300);
  });
});

describe("事件循环 / 会话规模 / 防后台节流 A-B", () => {
  it("run 内与进程级慢秒汇总；loop-lag 不受 taskId 过滤", () => {
    const lag = [
      { ts: iso(0), kind: "slow-second", max: 800, p99: 600, elu: 0.9, gcMax: 30, gcCount: 1, activeRuns: 1, rssMB: 500 },
      { ts: iso(1), kind: "slow-second", max: 1200, p99: 900, elu: 0.95, gcMax: 80, gcCount: 2, activeRuns: 0, rssMB: 520 },
    ];
    const r = buildReport(
      { run: [run({ taskId: "t_a", proc: { rssMB: 1, heapMB: 1, load1: 1, uptimeS: 1, activeRuns: 1, eldP99Max: 40, eldMax: 300, slowSeconds: 2 } }), run({ taskId: "t_b" })], lag },
      { taskId: "t_a" },
    );
    expect(r.meta.counts.run).toBe(1);
    expect(r.meta.counts.lag).toBe(2);
    expect(r.loop.runEldMax.max).toBe(300);
    expect(r.loop.slowSecondEvents.n).toBe(2);
    expect(r.loop.slowSecondEvents.maxMs.max).toBe(1200);
    expect(r.loop.slowSecondEvents.withActiveRunsShare).toBe(0.5);
  });

  it("按 agent 体积分桶看速度", () => {
    const r = buildReport({
      run: [
        run({ store: { mode: "fast", agentMB: 0.4 }, acceptMs: 200 }),
        run({ store: { mode: "fast", agentMB: 30 }, acceptMs: 2500 }),
        run({ promptBytes: 4096 }),
      ],
    });
    const by = Object.fromEntries(r.scale.byAgentSize.map((g) => [g.key, g]));
    expect(by["<1MB"].acceptMs.p50).toBe(200);
    expect(by["≥20MB"].acceptMs.p50).toBe(2500);
    expect(by["未知"].n).toBe(1);
    expect(r.scale.promptBytes.n).toBe(1);
  });

  it("appNap 分组：关 / 开 / 未知（老版本没有该字段）", () => {
    const r = buildReport({
      run: [
        run({ appNap: false, ttftMs: 3000 }),
        run({ appNap: true, ttftMs: 1000 }),
        run({ appNap: true, ttftMs: 1200 }),
        run({}),
      ],
    });
    const by = Object.fromEntries(r.appNap.map((g) => [g.key, g]));
    expect(by["关"].n).toBe(1);
    expect(by["开"].n).toBe(2);
    expect(by["开"].ttftMs.p50).toBe(1100);
    expect(by["未知"].n).toBe(1);
    expect(r.appNap.map((g) => g.key)).toEqual(["关", "开", "未知"]);
  });
});

describe("吐字节奏", () => {
  /** 一个 run 的 cadence.text：p50 / p95 / over100 / n 可调 */
  const cad = (p50: number, over100: number, n = 100, over250 = 0) => ({
    text: { n, p50, p95: Math.round(p50 * 1.3), max: p50 * 4, over100, over250 },
  });

  it("旧版本的记录（没有 cadence）：text 为 undefined、分组为空，不抛；渲染提示无数据", () => {
    const rep = buildReport({ run: [run(), run({ cadence: {} }), run({ cadence: { text: { n: 0 } } })] });
    expect(rep.cadence.text).toBeUndefined();
    expect(rep.cadence.thinking).toBeUndefined();
    expect(rep.cadence.byRunEvents).toEqual([]);
    expect(rep.cadence.fileBySize).toEqual([]);
    expect(renderText(rep)).toContain("■ 十、");
    expect(renderText(rep)).toContain("无数据（记录来自没有该字段的旧版本");
  });

  it("条数加权占比 + 每轮分布 + 整轮被钉住（p50 ≥ 150ms）的 run 数", () => {
    const rep = buildReport({
      run: [
        run({ cadence: cad(35, 1, 400) }), // 流畅
        run({ cadence: cad(200, 100, 100, 33) }), // 整轮被钉住
      ],
    });
    const t = rep.cadence.text;
    if (!t) throw new Error("cadence.text 缺失");
    expect(t.runs).toBe(2);
    expect(t.gaps).toBe(500);
    expect(t.slowShare).toBeCloseTo((1 + 100) / 500, 6);
    expect(t.stallShare).toBeCloseTo(33 / 500, 6);
    expect(t.pinnedRuns).toBe(1);
    expect(t.p50.n).toBe(2);
    expect(t.p50.p50).toBeCloseTo(117.5, 6); // 两个 run 的 p50（35 / 200）线性插值
  });

  it("按 run_events 实现分组（memory / file / 未知，固定顺序）：A/B 对照一眼可见", () => {
    const rep = buildReport({
      run: [
        run({ cadence: cad(35, 1), store: { mode: "fast", runEvents: "memory" } }),
        run({ cadence: cad(33, 0), store: { mode: "fast", runEvents: "memory" } }),
        run({ cadence: cad(200, 100), store: { mode: "fast", runEvents: "file", evMB: 18.5 } }),
        run({ cadence: cad(190, 98) }), // 旧版本没有 store.runEvents
      ],
    });
    const g = rep.cadence.byRunEvents;
    expect(g.map((x: { key: string }) => x.key)).toEqual(["memory", "file", "未知"]);
    expect(g[0]).toMatchObject({ runs: 2, pinnedRuns: 0 });
    expect(g[0].slowShare).toBeCloseTo(1 / 200, 6);
    expect(g[1]).toMatchObject({ runs: 1, pinnedRuns: 1 });
    expect(g[1].slowShare).toBeCloseTo(100 / 100, 6);
    expect(g[2]).toMatchObject({ runs: 1, pinnedRuns: 1 });
  });

  it("SDK 落盘实现按 run_events 文件体积分桶（越大越慢）；memory 的 run 不进这一组", () => {
    const file = (evMB: number | undefined, p50: number) =>
      run({ cadence: cad(p50, 50), store: { mode: "fast", runEvents: "file", ...(evMB === undefined ? {} : { evMB }) } });
    const rep = buildReport({
      run: [
        file(0.5, 40),
        file(3, 70),
        file(18.5, 200),
        file(25, 260),
        file(undefined, 90),
        run({ cadence: cad(33, 0), store: { mode: "fast", runEvents: "memory", evMB: 0.4 } }),
      ],
    });
    const b = rep.cadence.fileBySize;
    expect(b.map((x: { key: string }) => x.key)).toEqual(["<1MB", "1–5MB", "5–20MB", "≥20MB", "未知"]);
    expect(b.map((x: { runs: number }) => x.runs)).toEqual([1, 1, 1, 1, 1]);
    expect(b.map((x: { p50: { p50: number } }) => x.p50.p50)).toEqual([40, 70, 200, 260, 90]);
  });

  it("思考 delta 单独汇总；只有思考没有正文时 text 仍为 undefined", () => {
    const rep = buildReport({
      run: [run({ cadence: { thinking: { n: 50, p50: 100, p95: 125, max: 900, over100: 20, over250: 2 } } })],
    });
    expect(rep.cadence.text).toBeUndefined();
    expect(rep.cadence.thinking).toMatchObject({ runs: 1, gaps: 50 });
    expect(rep.cadence.thinking?.slowShare).toBeCloseTo(20 / 50, 6);
  });

  it("相关体积：runs.ndjson 与 run_events（file / memory 分开，不混算）", () => {
    const rep = buildReport({
      run: [
        run({ store: { mode: "fast", runEvents: "file", evMB: 18.5, runsMB: 0.19 } }),
        run({ store: { mode: "fast", runEvents: "memory", evMB: 0.4, runsMB: 0.2 } }),
        run({ store: { mode: "fast", runEvents: "memory", evMB: 0.6, runsMB: 0.21 } }),
      ],
    });
    expect(rep.scale.runsMB.n).toBe(3);
    expect(rep.scale.runEventsFileMB).toMatchObject({ n: 1, max: 18.5 });
    expect(rep.scale.runEventsMemoryMB).toMatchObject({ n: 2, max: 0.6 });
  });

  it("文本渲染：新一节含内存 / 落盘分组与体积分桶，没有 undefined / NaN", () => {
    const rep = buildReport({
      run: [
        run({ cadence: cad(35, 1), store: { mode: "fast", runEvents: "memory", evMB: 0.4, runsMB: 0.2 } }),
        run({ cadence: cad(200, 100, 100, 33), store: { mode: "fast", runEvents: "file", evMB: 18.5, runsMB: 0.19 } }),
      ],
    });
    const text = renderText(rep);
    expect(text).toContain("■ 十、吐字节奏");
    expect(text).toContain("[内存实现（默认）]");
    expect(text).toContain("[SDK 落盘（回退开关）]");
    expect(text).toContain("按 run_events 文件体积");
    expect(text).toContain("整轮被钉住");
    const section = text.slice(text.indexOf("■ 十、"));
    expect(section).not.toMatch(/undefined|NaN/);
  });

  it("报告只回显白名单统计：cadence 里夹带的未知字段不会出现在输出里", () => {
    const rep = buildReport({
      run: [run({ cadence: { text: { ...cad(35, 1).text, secret: "TOPSECRET" }, leak: "TOPSECRET" } })],
    });
    expect(JSON.stringify(rep)).not.toContain("TOPSECRET");
    expect(renderText(rep)).not.toContain("TOPSECRET");
  });
});

describe("前端流畅度", () => {
  it("心跳间隔常量与采集器默认值一致（估算口径依赖它）", () => {
    expect(UI_HEARTBEAT_EVERY).toBe(DEFAULT_HEARTBEAT_EVERY);
  });

  it("卡顿窗口占比 ≈ 信号窗口 /（信号窗口 + N × 心跳数）；心跳与非 interval 不混进分子", () => {
    const r = buildReport({
      ui: [
        ui({ taskId: "t_a" }),
        ui({ taskId: "t_a" }),
        ui({}),
        ui({ heartbeat: true, longTasks: { n: 0, sumMs: 0, maxMs: 0, n100: 0, n250: 0 }, inputs: { n: 0, p50Ms: 0, maxMs: 0, n200: 0 } }),
        ui({ reason: "hidden", taskId: "t_a" }),
      ],
    });
    expect(r.ui.intervalWindows).toBe(4);
    expect(r.ui.heartbeats).toBe(1);
    expect(r.ui.signalWindows).toBe(3);
    expect(r.ui.nonIntervalSignalWindows).toBe(1);
    expect(r.ui.estimatedJankWindowShare).toBeCloseTo(3 / (3 + UI_HEARTBEAT_EVERY * 1));
    // 长任务汇总包含 interval 与非 interval 的信号窗口、不含心跳
    expect(r.ui.longTasks.total).toBe(2 * 4);
  });

  it("信号窗口按是否与同 task 的 run 时间重叠，分「流式期间 / 非流式期间」；没有 taskId 的不参与", () => {
    const r = buildReport({
      // run 区间 [20s, 60s]
      run: [run({ taskId: "t_a", ts: iso(60_000), totalMs: 40_000 })],
      ui: [
        ui({ taskId: "t_a", ts: iso(50_000) }), // [20s,50s] 重叠 → 流式期间
        ui({ taskId: "t_a", ts: iso(10_000_000) }), // 远离 → 非流式
        ui({ ts: iso(50_000) }), // 无 taskId → 不参与
        ui({ taskId: "t_a", ts: iso(55_000), heartbeat: true }), // 心跳不算信号
        ui({ taskId: "t_a", ts: iso(58_000), reason: "hidden", windowMs: 5000 }), // [53s,58s] 重叠 → 流式期间
        ui({ taskId: "t_other", ts: iso(50_000) }), // 同时间但别的 task 没有 run → 非流式
      ],
    });
    expect(r.ui.duringStreaming.windows).toBe(2);
    expect(r.ui.duringStreaming.longTaskN).toBe(4);
    expect(r.ui.duringStreaming.longTaskN250).toBe(2);
    expect(r.ui.duringStreaming.slowInputN).toBe(2);
    expect(r.ui.notStreaming.windows).toBe(2);
  });

  it("页面规模 / 回前台追赶 / 慢交互 分布", () => {
    const r = buildReport({
      ui: [
        ui({ heapMB: 100, domNodes: 5000, afterShowMs: 400 }),
        ui({ heapMB: 300, domNodes: 20_000, inputs: { n: 5, p50Ms: 80, maxMs: 600, n200: 2 } }),
      ],
    });
    expect(r.ui.heapMB.max).toBe(300);
    expect(r.ui.domNodes.p50).toBe(12_500);
    expect(r.ui.afterShowMs.n).toBe(1);
    expect(r.ui.slowInputs.n200).toBe(3);
    expect(r.ui.slowInputs.windows).toBe(2);
    expect(r.ui.slowInputs.maxMs.max).toBe(600);
  });

  it("防节流开关分组带入前端数据（渲染进程节流是该实验的主要影响对象）", () => {
    const r = buildReport({ ui: [ui({ appNap: true }), ui({ appNap: false }), ui({ appNap: false })] });
    const by = Object.fromEntries(r.ui.byAppNap.map((g) => [g.key, g]));
    expect(by["开"].windows).toBe(1);
    expect(by["关"].windows).toBe(2);
  });

  describe("流式代码块限频高亮的效果", () => {
    const hl = (over: Record<string, number> = {}) => ({
      requests: 100, passthrough: 0, cacheHits: 0, submitted: 10, throttled: 90, flushed: 9, forks: 0,
      costSumMs: 400, costMaxMs: 80, costCount: 10, slots: 1,
      ...over,
    });

    it("汇总：请求 / 实际提交 / 摊薄比例 / 平均单次耗时（按次数加权）/ 每窗口最大耗时分布", () => {
      const r = buildReport({
        ui: [
          ui({ highlight: hl() }),
          ui({ highlight: hl({ requests: 300, submitted: 30, throttled: 270, flushed: 29, costSumMs: 2400, costMaxMs: 200, costCount: 30, slots: 2 }) }),
        ],
      });
      const h = r.ui.highlight!;
      expect(h.windows).toBe(2);
      expect(h.requests).toBe(400);
      expect(h.submitted).toBe(40);
      expect(h.throttled).toBe(360);
      expect(h.throttledShare).toBeCloseTo(0.9, 5);
      // 加权平均 (400+2400)/(10+30)=70，而不是两个窗口均值的均值 (40+80)/2=60
      expect(h.avgCostMs).toBeCloseTo(70, 5);
      expect(h.costMaxMs.max).toBe(200);
      expect(h.slots.max).toBe(2);
    });

    it("没有该字段（旧版本 / 没流式代码块）→ undefined；渲染成「无数据」而不是 0%", () => {
      const r = buildReport({ ui: [ui(), ui()] });
      expect(r.ui.highlight).toBeUndefined();
      expect(renderText(r)).toContain("流式代码块高亮：无数据");
    });

    it("只统计带该字段的窗口：混着旧数据时旧窗口不会拉低比例", () => {
      const r = buildReport({ ui: [ui({ highlight: hl() }), ui(), ui()] });
      expect(r.ui.highlight!.windows).toBe(1);
      expect(r.ui.highlight!.throttledShare).toBeCloseTo(0.9, 5);
    });

    it("被限频的与实际提交都为 0（比如全是短代码直通）：摊薄比例是 undefined，不是 NaN", () => {
      const r = buildReport({
        ui: [ui({ highlight: hl({ requests: 5, passthrough: 5, submitted: 0, throttled: 0, flushed: 0, costSumMs: 0, costMaxMs: 0, costCount: 0 }) })],
      });
      expect(r.ui.highlight!.throttledShare).toBeUndefined();
      expect(r.ui.highlight!.avgCostMs).toBeUndefined();
      expect(() => renderText(r)).not.toThrow();
    });

    it("文本里能看到摊薄比例与单次耗时", () => {
      const text = renderText(buildReport({ ui: [ui({ highlight: hl() })] }));
      expect(text).toMatch(/流式代码块高亮：1 条上报带有该统计，请求 100 次 → 实际交给 Shiki 10 次（摊薄 90\.0%）/);
      expect(text).toContain("单次耗时均值 40ms");
    });

    it("损坏的 highlight（非对象 / requests 非数字）被忽略，不崩", () => {
      const r = buildReport({ ui: [ui({ highlight: "x" }), ui({ highlight: { requests: "9" } }), ui({ highlight: null })] });
      expect(r.ui.highlight).toBeUndefined();
    });
  });
});

describe("回合收尾（turn-wrapup：回复完整后 SDK 迟迟不结束 / 重复回复）", () => {
  const wrap = (over: Record<string, unknown> = {}) => ({
    ts: iso(0),
    taskId: "t_1",
    settledAfterMs: 4000,
    turnEndedCount: 1,
    ...over,
  });
  const chatRuns = () => [
    run({ kind: "chat-followup", outcome: "finished" }),
    run({ kind: "chat-followup", outcome: "finished" }),
    run({ kind: "chat-first", outcome: "ok" }),
    run({ kind: "chat-reconnect", outcome: "finished" }),
    // 不是 chat：不进分母
    run({ kind: "task-first", outcome: "ok" }),
    run({ kind: "question", outcome: "ok" }),
  ];

  it("分母只算 chat run；重放 / 慢收尾 / 拦截数各自汇总", () => {
    const r = buildReport({
      run: chatRuns(),
      wrapup: [
        wrap({ settledAfterMs: 3500 }),
        wrap({
          settledAfterMs: 120_000,
          turnEndedCount: 2,
          replayDropped: { thinking: 3, assistant: 2, assistantChars: 800, toolCalls: 0 },
        }),
        wrap({
          settledAfterMs: 6000,
          replayDropped: { thinking: 1, assistant: 0, assistantChars: 0, toolCalls: 2 },
        }),
      ],
    });
    const w = r.wrapUp;
    expect(w.chatRuns).toBe(4);
    expect(w.records).toBe(3);
    expect(w.share).toBeCloseTo(0.75);
    expect(w.replayed).toBe(1);
    expect(w.slow).toBe(2); // > 5s：120s 与 6s（3.5s 不算）
    expect(w.settledMs.n).toBe(3);
    expect(w.settledMs.max).toBe(120_000);
    expect(w.droppedThinking).toBe(4);
    expect(w.droppedAssistant).toBe(2);
    expect(w.droppedChars).toBe(800);
    expect(w.droppedToolCalls).toBe(2);
    expect(w.okChatRuns).toBe(1); // 只数 chat 里 outcome=ok 的（task-first / question 的 ok 不算）
    expect(r.meta.counts.wrapup).toBe(3);
  });

  it("没有记录：records=0、分母照常，share 为 0；损坏字段不崩", () => {
    const r = buildReport({
      run: chatRuns(),
      wrapup: [
        wrap({ settledAfterMs: "x", turnEndedCount: "2", replayDropped: "bad" }),
        wrap({ settledAfterMs: Number.NaN, replayDropped: null }),
      ],
    });
    expect(r.wrapUp.records).toBe(2);
    expect(r.wrapUp.settledMs).toEqual({ n: 0 });
    expect(r.wrapUp.replayed).toBe(0);
    expect(r.wrapUp.droppedChars).toBe(0);

    const none = buildReport({ run: chatRuns() });
    expect(none.wrapUp.records).toBe(0);
    expect(none.wrapUp.share).toBe(0);
  });

  it("--task / --since 同样过滤 wrapup", () => {
    const input = {
      run: [run({ kind: "chat-followup" })],
      wrapup: [
        wrap({ taskId: "t_a", ts: iso(-2 * 86_400_000) }),
        wrap({ taskId: "t_a", ts: iso(0) }),
        wrap({ taskId: "t_b", ts: iso(0) }),
      ],
    };
    expect(buildReport(input, { taskId: "t_a" }).wrapUp.records).toBe(2);
    expect(buildReport(input, { sinceMs: T0 - 3_600_000 }).wrapUp.records).toBe(2);
    expect(
      buildReport(input, { taskId: "t_a", sinceMs: T0 - 3_600_000 }).wrapUp.records,
    ).toBe(1);
  });

  it("文本报告有第十一节，数据行带回合收尾条数；没有 chat run 时明确说无数据", () => {
    const text = renderText(
      buildReport({
        run: chatRuns(),
        wrapup: [
          wrap({
            settledAfterMs: 90_000,
            turnEndedCount: 2,
            replayDropped: { thinking: 2, assistant: 1, assistantChars: 300, toolCalls: 0 },
          }),
        ],
      }),
    );
    expect(text).toContain("回合收尾异常 1 条");
    expect(text).toContain("■ 十一、回合收尾");
    expect(text).toContain("SDK 重放（同一条流多个 turn-ended）1 个");
    expect(text).toContain("正文 1 条（300 字，没有重复上屏）");
    expect(text).toContain("outcome=ok");

    const empty = renderText(buildReport({}));
    expect(empty).toContain("■ 十一、回合收尾");
    expect(empty).toContain("还没有 chat run");
  });
});

describe("过滤与提示", () => {
  it("--since 按 ts 过滤（含 loop-lag）；缺 ts / 非法 ts 的记录被过滤掉", () => {
    const r = buildReport(
      {
        run: [run({ ts: iso(-2 * 86_400_000) }), run({ ts: iso(0) }), run({ ts: undefined }), run({ ts: "not-a-date" })],
        lag: [{ ts: iso(-2 * 86_400_000), max: 600 }, { ts: iso(0), max: 700 }],
      },
      { sinceMs: T0 - 3_600_000 },
    );
    expect(r.meta.counts.run).toBe(1);
    expect(r.meta.counts.lag).toBe(1);
  });

  it("--task 只过滤带 taskId 的数据源", () => {
    const r = buildReport(
      { run: [run({ taskId: "t_a" }), run({ taskId: "t_b" })], warmup: [{ ts: iso(0), taskId: "t_b", status: "warmed", totalMs: 1 }], ui: [ui({ taskId: "t_a" }), ui({ taskId: "t_b" })] },
      { taskId: "t_a" },
    );
    expect(r.meta.counts).toEqual({ run: 1, ui: 1, warmup: 0, lag: 0, wrapup: 0 });
  });

  it("提示：样本少 / 异常收口占比 / 混合版本 / 解析失败", () => {
    const rs = [
      ...Array.from({ length: 40 }, () => run({ version: "1.9.27" })),
      ...Array.from({ length: 2 }, () => run({ outcome: "timeout", version: "1.9.28" })),
    ];
    const r = buildReport({ run: rs }, { parseErrors: 3 });
    const text = r.warnings.join("\n");
    expect(text).toContain("异常收口");
    expect(text).toContain("混合了多个版本");
    expect(text).toContain("1.9.27×40");
    expect(text).toContain("3 行日志无法解析");
    expect(text).not.toContain("样本较少"); // 42 ≥ 30

    const few = buildReport({ run: [run()] });
    expect(few.warnings.join("\n")).toContain("样本较少");
  });

  it("空输入不抛，并明确提示没有 run 记录", () => {
    const r = buildReport({});
    expect(r.meta.counts).toEqual({ run: 0, ui: 0, warmup: 0, lag: 0, wrapup: 0 });
    expect(r.warnings.join("\n")).toContain("没有 run 记录");
    const text = renderText(r);
    expect(text).toContain("没有 run 记录");
    expect(text).toContain("无数据");
  });
});

describe("文本渲染", () => {
  const full = () =>
    buildReport({
      run: [
        run({ idleBeforeMs: 600_000, warmedAgoMs: 20_000, acceptMs: 500, prep: { mcp: 20 }, tools: { shell: { n: 1, errors: 0, wallSum: 500, wallMax: 500, sdkExecSum: 100 } }, appNap: true, store: { mode: "fast", agentMB: 2 }, mcp: { total: 1, cacheHits: 1, fresh: 1, stale: 0, probedSync: 0, staleRefreshedInGrace: 0, waitMs: 0 } }),
        run({ idleBeforeMs: 5_000 }),
      ],
      warmup: [{ ts: iso(0), taskId: "t_1", status: "warmed", totalMs: 90, mcp: { total: 1, refreshed: 1, skippedFresh: 0, waitMs: 80 } }],
      lag: [{ ts: iso(0), max: 700, gcMax: 10, activeRuns: 1, rssMB: 400 }],
      ui: [ui({ taskId: "t_1", heapMB: 120, domNodes: 4000 })],
    });

  it("十个小节标题齐全；样本少的分组有标注", () => {
    const text = renderText(full());
    for (const h of ["一、", "二、", "三、", "四、", "五、", "六、", "七、", "八、", "九、", "十、"]) {
      expect(text).toContain(`■ ${h}`);
    }
    expect(text).toContain("（样本少）");
    expect(text).toContain("享受到预热");
  });

  it("报告对象可 JSON 序列化（--json 路径）", () => {
    expect(() => JSON.stringify(full())).not.toThrow();
  });

  it("没有空标题行（曾出现过「■ 」后面什么都没有的节）", () => {
    expect(renderText(full())).not.toMatch(/^■\s*$/m);
    expect(renderText(buildReport({}))).not.toMatch(/^■\s*$/m);
  });

  it("中文标签按显示宽度对齐：不同长度的中英混排标签后面的数据列起点一致", () => {
    expect(wlen("受理")).toBe(4);
    expect(wlen("abc")).toBe(3);
    expect(wlen("首 token ttft")).toBe(13);
    expect(wlen(padW("受理 accept", 16))).toBe(16);
    expect(wlen(padW("run 内 ELD p99", 16))).toBe(16);
    // 超宽标签不截断、也不会因负数 repeat 抛错
    expect(padW("这是一个特别特别长的标签", 4)).toBe("这是一个特别特别长的标签");

    const lines = renderText(full())
      .split("\n")
      .filter((l) => /^ {2}(受理 accept|首 token ttft|首个工具|整轮 total|思考 thinking)/.test(l));
    expect(lines).toHaveLength(5);
    // 数据列起点（「n=数字」或「无数据」之前）的显示宽度必须一致；有的行本身就是「无数据」
    const cols = lines.map((l) => wlen(l.slice(0, l.search(/ (n=\d+|无数据)/))));
    expect(cols.every((c) => c > 0)).toBe(true);
    expect(new Set(cols).size).toBe(1);
  });

  it("差值带符号：变慢显示 +，变快显示 -，0 与未知正常", () => {
    expect(fmtDelta(140)).toBe("+140ms");
    expect(fmtDelta(-1830)).toBe("-1.83s");
    expect(fmtDelta(2500)).toBe("+2.50s");
    expect(fmtDelta(0)).toBe("0ms");
    expect(fmtDelta(undefined)).toBe("-");
  });

  it("预热对比的提示里写明这是观察性对比（别被当成因果）", () => {
    expect(renderText(full())).toContain("观察性对比");
  });

  it("报告只输出白名单统计字段：记录里夹带的未知字段不会被回显", () => {
    const text = renderText(buildReport({ run: [run({ prompt: "TOPSECRET 用户的提问", cwd: "/Users/x/secret" })] }));
    const json = JSON.stringify(buildReport({ run: [run({ prompt: "TOPSECRET 用户的提问", cwd: "/Users/x/secret" })] }));
    expect(text).not.toContain("TOPSECRET");
    expect(json).not.toContain("TOPSECRET");
    expect(json).not.toContain("/Users/x/secret");
  });
});

describe("日志读取与参数解析", () => {
  it("readJsonl：轮转文件按旧→新合并；坏行 / 非对象行计数后跳过；文件不存在 → 空", async () => {
    const dir = await mkTmp();
    await writeFile(path.join(dir, "x.jsonl.2"), jsonl([{ n: 1 }]));
    await writeFile(path.join(dir, "x.jsonl.1"), jsonl([{ n: 2 }]));
    await writeFile(path.join(dir, "x.jsonl"), `${JSON.stringify({ n: 3 })}\n{broken\n[1,2]\n\n${JSON.stringify({ n: 4 })}\n`);
    const { records, errors } = await readJsonl(dir, "x.jsonl");
    expect(records.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(errors).toBe(2);
    expect(await readJsonl(dir, "nope.jsonl")).toEqual({ records: [], errors: 0 });
  });

  it("loadLogs：五类日志各读各的、错误数合计", async () => {
    const dir = await mkTmp();
    await writeFile(path.join(dir, "run-perf.jsonl"), jsonl([run()]) + "oops\n");
    await writeFile(path.join(dir, "loop-lag.jsonl"), jsonl([{ ts: iso(0), max: 600 }]) + "oops\n");
    await writeFile(
      path.join(dir, "turn-wrapup.jsonl"),
      jsonl([{ ts: iso(0), taskId: "t_1", settledAfterMs: 5000, turnEndedCount: 2 }]),
    );
    const { input, parseErrors } = await loadLogs(dir);
    expect(input.run).toHaveLength(1);
    expect(input.lag).toHaveLength(1);
    expect(input.wrapup).toHaveLength(1);
    expect(input.ui).toHaveLength(0);
    expect(input.warmup).toHaveLength(0);
    expect(parseErrors).toBe(2);
  });

  it("parseSince：相对时长与日期；无效抛错", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("24h", now)).toBe(now - 24 * 3_600_000);
    expect(parseSince("90m", now)).toBe(now - 90 * 60_000);
    expect(parseSince("2026-10-01", now)).toBe(Date.parse("2026-10-01"));
    expect(() => parseSince("昨天", now)).toThrow(/无法解析 --since/);
  });

  it("defaultLogsDir：环境变量优先，其次按平台推断", () => {
    expect(defaultLogsDir({ FLOWSHIP_DATA_DIR: "/d" }, "darwin", "/h")).toBe(path.join("/d", "logs"));
    expect(defaultLogsDir({}, "darwin", "/h")).toBe(path.join("/h", "Library", "Application Support", "fe-ai-flow", "data", "logs"));
    expect(defaultLogsDir({ APPDATA: "/ad" }, "win32", "/h")).toBe(path.join("/ad", "fe-ai-flow", "data", "logs"));
    expect(defaultLogsDir({}, "linux", "/h")).toBe(path.join("/h", ".config", "fe-ai-flow", "data", "logs"));
  });
});

describe("CLI", () => {
  const cli = path.resolve(import.meta.dirname, "..", "scripts/perf-report.mjs");
  // 去掉 Agent / App 环境里可能被注入的变量，保证 CLI 只看 --dir
  const cleanEnv = () => {
    const env = { ...process.env };
    for (const k of ["ELECTRON_RUN_AS_NODE", "FLOWSHIP_DATA_DIR", "PORT", "HOSTNAME"]) delete env[k];
    return env;
  };

  it("--json 输出可解析的完整报告", async () => {
    const dir = await mkTmp();
    await writeFile(path.join(dir, "run-perf.jsonl"), jsonl([run(), run({ ttftMs: 2200 })]));
    const out = execFileSync(process.execPath, [cli, "--dir", dir, "--json"], { encoding: "utf8", env: cleanEnv() });
    const report = JSON.parse(out);
    expect(report.meta.counts.run).toBe(2);
    expect(report.latency.ttftMs.n).toBe(2);
  });

  it("默认输出中文文本报告", async () => {
    const dir = await mkTmp();
    await writeFile(path.join(dir, "run-perf.jsonl"), jsonl([run()]));
    const out = execFileSync(process.execPath, [cli, "--dir", dir], { encoding: "utf8", env: cleanEnv() });
    expect(out).toContain("Flowship 性能报告");
    expect(out).toContain("■ 一、");
  });

  it("目录里没有任何日志 → 退出码 1 并给出提示", async () => {
    const dir = await mkTmp();
    const res = spawnSync(process.execPath, [cli, "--dir", dir], { encoding: "utf8", env: cleanEnv() });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("没有读到任何观测日志");
  });

  it("未知参数 / 非法 --since → 退出码 2", () => {
    const bad = spawnSync(process.execPath, [cli, "--nope"], { encoding: "utf8", env: cleanEnv() });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("未知参数");
    const badSince = spawnSync(process.execPath, [cli, "--since", "昨天"], { encoding: "utf8", env: cleanEnv() });
    expect(badSince.status).toBe(2);
  });
});
