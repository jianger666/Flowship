/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * E2·P6 / B2：ops/perf.mjs 主进程 op——参数规整、trace 流式落盘（权限 / 上限 / 截断仍是合法 JSON / 摘要降级）、同会话互斥、
 * 60 秒自动结束、tab 关闭 / 会话销毁 / 取消时的收尾（不留半截文件）、堆快照（上限中止并删除 / 摘要）、metrics、coverage、接管期间 USER_CONTROL、活动日志。
 * 真实 BrowserSession + 假 tab（脚本化的 CDP 应答）；真 Electron 行为见 scripts/browser-e2e/e2-p6-perf.cjs。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { OP_MODULES } from "../electron-app/browser/ops/index.mjs";
import { PERF_ACTIONS, PERF_LIMITS, createCappedWriter, createHandlers, normalize, perfDirFor, prunePerfDir } from "../electron-app/browser/ops/perf.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";

const isWin = process.platform === "win32";
const T0 = 1_000_000;
const MAIN = "FRAME_MAIN";

const mkEvents = (n = 0) => {
  const ev = (o: Record<string, unknown>) => ({ pid: 10, tid: 1, ph: "X", cat: "devtools.timeline", ts: T0, ...o });
  return [
    ev({ name: "TracingStartedInBrowser", ph: "I", args: { data: { frames: [{ frame: MAIN, processId: 10, isInPrimaryMainFrame: true }] } } }),
    ev({ name: "navigationStart", ph: "R", args: { frame: MAIN, data: { isLoadingMainFrame: true } } }),
    ev({ name: "firstContentfulPaint", ph: "R", ts: T0 + 200_000, args: { frame: MAIN } }),
    ev({ name: "largestContentfulPaint::Candidate", ph: "R", ts: T0 + 900_000, args: { frame: MAIN, data: { size: 5, type: "text", nodeName: "P" } } }),
    ev({ name: "RunTask", ts: T0 + 100_000, dur: 90_000 }),
    { name: "thread_name", ph: "M", pid: 10, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
    ...Array.from({ length: n }, (_, i) => ev({ name: "Layout", ts: T0 + 1_000_000 + i, dur: 10, args: { pad: "x".repeat(40) } })),
  ];
};
const traceJson = (events: unknown[]) => `{"traceEvents":[\n${events.map((e) => JSON.stringify(e)).join(",\n")}\n],"metadata":{"a":1}}`;

class FakePerfTab {
  ready = Promise.resolve();
  opener: string | null = null;
  title = "示例页";
  pendingDialog: any = null;
  hadRecentGesture = vi.fn(() => true);
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => "data:image/jpeg;base64,FAKE");
  ensureCdp = vi.fn(async () => {});
  listeners = new Set<(m: string, p: any, sid?: string | null) => void>();
  destroyHooks = new Set<() => void>();
  destroyed = false;
  calls: Array<{ method: string; params: any }> = [];
  handlers: Record<string, (p: any) => any> = {};
  constructor(
    public id: string,
    public url: string,
  ) {}
  send = vi.fn(async (method: string, params: any = {}) => {
    this.calls.push({ method, params });
    if (this.destroyed) throw Object.assign(new Error("标签页已关闭"), { code: "TAB_NOT_FOUND" });
    const h = this.handlers[method];
    return h ? await h(params) : {};
  });
  emit(method: string, params: any) {
    for (const l of [...this.listeners]) l(method, params, null);
  }
  onCdpEvent(fn: any) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  addDestroyHook(fn: () => void) {
    this.destroyHooks.add(fn);
    return () => this.destroyHooks.delete(fn);
  }
  destroy = vi.fn(() => {
    this.destroyed = true;
    for (const h of [...this.destroyHooks]) h();
  });
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
  methods = () => this.calls.map((c) => c.method);
  /** 脚本化 trace：Tracing.end 之后推 tracingComplete，IO.read 按 chunkSize 吐 text */
  scriptTrace(text: string, chunkSize = 64 * 1024) {
    let pos = 0;
    this.handlers["Tracing.start"] = () => ({});
    this.handlers["Tracing.end"] = () => {
      queueMicrotask(() => this.emit("Tracing.tracingComplete", { stream: "S1", dataLossOccurred: false }));
      return {};
    };
    this.handlers["IO.read"] = () => {
      const chunk = text.slice(pos, pos + chunkSize);
      pos += chunkSize;
      return { data: chunk, eof: pos >= text.length, base64Encoded: false };
    };
    this.handlers["IO.close"] = () => ({});
  }
}

