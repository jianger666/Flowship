/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-34（perf 侧）：
 *  ① 活动日志（AI 条目会成为录制 `stop` 的 ai-action 标记，也会被 export_activity 导出）只写 `browser-traces/<文件名>`，不写 userData 绝对路径；
 *  ② INTERNAL 错误文案（写盘失败等）只留 errno 码 + 释义 + 系统调用 + 文件名，不含任何目录 / userData。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createHandlers, normalize, perfDirFor } from "../electron-app/browser/ops/perf.mjs";
import { makeP4Env, type P4Env } from "./helpers/browser-e2-p4-fakes";

let env: P4Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const nodeErr = (code: string, syscall: string, p: string, desc: string) => Object.assign(new Error(`${code}: ${desc}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -1 });

const mk = async (opts: { fs?: any; perfLimits?: Record<string, unknown> } = {}) => {
  const e = (env = await makeP4Env({ taskId: "task-s5p" }));
  (e.session.host as any).isEvaluateEnabled = () => true; // 堆快照免审批
  const handlers: any = createHandlers({
    requireSession: () => e.session,
    getConfig: () => ({}),
    abortable: (p: Promise<unknown>) => p,
    scheduleState: () => {},
    app: { getPath: () => e.userData },
    electron: { isAppUrl: e.isAppUrl },
    hostLabel: (u: string) => new URL(u).hostname,
    log: () => {},
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.perfLimits ? { perfLimits: opts.perfLimits } : {}),
  } as any);
  e.cdp["HeapProfiler.takeHeapSnapshot"] = () => {
    e.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: '{"snapshot":{"meta":{}},"nodes":[],"edges":[],"strings":["x"]}' });
    return {};
  };
  e.cdp["Tracing.end"] = () => {
    queueMicrotask(() => e.emit("Tracing.tracingComplete", { stream: "S1", dataLossOccurred: false }));
    return {};
  };
  e.cdp["IO.read"] = () => ({ data: '{"traceEvents":[]}', eof: true, base64Encoded: false });
  const perf = (args: Record<string, unknown>) => handlers.perf(e.taskId, normalize("perf", args, OP_HELPERS as any));
  return { e, perf, dir: perfDirFor(e.userData, e.taskId)! };
};

const noAbs = (e: P4Env, s: string) => {
  expect(s).not.toContain(e.userData);
  expect(s).not.toContain(path.basename(e.userData));
  expect(s).not.toContain("/data/tasks");
  expect(s).not.toMatch(/\/(?:Users|home|var|private|tmp)\//);
};

describe("R6-34 perf：活动日志只写 browser-traces/文件名", () => {
  it("heap_snapshot：活动日志（AI 条目）含 browser-traces/heap-….heapsnapshot，不含 userData / 绝对路径 / 「位置 …」", async () => {
    const m = await mk();
    const r = await m.perf({ action: "heap_snapshot" });
    const log = m.e.activitySummaries().join("|");
    expect(log).toContain("保存了页面堆快照");
    expect(log).toContain(`browser-traces/${r.file}`);
    noAbs(m.e, log);
    expect(log).not.toContain("位置");
    // 同一份日志被 record stop / export_activity 带出时也一样（它们读的就是这份条目）
    noAbs(m.e, JSON.stringify(m.e.session.activityLog.list()));
  });

  it("stop_trace：活动日志含 browser-traces/trace-….json，不含 userData", async () => {
    const m = await mk();
    await m.perf({ action: "start_trace" });
    const r = await m.perf({ action: "stop_trace" });
    const log = m.e.activitySummaries().join("|");
    expect(log).toContain("结束了性能录制并保存 trace");
    expect(log).toContain(`browser-traces/${r.file}`);
    noAbs(m.e, log);
    noAbs(m.e, JSON.stringify(m.e.session.activityLog.list()));
  });

  it("自动到时结束：同样只写 browser-traces/文件名", async () => {
    const m = await mk({ perfLimits: { traceMaxMs: 25 } });
    await m.perf({ action: "start_trace" });
    await new Promise((r) => setTimeout(r, 15));
    for (let i = 0; i < 100 && !m.e.activitySummaries().some((s) => s.includes("自动保存了 trace")); i += 1) await new Promise((r) => setTimeout(r, 10));
    const log = m.e.activitySummaries().join("|");
    expect(log).toMatch(/自动保存了 trace browser-traces\/trace-\d{8}-\d{6}\.json/);
    noAbs(m.e, log);
    noAbs(m.e, JSON.stringify(m.e.session.activityLog.list()));
  });
});

describe.skipIf(process.platform === "win32")("R6-34 perf：INTERNAL 错误文案不含绝对路径", () => {
  const failing = (match: RegExp, fn: (p: string) => never) => {
    const real = fs as any;
    return {
      ...real,
      openSync: (p: any, ...rest: any[]) => {
        if (match.test(String(p))) return fn(String(p));
        return real.openSync(p, ...rest);
      },
    };
  };
  const expectClean = (e: P4Env, msg: string) => {
    noAbs(e, msg);
    expect(msg).not.toContain("browser-traces");
  };

  it("堆快照：创建 .tmp 时 ENOSPC（Node 原始 message 带 open '<绝对路径>'）→ 只有码 / 释义 / open / 文件名", async () => {
    const m = await mk({ fs: failing(/\.heap-/, (p) => { throw nodeErr("ENOSPC", "open", p, "no space left on device"); }) });
    const err = await m.perf({ action: "heap_snapshot" }).then(() => null, (x: any) => x);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("无法创建性能数据文件");
    expect(err.message).toContain("ENOSPC");
    expect(err.message).toContain("磁盘空间不足");
    expect(err.message).toMatch(/open \.heap-\d{8}-\d{6}\.[^ ]*\.tmp/);
    expectClean(m.e, err.message);
  });

  it("EACCES 同理", async () => {
    const m = await mk({ fs: failing(/\.heap-/, (p) => { throw nodeErr("EACCES", "open", p, "permission denied"); }) });
    const err = await m.perf({ action: "heap_snapshot" }).then(() => null, (x: any) => x);
    expect(err.message).toContain("EACCES");
    expect(err.message).toContain("没有权限");
    expectClean(m.e, err.message);
  });

  it("stop_trace 落盘失败（EDQUOT）：同样干净", async () => {
    const m = await mk({ fs: failing(/\.trace-/, (p) => { throw nodeErr("EDQUOT", "open", p, "disk quota exceeded"); }) });
    await m.perf({ action: "start_trace" });
    const err = await m.perf({ action: "stop_trace" }).then(() => null, (x: any) => x);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("EDQUOT");
    expectClean(m.e, err.message);
  });

  it("非 fs 错误（CDP 报错 message 里夹着 userData 路径）：路径被剔除", async () => {
    const m = await mk();
    m.e.cdp["Tracing.start"] = () => {
      throw new Error(`Tracing 启动失败，见 ${m.e.userData}/data/tasks/task-s5p/x.log 与 '/var/folders/zz/T/y.json'`);
    };
    const err = await m.perf({ action: "start_trace" }).then(() => null, (x: any) => x);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("无法开始性能录制");
    expect(err.message).toContain("x.log");
    expect(err.message).toContain("y.json");
    noAbs(m.e, err.message);
    expect(err.message).not.toContain("/var/folders");
  });
});

describe.skipIf(process.platform === "win32")("R6-34 perf：其余 errMsg 通道（Tracing.end / 堆写入 / 堆摘要 / 覆盖率）同样不带绝对路径", () => {
  type M = Awaited<ReturnType<typeof mk>>;
  /** CDP / 系统错误 message 里夹着 userData 绝对路径与一条系统临时目录路径 */
  const leaky = (m: M, what: string) => `${what}，见 ${m.e.userData}/data/tasks/task-s5p/x.log 与 '/var/folders/zz/T/y.json'`;
  const expectScrubbed = (m: M, s: string) => {
    noAbs(m.e, s);
    expect(s).not.toContain("/var/folders");
    expect(s).toContain("x.log");
  };
  const reject = (p: Promise<any>) => p.then(() => null, (x: any) => x);

  it("stop_trace 的 Tracing.end 失败：错误文案里的路径被剔除", async () => {
    const m = await mk();
    await m.perf({ action: "start_trace" });
    m.e.cdp["Tracing.end"] = () => {
      throw new Error(leaky(m, "Tracing.end 失败"));
    };
    const err = await reject(m.perf({ action: "stop_trace" }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("结束性能录制失败");
    expectScrubbed(m, err.message);
  });

  it("堆快照写入失败（writeSync 的 ENOSPC，带绝对路径）：只有码 / 释义 / 系统调用 / 文件名", async () => {
    const holder = { ud: "" };
    const m = await mk({
      fs: {
        ...(fs as any),
        writeSync: () => {
          throw nodeErr("ENOSPC", "write", `${holder.ud}/data/tasks/task-s5p/browser-traces/.heap-x.tmp`, "no space left on device");
        },
      },
    });
    holder.ud = m.e.userData;
    const err = await reject(m.perf({ action: "heap_snapshot" }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("写入堆快照失败");
    expect(err.message).toContain("ENOSPC");
    expect(err.message).toContain(".heap-x.tmp");
    noAbs(m.e, err.message);
    expect(err.message).not.toContain("browser-traces");
  });

  it("堆快照已保存但摘要解析失败（读文件 EACCES）：summaryNote 不含绝对路径", async () => {
    const real = fs as any;
    const m = await mk({
      fs: {
        ...real,
        promises: {
          ...real.promises,
          open: async (p: any, ...rest: any[]) => {
            if (/\.heapsnapshot$/.test(String(p))) throw nodeErr("EACCES", "open", String(p), "permission denied");
            return real.promises.open(p, ...rest);
          },
        },
      },
    });
    const r = await m.perf({ action: "heap_snapshot" });
    expect(r.summary).toBeNull();
    expect(r.summaryNote).toContain("摘要解析失败");
    expect(r.summaryNote).toContain("EACCES");
    expect(r.summaryNote).toMatch(/open heap-\d{8}-\d{6}\.heapsnapshot/);
    noAbs(m.e, JSON.stringify(r));
  });

  it("coverage_start 失败：错误文案里的路径被剔除", async () => {
    const m = await mk();
    m.e.cdp["Profiler.enable"] = () => {
      throw new Error(leaky(m, "Profiler 启动失败"));
    };
    const err = await reject(m.perf({ action: "coverage_start" }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("无法开始覆盖率统计");
    expectScrubbed(m, err.message);
  });

  it("coverage_stop：JS / CSS 两路都失败时，合并进错误文案的两段警告都不含路径", async () => {
    const m = await mk();
    await m.perf({ action: "coverage_start" });
    m.e.cdp["Profiler.takePreciseCoverage"] = () => {
      throw new Error(leaky(m, "JS 采集失败"));
    };
    m.e.cdp["CSS.stopRuleUsageTracking"] = () => {
      throw new Error(leaky(m, "CSS 采集失败"));
    };
    const err = await reject(m.perf({ action: "coverage_stop" }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("JS 覆盖率不可用");
    expect(err.message).toContain("CSS 覆盖率不可用");
    expectScrubbed(m, err.message);
  });

  it("coverage_stop：只有一路失败（JS）时，警告进 warnings 且不含路径", async () => {
    const m = await mk();
    await m.perf({ action: "coverage_start" });
    m.e.cdp["Profiler.takePreciseCoverage"] = () => {
      throw new Error(leaky(m, "JS 采集失败"));
    };
    m.e.cdp["CSS.stopRuleUsageTracking"] = () => ({ ruleUsage: [] });
    const r = await m.perf({ action: "coverage_stop" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("JS 覆盖率不可用");
    expectScrubbed(m, r.warnings[0]);
  });
});

describe.skipIf(process.platform === "win32")("R6-34 perf 端到端：userData 含空格、在家目录之下（macOS `Application Support` 形状）", () => {
  const dirs: string[] = [];
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const r of restores.splice(0)) r();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("heap_snapshot / stop_trace / 写盘失败 / CDP 错误：结果、活动日志、错误文案都不含 userData、家目录、空格路径片段", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "r6s5 home-"));
    dirs.push(home);
    const lib = path.join(home, "Library", "Application Support", "Flowship Dev");
    fs.mkdirSync(lib, { recursive: true });
    const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
    restores.push(() => spy.mockRestore());
    // makeP4Env 的 userData 建在 os.tmpdir() 之下：把 TMPDIR 指到 lib，userData 就是 `<home>/Library/Application Support/Flowship Dev/p4-net-xxxx`
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = lib;
    restores.push(() => {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    });

    let failOpen: RegExp | null = null;
    const real = fs as any;
    const wrapped = {
      ...real,
      openSync: (p: any, ...rest: any[]) => {
        if (failOpen?.test(String(p))) throw nodeErr("EACCES", "open", String(p), "permission denied");
        return real.openSync(p, ...rest);
      },
    };
    const m = await mk({ fs: wrapped });
    expect(m.e.userData).toContain("Application Support");
    expect(m.e.userData.startsWith(home)).toBe(true);
    const bad = [m.e.userData, home, path.basename(home), "Application Support", "Flowship Dev", "/Library/"];
    const clean = (what: string, s: string) => {
      for (const b of bad) expect(s, `${what} 不应含 ${b}`).not.toContain(b);
    };

    // 成功路径：结果（公开形状）+ 活动日志
    const heap = await m.perf({ action: "heap_snapshot" });
    clean("heap 结果", JSON.stringify(heap));
    await m.perf({ action: "start_trace" });
    const tr = await m.perf({ action: "stop_trace" });
    clean("trace 结果", JSON.stringify(tr));
    clean("活动日志", JSON.stringify(m.e.session.activityLog.list()));

    // 失败路径：写盘失败 / CDP 错误（message 里夹着家目录与 userData）
    failOpen = /\.heap-/;
    const e1 = await m.perf({ action: "heap_snapshot" }).then(() => null, (x: any) => x);
    expect(e1.message).toContain("EACCES");
    clean("写盘错误", e1.message);
    failOpen = null;
    m.e.cdp["Tracing.start"] = () => {
      throw new Error(`启动失败：${m.e.userData}/data/tasks/task-s5p/a.log、${home}/Documents/proj/b.log、'${home}/My Docs/c.log'`);
    };
    const e2 = await m.perf({ action: "start_trace" }).then(() => null, (x: any) => x);
    expect(e2.message).toContain("a.log");
    expect(e2.message).toContain("b.log");
    expect(e2.message).toContain("c.log");
    clean("CDP 错误", e2.message);
  });
});