interface Env {
  userData: string;
  session: any;
  tab: FakePerfTab;
  call: (args: Record<string, unknown>) => Promise<any>;
  dir: string;
  files: () => string[];
  cleanup: () => void;
  isAppUrl: (u: string) => boolean;
  activity: () => string[];
}
const envs: Env[] = [];

const mk = async (limits: Partial<typeof PERF_LIMITS> = {}): Promise<Env> => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "p6-perf-"));
  const activityLog = createActivityLog();
  let tab!: FakePerfTab;
  const host: any = {
    createTab: ({ id }: { id: string }) => (tab = new FakePerfTab(id, "http://127.0.0.1:1/page")),
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
    // R6-02：heap_snapshot 要过 evaluate 审批；这里的既有用例测的是落盘 / 摘要逻辑，所以让总闸开着（免审批）。审批语义见 browser-r6-s1-perf-heap.test.ts
    isEvaluateEnabled: () => true,
  };
  const taskId = "task1";
  const session = new BrowserSession({ taskId, host, activityLog, graceMs: 8_000, now: () => 1_000 });
  await session.openTab({});
  const isAppUrl = (u: string) => u.includes("flowship.app.test");
  const handlers = createHandlers({
    requireSession: () => session,
    getConfig: () => ({}),
    abortable: (p: Promise<unknown>) => p,
    scheduleState: vi.fn(),
    app: { getPath: () => userData },
    electron: { isAppUrl },
    log: () => {},
    perfLimits: limits,
  } as any);
  const call = async (args: Record<string, unknown>) => (handlers as any).perf(taskId, normalize("perf", args, OP_HELPERS as any));
  const dir = perfDirFor(userData, taskId)!;
  const env: Env = {
    userData,
    session,
    tab,
    call,
    dir,
    files: () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true }),
    isAppUrl,
    activity: () => (session.getState().recent as Array<{ actor: string; summary?: string }>).filter((e) => e.actor === "ai").map((e) => e.summary ?? ""),
  };
  envs.push(env);
  return env;
};
afterEach(() => {
  vi.useRealTimers();
  for (const e of envs.splice(0)) {
    try {
      e.session.destroy();
    } catch {
      /* 已销毁 */
    }
    e.cleanup();
  }
});

const rej = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

// ───────────────────────── 注册 / 参数 ─────────────────────────

describe("P6·注册与参数规整", () => {
  it("perf op 由 perf 模块独占（OPS 互不相交）", () => {
    const owners = OP_MODULES.filter((m: any) => m.OPS.includes("perf"));
    expect(owners).toHaveLength(1);
  });

  it("action 必填且只认枚举；preset 只认预设名（不接受任意类别串）", () => {
    const n = (a: any) => normalize("perf", a, OP_HELPERS as any) as any;
    expect(() => n({})).toThrow(/action/);
    expect(() => n({ action: "hack" })).toThrow(/action/);
    expect(() => n({ action: "start_trace", preset: "devtools.timeline,disabled-by-default-*" })).toThrow(/preset/);
    expect(() => n({ action: "start_trace", categories: "*" })).toThrow(/categories/);
    expect(n({ action: "start_trace" })).toEqual({ action: "start_trace", preset: "default" });
    expect(n({ action: "start_trace", preset: "loading", tabId: "t2" })).toEqual({ action: "start_trace", preset: "loading", tabId: "t2" });
    for (const a of PERF_ACTIONS) expect(() => n({ action: a })).not.toThrow();
  });

  it("topN 夹到 1–30；js / css 不能同时关；非布尔 / 非数字报错", () => {
    const n = (a: any) => normalize("perf", a, OP_HELPERS as any) as any;
    expect(n({ action: "heap_snapshot", topN: 999 }).topN).toBe(30);
    expect(n({ action: "heap_snapshot", topN: -5 }).topN).toBe(1);
    expect(n({ action: "coverage_stop", topN: 3 }).topN).toBe(3);
    expect(() => n({ action: "coverage_start", js: false, css: false })).toThrow(/不能同时关闭/);
    expect(() => n({ action: "coverage_start", js: "yes" })).toThrow(/布尔/);
    expect(() => n({ action: "heap_snapshot", topN: "many" })).toThrow(/数字/);
    expect(n({ action: "coverage_start" })).toMatchObject({ js: true, css: true });
  });
});

// ───────────────────────── trace ─────────────────────────

describe("P6·start_trace / stop_trace", () => {
  it("完整流程：Tracing.start 用 ReturnAsStream + 预设类别；stop 流式落盘（目录 0700 / 文件 0600）、文件是合法 trace JSON、摘要有 LCP", async () => {
    const e = await mk();
    e.tab.scriptTrace(traceJson(mkEvents(50)), 200); // 小 chunk：多轮 IO.read
    const start = await e.call({ action: "start_trace", preset: "loading" });
    expect(start).toMatchObject({ action: "start_trace", preset: "loading", maxSeconds: 60, maxMB: 200 });
    const startCall = e.tab.calls.find((c) => c.method === "Tracing.start")!;
    expect(startCall.params.transferMode).toBe("ReturnAsStream");
    expect(startCall.params.traceConfig.includedCategories).toContain("devtools.timeline");
    expect(e.files()).toEqual([]); // 录制中磁盘上没有任何东西

    const stop = await e.call({ action: "stop_trace" });
    expect(stop).toMatchObject({ action: "stop_trace", truncated: false, summaryDegraded: false, tabId: "t1" });
    expect(stop.summary.metrics.lcpMs).toBe(900);
    expect(stop.summary.metrics.fcpMs).toBe(200);
    expect(stop.summary.longTasks.count).toBe(1);
    expect(stop.file).toMatch(/^trace-\d{8}-\d{6}\.json$/);
    // R6-02：结果体不含绝对路径，只有文件名 + 子目录名；文件实际落在任务目录里
    expect(stop.path).toBeUndefined();
    expect(stop.dir).toBe("browser-traces");
    const stopPath = path.join(e.dir, stop.file);
    expect(e.files()).toEqual([stop.file]); // 没有 .tmp 残留
    const parsed = JSON.parse(fs.readFileSync(stopPath, "utf8"));
    expect(parsed.traceEvents.length).toBe(mkEvents(50).length);
    expect(stop.bytes).toBe(fs.statSync(stopPath).size);
    if (!isWin) {
      expect(fs.statSync(stopPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(e.dir).mode & 0o777).toBe(0o700);
    }
    expect(e.tab.methods()).toContain("IO.close");
    expect(e.activity().join("|")).toMatch(/开始了性能录制/);
    expect(e.activity().join("|")).toMatch(/结束了性能录制/);
  });

  it("同会话同时只允许一个 trace：再 start 给明确错误；stop 之后可以重新开始", async () => {
    const e = await mk();
    e.tab.scriptTrace(traceJson(mkEvents()));
    await e.call({ action: "start_trace" });
    await rej(e.call({ action: "start_trace" }), "BAD_ARGS");
    await expect(e.call({ action: "start_trace" })).rejects.toThrow(/stop_trace/);
    await e.call({ action: "stop_trace" });
    e.tab.scriptTrace(traceJson(mkEvents())); // 重置流位置
    await expect(e.call({ action: "start_trace" })).resolves.toMatchObject({ action: "start_trace" });
  });

  it("没有 trace 时 stop_trace → BAD_ARGS（模型能自修复的文案）", async () => {
    const e = await mk();
    await rej(e.call({ action: "stop_trace" }), "BAD_ARGS");
    await expect(e.call({ action: "stop_trace" })).rejects.toThrow(/start_trace/);
  });

  it("Tracing.start 失败：不留 trace 状态、给 INTERNAL，可以重新 start", async () => {
    const e = await mk();
    e.tab.handlers["Tracing.start"] = () => {
      throw new Error("Tracing 域不可用");
    };
    await rej(e.call({ action: "start_trace" }), "INTERNAL");
    expect(e.tab.listeners.size).toBe(0); // 事件监听已摘掉
    e.tab.scriptTrace(traceJson(mkEvents()));
    await expect(e.call({ action: "start_trace" })).resolves.toBeTruthy();
  });

  it("大小上限：超限在最后一个完整事件处截断并补 ]}，文件仍是合法 JSON，truncated=true", async () => {
    const e = await mk({ traceMaxBytes: 3000, readChunk: 1000 });
    e.tab.scriptTrace(traceJson(mkEvents(400)), 700);
    await e.call({ action: "start_trace" });
    const stop = await e.call({ action: "stop_trace" });
    expect(stop.truncated).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(e.dir, stop.file), "utf8")); // 合法 JSON
    expect(Array.isArray(parsed.traceEvents)).toBe(true);
    expect(parsed.traceEvents.length).toBeGreaterThan(5);
    expect(parsed.traceEvents.length).toBeLessThan(mkEvents(400).length);
    expect(stop.bytes).toBeLessThan(5000); // 只超出至多一个 chunk
    expect(e.tab.methods()).toContain("IO.close"); // 超限即停止读取并关流
    expect(e.files()).toEqual([stop.file]);
  });

  it("摘要上限：超过摘要上限只存文件、摘要降级为 null 并注明", async () => {
    const e = await mk({ heapSummaryMaxBytes: 500 });
    e.tab.scriptTrace(traceJson(mkEvents(100)), 400);
    await e.call({ action: "start_trace" });
    const stop = await e.call({ action: "stop_trace" });
    expect(stop.summary).toBeNull();
    expect(stop.summaryDegraded).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(e.dir, stop.file), "utf8")).traceEvents.length).toBe(mkEvents(100).length);
  });

  it("时长上限：到点自动 stop 并落盘，下一次 stop_trace 取走结果（auto=true，只能取一次）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const e = await mk({ traceMaxMs: 60_000 });
    e.tab.scriptTrace(traceJson(mkEvents()));
    await e.call({ action: "start_trace" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(e.files()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(e.files().length).toBe(1));
    const got = await e.call({ action: "stop_trace" });
    expect(got).toMatchObject({ action: "stop_trace", auto: true, truncated: false });
    expect(got.summary.metrics.lcpMs).toBe(900);
    await rej(e.call({ action: "stop_trace" }), "BAD_ARGS"); // 结果已被取走
    expect(e.activity().join("|")).toMatch(/自动结束/);
  });

  it("自动 stop 失败（流读取出错）：错误留给下一次 stop_trace，且不留文件", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const e = await mk({ traceMaxMs: 1000 });
    e.tab.scriptTrace(traceJson(mkEvents()));
    e.tab.handlers["IO.read"] = () => {
      throw new Error("流已失效");
    };
    await e.call({ action: "start_trace" });
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(e.tab.methods()).toContain("IO.close"));
    await rej(e.call({ action: "stop_trace" }), "INTERNAL").catch(() => {});
    expect(e.files()).toEqual([]);
  });

  it("tab 关闭 → trace 收尾（监听摘掉、状态清空），之后 stop_trace 报「没有进行中」，没有任何文件", async () => {
    const e = await mk();
    e.tab.scriptTrace(traceJson(mkEvents()));
    await e.call({ action: "start_trace" });
    expect(e.tab.listeners.size).toBe(1);
    e.tab.destroy();
    expect(e.tab.listeners.size).toBe(0);
    await rej(e.call({ action: "stop_trace" }), "BAD_ARGS");
    expect(e.files()).toEqual([]);
  });

  it("会话销毁 → trace 收尾；销毁在读流中途发生：取消、删 tmp、不留半截文件", async () => {
    const e = await mk();
    const text = traceJson(mkEvents(300));
    e.tab.scriptTrace(text, 500);
    let reads = 0;
    const baseRead = e.tab.handlers["IO.read"];
    e.tab.handlers["IO.read"] = (p) => {
      reads += 1;
      if (reads === 3) e.session.destroy(); // 读到第 3 块时会话被销毁
      return baseRead(p);
    };
    await e.call({ action: "start_trace" });
    await expect(e.call({ action: "stop_trace" })).rejects.toBeTruthy();
    expect(e.files()).toEqual([]); // tmp 也被清掉
    expect(reads).toBeLessThan(10); // 销毁后读取循环尽快停手
  });

  it("会话销毁时 trace 还没 stop：dispose 摘监听 + 尽力 Tracing.end，不留文件", async () => {
    const e = await mk();
    e.tab.scriptTrace(traceJson(mkEvents()));
    await e.call({ action: "start_trace" });
    e.session.destroy();
    expect(e.tab.listeners.size).toBe(0);
    expect(e.files()).toEqual([]);
  });

  it("用户接管期间 AI 的任何 perf 动作 → USER_CONTROL，什么都没发生", async () => {
    const e = await mk();
    e.session.controller = "user";
    for (const action of PERF_ACTIONS) await rej(e.call({ action }), "USER_CONTROL");
    expect(e.tab.methods()).toEqual([]);
    expect(e.files()).toEqual([]);
  });

  it("摘要里的 Flowship 自身 URL 不出现、URL 里的密钥被脱敏（trace 是浏览器范围的）", async () => {
    const e = await mk();
    const ev = (o: Record<string, unknown>) => ({ pid: 10, tid: 1, ph: "I", cat: "devtools.timeline", ts: T0, ...o });
    const events = [
      ...mkEvents(),
      ev({ name: "ResourceSendRequest", ts: T0 + 10, args: { data: { requestId: "a", url: "http://flowship.app.test/api/x" } } }),
      ev({ name: "ResourceFinish", ts: T0 + 500_000, args: { data: { requestId: "a" } } }),
      ev({ name: "ResourceSendRequest", ts: T0 + 10, args: { data: { requestId: "b", url: "http://127.0.0.1:1/a.js?access_token=ABCDEFG1234567" } } }),
      ev({ name: "ResourceFinish", ts: T0 + 400_000, args: { data: { requestId: "b" } } }),
    ];
    e.tab.scriptTrace(traceJson(events));
    await e.call({ action: "start_trace" });
    const stop = await e.call({ action: "stop_trace" });
    const dump = JSON.stringify(stop.summary);
    expect(dump).not.toContain("flowship.app.test");
    expect(dump).not.toContain("ABCDEFG1234567");
    expect(dump).toContain("a.js");
  });
});

// ───────────────────────── 写入器 / 清理 ─────────────────────────

describe("P6·落盘辅助：路径 / 权限 / 清理", () => {
  it("perfDirFor：taskId 不安全 / userData 缺失 → null，绝不拼路径", () => {
    expect(perfDirFor("/ud", "task1")).toBe(path.join("/ud", "data", "tasks", "task1", "browser-traces"));
    for (const bad of ["../x", "a/b", "", "a b", "..", "x\0y"]) expect(perfDirFor("/ud", bad)).toBeNull();
    expect(perfDirFor("", "t")).toBeNull();
    expect(perfDirFor(undefined as any, "t")).toBeNull();
  });

  it("createCappedWriter：commit 前只有 .tmp（0600）；abort 后什么都不留；truncate 后继续写不错位；重名加后缀", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p6-w-"));
    try {
      const sub = path.join(dir, "browser-traces");
      const w = createCappedWriter({ dir: sub, prefix: "trace", ext: ".json", now: new Date(2026, 10, 9, 10, 0, 0) });
      w.write("0123456789");
      expect(fs.readdirSync(sub).every((n) => n.startsWith(".") && n.endsWith(".tmp"))).toBe(true);
      if (!isWin) expect(fs.statSync(path.join(sub, fs.readdirSync(sub)[0])).mode & 0o777).toBe(0o600);
      w.truncate(4);
      w.write("ab");
      const saved = w.commit();
      expect(saved.file).toBe("trace-20261109-100000.json");
      expect(fs.readFileSync(saved.path, "utf8")).toBe("0123ab");
      const w2 = createCappedWriter({ dir: sub, prefix: "trace", ext: ".json", now: new Date(2026, 10, 9, 10, 0, 0) });
      w2.write("x");
      expect(w2.commit().file).toBe("trace-20261109-100000-2.json");
      const w3 = createCappedWriter({ dir: sub, prefix: "heap", ext: ".heapsnapshot" });
      w3.write("zzz");
      w3.abort();
      expect(fs.readdirSync(sub).filter((n) => n.startsWith("heap") || n.endsWith(".tmp"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunePerfDir：只留最近 N 个且不超龄；不动 .tmp 与无关文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p6-p-"));
    try {
      const now = Date.now();
      const put = (n: string, ageMs: number) => {
        const p = path.join(dir, n);
        fs.writeFileSync(p, "x");
        fs.utimesSync(p, new Date(now - ageMs), new Date(now - ageMs));
      };
      for (let i = 0; i < 5; i += 1) put(`trace-${i}.json`, i * 1000);
      put("heap-old.heapsnapshot", 10 * 24 * 3600 * 1000);
      put(".trace-x.tmp", 99 * 24 * 3600 * 1000);
      put("notes.txt", 99 * 24 * 3600 * 1000);
      const removed = prunePerfDir({ dir, now, keep: 3, maxAgeMs: 3 * 24 * 3600 * 1000 });
      expect(removed).toBe(3); // 超出 keep 的 2 个 + 超龄的 1 个
      expect(fs.readdirSync(dir).sort()).toEqual([".trace-x.tmp", "notes.txt", "trace-0.json", "trace-1.json", "trace-2.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── metrics ─────────────────────────

describe("P6·metrics", () => {
  it("Performance.enable → getMetrics → 人话化；计数类指标第二次调用才有；会话销毁时关掉 Performance 域", async () => {
    const e = await mk();
    e.tab.handlers["Performance.getMetrics"] = () => ({
      metrics: [
        { name: "JSHeapUsedSize", value: 5 * 1048576 },
        { name: "Nodes", value: 321 },
        { name: "LayoutCount", value: 4 },
        { name: "ScriptDuration", value: 0.05 },
      ],
    });
    // 第一次：只有绝对值（堆 / DOM），计数类指标（自 enable 起累计，此刻必为 0 没有意义）不返回
    const r1 = await e.call({ action: "metrics" });
    expect(r1).toMatchObject({ action: "metrics", tabId: "t1", first: true, metrics: { jsHeapUsedMB: 5, domNodes: 321 } });
    expect(r1.metrics.layoutCount).toBeUndefined();
    expect(r1.metrics.scriptDurationMs).toBeUndefined();
    expect(e.tab.methods().slice(0, 2)).toEqual(["Performance.enable", "Performance.getMetrics"]);
    // 第二次：域保持开启，计数类指标是两次调用之间的值
    const r2 = await e.call({ action: "metrics" });
    expect(r2).toMatchObject({ first: false, metrics: { layoutCount: 4, scriptDurationMs: 50 } });
    expect(e.tab.methods()).not.toContain("Performance.disable");
    // 会话销毁 → 尽力关掉 Performance 域
    e.session.destroy();
    await vi.waitFor(() => expect(e.tab.methods()).toContain("Performance.disable"));
  });

  it("tab 不存在 → TAB_NOT_FOUND", async () => {
    const e = await mk();
    await rej(e.call({ action: "metrics", tabId: "t99" }), "TAB_NOT_FOUND");
  });
});

// ───────────────────────── heap snapshot ─────────────────────────

const heapSnapshotChunks = () => {
  const snap = {
    snapshot: { meta: { node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"], node_types: [["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"]] } },
  };
  const nodes = [3, 1, 1, 100, 0, 0, 0, 3, 1, 3, 150, 0, 0, 0, 3, 2, 5, 40, 0, 0, 0, 2, 3, 7, 70, 0, 0, 0];
  const text = `${JSON.stringify(snap).slice(0, -1)},"nodes":[${nodes.join(",")}],"edges":[],"strings":["","Foo","Bar","str"]}`;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 37) out.push(text.slice(i, i + 37));
  return out;
};

describe("P6·heap_snapshot", () => {
  it("chunk 事件流式写文件（0600）、构造函数 Top N；takeHeapSnapshot 用 reportProgress:false；gc 可选", async () => {
    const e = await mk();
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      for (const chunk of heapSnapshotChunks()) e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
      return {};
    };
    const r = await e.call({ action: "heap_snapshot", topN: 2, gc: true });
    expect(r.file).toMatch(/^heap-\d{8}-\d{6}\.heapsnapshot$/);
    expect(r.summary.top.map((t: any) => [t.name, t.selfSize])).toEqual([
      ["Foo", 250],
      ["(string)", 70],
    ]);
    expect(r.summary.nodeCount).toBe(4);
    expect(r.path).toBeUndefined(); // R6-02：不回显绝对路径
    expect(JSON.parse(fs.readFileSync(path.join(e.dir, r.file), "utf8")).snapshot.meta.node_fields).toHaveLength(7); // 文件本身是完整 JSON
    expect(e.tab.calls.find((c) => c.method === "HeapProfiler.takeHeapSnapshot")!.params).toEqual({ reportProgress: false });
    expect(e.tab.methods()).toContain("HeapProfiler.collectGarbage");
    expect(e.files()).toEqual([r.file]);
    if (!isWin) expect(fs.statSync(path.join(e.dir, r.file)).mode & 0o777).toBe(0o600);
    expect(e.tab.listeners.size).toBe(0);
    expect(e.activity().join("|")).toMatch(/保存了页面堆快照/);
  });

  it("大小上限：超限中止并删除半截文件，错误文案能自修复", async () => {
    const e = await mk({ heapMaxBytes: 100 });
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      for (const chunk of heapSnapshotChunks()) e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
      return {};
    };
    await expect(e.call({ action: "heap_snapshot" })).rejects.toThrow(/上限.*删除/);
    expect(e.files()).toEqual([]);
    expect(e.tab.listeners.size).toBe(0);
    // 失败后不卡死：可以再来
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => ({});
    await expect(e.call({ action: "heap_snapshot" })).resolves.toBeTruthy();
  });

  it("摘要上限：超过只存文件，summary=null + summaryNote", async () => {
    const e = await mk({ heapSummaryMaxBytes: 50 });
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      for (const chunk of heapSnapshotChunks()) e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
      return {};
    };
    const r = await e.call({ action: "heap_snapshot" });
    expect(r.summary).toBeNull();
    expect(r.summaryNote).toMatch(/只保存了文件/);
    expect(fs.existsSync(path.join(e.dir, r.file))).toBe(true);
  });

  it("takeHeapSnapshot 失败：不留文件", async () => {
    const e = await mk();
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: '{"snap' });
      throw new Error("堆太大");
    };
    await expect(e.call({ action: "heap_snapshot" })).rejects.toThrow(/堆太大/);
    expect(e.files()).toEqual([]);
  });

  it("快照内容不是合法格式：文件照存，摘要失败原因写进 summaryNote（不抛）", async () => {
    const e = await mk();
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: "not a snapshot" });
      return {};
    };
    const r = await e.call({ action: "heap_snapshot" });
    expect(r.summary).toBeNull();
    expect(r.summaryNote).toMatch(/摘要解析失败/);
  });

  it("恶意 chunk（非字符串 / 缺字段）被忽略，不崩", async () => {
    const e = await mk();
    e.tab.handlers["HeapProfiler.takeHeapSnapshot"] = () => {
      e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: 123 });
      e.tab.emit("HeapProfiler.addHeapSnapshotChunk", undefined);
      for (const chunk of heapSnapshotChunks()) e.tab.emit("HeapProfiler.addHeapSnapshotChunk", { chunk });
      return {};
    };
    await expect(e.call({ action: "heap_snapshot" })).resolves.toMatchObject({ summary: { nodeCount: 4 } });
  });
});

// ───────────────────────── coverage ─────────────────────────

describe("P6·coverage_start / coverage_stop", () => {
  const jsResult = {
    result: [
      { scriptId: "1", url: "http://127.0.0.1:1/app.js", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 1000, count: 1 }] }, { functionName: "dead", ranges: [{ startOffset: 500, endOffset: 1000, count: 0 }] }] },
      { scriptId: "2", url: "http://flowship.app.test/ui.js", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 500, count: 0 }] }] },
    ],
  };

  it("start：JS（callCount:false / detailed:false）+ CSS 开关；stop 汇总已用 / 总字节，排除 Flowship 脚本，并关闭追踪", async () => {
    const e = await mk();
    e.tab.handlers["Profiler.takePreciseCoverage"] = () => jsResult;
    e.tab.handlers["CSS.enable"] = () => {
      e.tab.emit("CSS.styleSheetAdded", { header: { styleSheetId: "s1", sourceURL: "http://127.0.0.1:1/site.css?v=1&token=ZZZZZZZZZZ123456", length: 400 } });
      return {};
    };
    e.tab.handlers["CSS.stopRuleUsageTracking"] = () => ({ ruleUsage: [{ styleSheetId: "s1", startOffset: 0, endOffset: 100, used: true }] });
    await expect(e.call({ action: "coverage_start" })).resolves.toMatchObject({ js: true, css: true });
    expect(e.tab.calls.find((c) => c.method === "Profiler.startPreciseCoverage")!.params).toEqual({ callCount: false, detailed: false });
    expect(e.tab.methods()).toEqual(expect.arrayContaining(["DOM.enable", "CSS.enable", "CSS.startRuleUsageTracking"]));

    const r = await e.call({ action: "coverage_stop", topN: 5 });
    expect(r.js).toMatchObject({ total: 1000, used: 500, unused: 500, usedPercent: 50, files: 1 });
    expect(r.css).toMatchObject({ total: 400, used: 100, usedPercent: 25 });
    expect(JSON.stringify(r)).not.toContain("flowship.app.test");
    expect(JSON.stringify(r)).not.toContain("ZZZZZZZZZZ123456"); // URL 里的密钥被脱敏
    await vi.waitFor(() => expect(e.tab.methods()).toEqual(expect.arrayContaining(["Profiler.stopPreciseCoverage", "Profiler.disable"])));
    expect(e.tab.listeners.size).toBe(0);
    await rej(e.call({ action: "coverage_stop" }), "BAD_ARGS"); // 已结束
  });

  it("只开 js 或只开 css；重复 start → BAD_ARGS", async () => {
    const e = await mk();
    await e.call({ action: "coverage_start", css: false });
    expect(e.tab.methods()).not.toContain("CSS.enable");
    await rej(e.call({ action: "coverage_start" }), "BAD_ARGS");
    e.tab.handlers["Profiler.takePreciseCoverage"] = () => jsResult;
    const r = await e.call({ action: "coverage_stop" });
    expect(r.js).toBeTruthy();
    expect(r.css).toBeUndefined();
  });

  it("start 中途失败：回滚（stop 已开的追踪），不留 coverage 状态", async () => {
    const e = await mk();
    e.tab.handlers["CSS.startRuleUsageTracking"] = () => {
      throw new Error("CSS 域不可用");
    };
    await rej(e.call({ action: "coverage_start" }), "INTERNAL");
    await vi.waitFor(() => expect(e.tab.methods()).toContain("Profiler.stopPreciseCoverage"));
    await rej(e.call({ action: "coverage_stop" }), "BAD_ARGS");
  });

  it("tab 关闭 / 会话销毁：自动收尾（尽力 stop，摘监听），之后 coverage_stop 报没有进行中", async () => {
    const e = await mk();
    await e.call({ action: "coverage_start" });
    expect(e.tab.listeners.size).toBe(1);
    e.session.destroy(); // 会话销毁先 dispose 再销毁 tab
    expect(e.tab.listeners.size).toBe(0);
    expect(e.tab.methods()).toEqual(expect.arrayContaining(["Profiler.stopPreciseCoverage", "CSS.stopRuleUsageTracking"]));

    const e2 = await mk();
    await e2.call({ action: "coverage_start" });
    e2.tab.destroy();
    expect(e2.tab.listeners.size).toBe(0);
    await rej(e2.call({ action: "coverage_stop" }), "BAD_ARGS");
  });

  it("takePreciseCoverage 失败（如跨站导航换了渲染进程）：给能自修复的提示，覆盖率状态仍被清掉", async () => {
    const e = await mk();
    await e.call({ action: "coverage_start", css: false });
    e.tab.handlers["Profiler.takePreciseCoverage"] = () => {
      throw new Error("Precise coverage has not been started.");
    };
    await expect(e.call({ action: "coverage_stop" })).rejects.toThrow(/覆盖率不可用|没有产出/);
    await rej(e.call({ action: "coverage_stop" }), "BAD_ARGS");
  });
});
